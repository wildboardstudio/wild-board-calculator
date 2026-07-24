const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MOCK_PORT = 8901;
const STATIC_PORT = 8900;
const BROWSER_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if(cond) { pass++; console.log('  PASS: ' + msg); }
  else { fail++; console.log('  FAIL: ' + msg); }
}

(async () => {
  const mockProc = spawn('node', [path.join(__dirname, 'mock-supabase.js'), String(MOCK_PORT)], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    mockProc.stdout.on('data', d => { if(d.toString().includes('listening')) resolve(); });
    mockProc.on('error', reject);
    setTimeout(() => reject(new Error('mock startup timeout')), 5000);
  });

  const srcHtml = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const testHtml = srcHtml
    .replace(/https:\/\/hmywfzcjsatzpuciqmge\.supabase\.co/g, 'http://127.0.0.1:' + MOCK_PORT)
    .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/g, 'http://127.0.0.1:' + STATIC_PORT + '/supabase.umd.js')
    .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/2\.5\.1\/jspdf\.umd\.min\.js/g, 'http://127.0.0.1:' + STATIC_PORT + '/jspdf.umd.min.js');

  const staticServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if(url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(testHtml); return;
    }
    const filePath = path.join(__dirname, url.pathname);
    if(fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const ct = ext === '.js' ? 'application/javascript' : 'application/json';
      res.writeHead(200, { 'Content-Type': ct }); res.end(fs.readFileSync(filePath)); return;
    }
    if(['/favicon.png','/apple-touch-icon.png','/manifest.json','/logo-header.png','/logo-pdf.png',
        '/logo-landing.png','/wbc-beta.png','/splinter.jpg','/sw.js'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('dummy'); return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => staticServer.listen(STATIC_PORT, r));

  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true, args: ['--no-sandbox'] });

  function postMock(mockPath, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port: MOCK_PORT, path: mockPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject); req.write(data); req.end();
    });
  }

  async function resetMock() {
    await postMock('/_test/reset', {});
  }

  async function freshPage() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.clear(); });
    page.on('console', msg => {
      if(msg.type() === 'error' && !msg.text().includes('ERR_BLOCKED_BY_CLIENT') && !msg.text().includes('favicon'))
        console.log('[ERR]', msg.text());
    });
    await page.goto('http://127.0.0.1:' + STATIC_PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    return page;
  }

  async function signUp(page, email, password, username, companyName) {
    await page.waitForFunction(() => !window._currentUser && typeof _currentUser !== 'undefined' && _currentUser === null, { timeout: 5000 }).catch(() => {});
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });
    const toggleBtn = await page.$('#auth-toggle-btn');
    if(toggleBtn) {
      const txt = await toggleBtn.innerText();
      if(txt.includes('Sign up')) await toggleBtn.click();
    }
    await page.waitForTimeout(100);
    await page.fill('#auth-email', email);
    await page.fill('#auth-password', password);
    if(username) await page.fill('#auth-username', username);
    if(companyName) await page.fill('#auth-company', companyName);
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => {
      return typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email;
    }, { timeout: 5000 });
    await page.waitForTimeout(300);
  }

  async function startNewQuote(page) {
    await page.evaluate(() => showQuotes());
    await page.waitForSelector('#quotes-screen', { state: 'visible', timeout: 3000 });
    await page.waitForTimeout(300);
    await page.click('#quotes-add-btn');
    await page.waitForSelector('#quote-edit-screen', { state: 'visible', timeout: 3000 });
    await page.waitForTimeout(200);
  }

  async function fillDimensions(page, length, width) {
    await page.fill('#qe-dim-l', String(length));
    await page.fill('#qe-dim-w', String(width));
    await page.waitForTimeout(300);
  }

  async function getSaInfo(page) {
    return await page.textContent('#qe-sa-info');
  }

  async function getBasePrice(page) {
    const info = await getSaInfo(page);
    const match = info.match(/Base price: \$([\d.]+)/);
    return match ? parseFloat(match[1]) : 0;
  }

  async function navigateToSATierSettings(page) {
    await page.evaluate(() => showSettings());
    await page.waitForSelector('#settings-screen', { state: 'visible', timeout: 3000 });
    await page.waitForTimeout(200);
    await page.click('[data-settings-idx="1"]');
    await page.waitForTimeout(200);
    await page.click('[data-pricing-sub="11"]');
    await page.waitForTimeout(200);
  }

  async function saveSettingsAndGoBack(page) {
    await page.click('#settings-sub-save-btn');
    await page.waitForTimeout(500);
    // Save from idx 11 goes back to pricing defaults (idx 1) sub-screen
    // Click sub-back to go to settings main
    await page.click('#settings-sub-back-btn');
    await page.waitForTimeout(200);
    // Click settings back to go to app
    await page.click('#settings-back-btn');
    await page.waitForTimeout(200);
  }

  try {
    console.log('\n=== Surface Area Pricing Tests ===\n');

    // Test 1: 25x18 -> 450 sq in -> Tier 2 -> $405.00
    {
      console.log('Test 1: 25x18 -> surface area 450 sq in -> Tier 2 -> base price $405.00');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa1@test.com', 'password123', 'tester1', 'TestCo');
      await startNewQuote(page);
      await fillDimensions(page, 25, 18);
      const info = await getSaInfo(page);
      ok(info.includes('450 sq in'), 'T1: shows 450 sq in');
      ok(info.includes('Tier 2'), 'T1: shows Tier 2');
      const bp = await getBasePrice(page);
      ok(Math.abs(bp - 405.00) < 0.01, 'T1: base price $405.00 (got $' + bp.toFixed(2) + ')');
      await page.context().close();
    }

    // Test 2: 12x12 -> 144 sq in -> Tier 1 -> $115.20
    {
      console.log('Test 2: 12x12 -> surface area 144 sq in -> Tier 1 -> base price $115.20');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa2@test.com', 'password123', 'tester2', 'TestCo');
      await startNewQuote(page);
      await fillDimensions(page, 12, 12);
      const info = await getSaInfo(page);
      ok(info.includes('144 sq in'), 'T2: shows 144 sq in');
      ok(info.includes('Tier 1'), 'T2: shows Tier 1');
      const bp = await getBasePrice(page);
      ok(Math.abs(bp - 115.20) < 0.01, 'T2: base price $115.20 (got $' + bp.toFixed(2) + ')');
      await page.context().close();
    }

    // Test 3: 6x24 -> 144 sq in -> Tier 1 -> $115.20 (same as 12x12)
    {
      console.log('Test 3: 6x24 -> surface area 144 sq in -> Tier 1 -> $115.20');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa3@test.com', 'password123', 'tester3', 'TestCo');
      await startNewQuote(page);
      await fillDimensions(page, 6, 24);
      const info = await getSaInfo(page);
      ok(info.includes('144 sq in'), 'T3: shows 144 sq in');
      const bp = await getBasePrice(page);
      ok(Math.abs(bp - 115.20) < 0.01, 'T3: base price $115.20 (got $' + bp.toFixed(2) + ')');
      await page.context().close();
    }

    // Test 4: 2x70 -> 140 sq in -> Tier 1 -> $112.00
    {
      console.log('Test 4: 2x70 -> surface area 140 sq in -> Tier 1 -> $112.00');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa4@test.com', 'password123', 'tester4', 'TestCo');
      await startNewQuote(page);
      await fillDimensions(page, 2, 70);
      const info = await getSaInfo(page);
      ok(info.includes('140 sq in'), 'T4: shows 140 sq in');
      const bp = await getBasePrice(page);
      ok(Math.abs(bp - 112.00) < 0.01, 'T4: base price $112.00 (got $' + bp.toFixed(2) + ')');
      ok(bp < 200, 'T4: not the old diagonal price');
      await page.context().close();
    }

    // Test 5: 36x24 -> 864 sq in -> Tier 3 -> $864.00
    {
      console.log('Test 5: 36x24 -> surface area 864 sq in -> Tier 3 -> $864.00');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa5@test.com', 'password123', 'tester5', 'TestCo');
      await startNewQuote(page);
      await fillDimensions(page, 36, 24);
      const info = await getSaInfo(page);
      ok(info.includes('864 sq in'), 'T5: shows 864 sq in');
      ok(info.includes('Tier 3'), 'T5: shows Tier 3');
      const bp = await getBasePrice(page);
      ok(Math.abs(bp - 864.00) < 0.01, 'T5: base price $864.00 (got $' + bp.toFixed(2) + ')');
      await page.context().close();
    }

    // Test 6: Modifiers stack on surface area base price
    {
      console.log('Test 6: Modifiers stack correctly on surface area base price');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa6@test.com', 'password123', 'tester6', 'TestCo');
      await startNewQuote(page);
      await fillDimensions(page, 12, 12);
      await page.click('[data-grain="end"]');
      await page.waitForTimeout(300);
      const breakdown = await page.textContent('#qe-sa-breakdown');
      ok(breakdown.includes('115.20'), 'T6: breakdown shows base $115.20');
      ok(breakdown.includes('Grain'), 'T6: breakdown shows grain modifier');
      ok(breakdown.includes('144.00'), 'T6: product subtotal $144.00 with end grain');
      await page.context().close();
    }

    // Test 7: Settings -> Surface Area Tiers: 3 rows with defaults
    {
      console.log('Test 7: Settings -> Surface Area Tiers: 3 rows with correct defaults');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa7@test.com', 'password123', 'tester7', 'TestCo');
      await navigateToSATierSettings(page);
      const rows = await page.$$('.set-sa-rate');
      ok(rows.length === 3, 'T7: 3 tier rows (got ' + rows.length + ')');
      const rate1 = await rows[0].inputValue();
      const rate2 = await rows[1].inputValue();
      const rate3 = await rows[2].inputValue();
      ok(rate1 === '0.8', 'T7: Tier 1 rate 0.80 (got ' + rate1 + ')');
      ok(rate2 === '0.9', 'T7: Tier 2 rate 0.90 (got ' + rate2 + ')');
      ok(rate3 === '1', 'T7: Tier 3 rate 1.00 (got ' + rate3 + ')');
      await page.context().close();
    }

    // Test 8: Edit Tier 1 rate to $1.00 -> recalculates
    {
      console.log('Test 8: Edit Tier 1 rate to $1.00 -> new quote recalculates');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa8@test.com', 'password123', 'tester8', 'TestCo');
      await navigateToSATierSettings(page);
      const rateInputs = await page.$$('.set-sa-rate');
      await rateInputs[0].click();
      await rateInputs[0].fill('1');
      await saveSettingsAndGoBack(page);
      await startNewQuote(page);
      await fillDimensions(page, 12, 12);
      const bp = await getBasePrice(page);
      ok(Math.abs(bp - 144.00) < 0.01, 'T8: base price $144.00 after rate change (got $' + bp.toFixed(2) + ')');
      await page.context().close();
    }

    // Test 9: Edit Tier 2 max to 600 -> boundaries update
    {
      console.log('Test 9: Edit Tier 2 max to 600 -> tier boundaries update');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa9@test.com', 'password123', 'tester9', 'TestCo');
      await navigateToSATierSettings(page);
      const maxInputs = await page.$$('.set-sa-max');
      await maxInputs[1].click();
      await maxInputs[1].fill('600');
      await saveSettingsAndGoBack(page);
      await startNewQuote(page);
      await fillDimensions(page, 25, 26);
      const info = await getSaInfo(page);
      ok(info.includes('Tier 3'), 'T9: 650 sq in in Tier 3 after max change (info: ' + info + ')');
      await page.context().close();
    }

    // Test 10: Add a 4th tier
    {
      console.log('Test 10: Add a 4th tier -> works');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa10@test.com', 'password123', 'tester10', 'TestCo');
      await navigateToSATierSettings(page);
      await page.click('#set-sa-add');
      await page.waitForTimeout(200);
      const rows = await page.$$('.set-sa-rate');
      ok(rows.length === 4, 'T10: 4 tier rows after add (got ' + rows.length + ')');
      await page.context().close();
    }

    // Test 11: Delete a tier -> remaining tiers function
    {
      console.log('Test 11: Delete a tier -> remaining tiers function');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa11@test.com', 'password123', 'tester11', 'TestCo');
      await navigateToSATierSettings(page);
      const delBtns = await page.$$('.set-sa-del');
      ok(delBtns.length >= 2, 'T11: delete buttons present');
      await delBtns[0].click();
      await page.waitForTimeout(200);
      const rows = await page.$$('.set-sa-rate');
      ok(rows.length === 2, 'T11: 2 tier rows after delete (got ' + rows.length + ')');
      await saveSettingsAndGoBack(page);
      await startNewQuote(page);
      await fillDimensions(page, 12, 12);
      const bp = await getBasePrice(page);
      ok(bp > 0, 'T11: pricing still works after tier deletion (got $' + bp.toFixed(2) + ')');
      await page.context().close();
    }

    // Test 12: Hint references surface area
    {
      console.log('Test 12: Hint references surface area');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa12@test.com', 'password123', 'tester12', 'TestCo');
      await navigateToSATierSettings(page);
      const hintEl = await page.$('#sa-hint');
      ok(!!hintEl, 'T12: SA hint element exists');
      const hintText = await page.textContent('#sa-hint');
      ok(hintText.includes('surface area'), 'T12: hint mentions surface area');
      ok(!hintText.includes('diagonal'), 'T12: hint does not mention diagonal');
      await page.context().close();
    }

    // Test 13: Pricing modal references surface area
    {
      console.log('Test 13: Pricing modal references surface area');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa13@test.com', 'password123', 'tester13', 'TestCo');
      await page.evaluate(() => showSettings());
      await page.waitForSelector('#settings-screen', { state: 'visible', timeout: 3000 });
      await page.waitForTimeout(200);
      await page.click('[data-settings-idx="1"]');
      await page.waitForTimeout(300);
      await page.waitForSelector('#pricing-explainer-open', { state: 'visible', timeout: 3000 });
      await page.click('#pricing-explainer-open');
      await page.waitForTimeout(300);
      const modalText = await page.textContent('#pricing-explainer-modal');
      ok(modalText.includes('surface area'), 'T13: modal mentions surface area');
      ok(!modalText.includes('diagonal'), 'T13: modal does not mention diagonal');
      await page.context().close();
    }

    // Test 14: Quote form shows surface area info
    {
      console.log('Test 14: Quote form shows surface area info');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa14@test.com', 'password123', 'tester14', 'TestCo');
      await startNewQuote(page);
      await fillDimensions(page, 14, 10.5);
      const info = await getSaInfo(page);
      ok(info.includes('sq in'), 'T14: shows "sq in"');
      ok(info.includes('Tier'), 'T14: shows tier name');
      ok(info.includes('/sq in'), 'T14: shows $/sq in rate');
      ok(!info.includes('Diagonal'), 'T14: does not show "Diagonal"');
      const bp = await getBasePrice(page);
      ok(Math.abs(bp - 117.60) < 0.01, 'T14: 14x10.5 = $117.60 (got $' + bp.toFixed(2) + ')');
      await page.context().close();
    }

    // Test 15: Custom pricing mode still works
    {
      console.log('Test 15: Existing quote functionality unchanged');
      await resetMock();
      const page = await freshPage();
      await signUp(page, 'sa15@test.com', 'password123', 'tester15', 'TestCo');
      await startNewQuote(page);
      await page.click('[data-mode="custom"]');
      await page.waitForTimeout(200);
      const customVisible = await page.$eval('#qe-custom-section', el => el.style.display !== 'none');
      ok(customVisible, 'T15: custom pricing section visible');
      const saHidden = await page.$eval('#qe-sa-section', el => el.style.display === 'none');
      ok(saHidden, 'T15: surface area section hidden in custom mode');
      await page.context().close();
    }

  } catch(e) {
    console.error('FATAL:', e);
    fail++;
  } finally {
    console.log('\n=== Results: ' + pass + ' passed, ' + fail + ' failed ===');
    await browser.close();
    staticServer.close();
    mockProc.kill();
    process.exit(fail > 0 ? 1 : 0);
  }
})();
