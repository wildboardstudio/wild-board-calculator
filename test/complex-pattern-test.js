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
    if(fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const ct = ext === '.js' ? 'application/javascript' : 'application/json';
      res.writeHead(200, { 'Content-Type': ct }); res.end(fs.readFileSync(filePath)); return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => staticServer.listen(STATIC_PORT, r));

  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true, args: ['--no-sandbox'] });

  function postMock(mockPath, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port: MOCK_PORT, path: mockPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject); req.write(data); req.end();
    });
  }
  function getMock(mockPath) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: MOCK_PORT, path: mockPath }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d || '{}')));
      }).on('error', reject);
    });
  }
  async function resetMock() { await postMock('/_test/reset', {}); }

  async function freshPage() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.clear(); });
    page.on('console', msg => {
      if(msg.type() === 'error' && !msg.text().includes('ERR_BLOCKED') && !msg.text().includes('favicon') && !msg.text().includes('404'))
        console.log('[ERR]', msg.text());
    });
    await page.goto('http://127.0.0.1:' + STATIC_PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    return page;
  }
  async function signUp(page, email) {
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser === null, { timeout: 5000 }).catch(() => {});
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });
    const tg = await page.$('#auth-toggle-btn');
    if(tg) { const t = await tg.innerText(); if(t.includes('Sign up')) await tg.click(); }
    await page.waitForTimeout(100);
    await page.fill('#auth-email', email);
    await page.fill('#auth-password', 'pass123');
    const cf = await page.$('#auth-password-confirm');
    if(cf) await page.fill('#auth-password-confirm', 'pass123');
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, { timeout: 5000 });
    const wb = await page.$('#auth-welcome-btn');
    if(wb) await wb.click();
    await page.waitForTimeout(300);
  }
  async function openSettings(page) { await page.evaluate(() => showSettings()); await page.waitForTimeout(300); }
  async function openNewQuote(page) { await page.evaluate(() => openQuoteEdit()); await page.waitForSelector('#quote-edit-screen', { timeout: 3000 }); await page.waitForTimeout(200); }

  function cpEnabled(page) {
    return page.evaluate(() => {
      const q = quotesData && _currentQuoteId ? quotesData.find(x => x.id === _currentQuoteId) : null;
      // fall back to the in-memory editing quote via the form
      const cb = [...document.querySelectorAll('.qe-co-feat-check')].find((c,i) => {
        const label = c.closest('.quote-feature-row') && c.closest('.quote-feature-row').textContent;
        return label && label.includes('Complex Pattern');
      });
      return cb ? cb.checked : null;
    });
  }

  try {
    // ── T1: Threshold field default + save/persist ──
    console.log('\n--- T1: Threshold setting saves/persists ---');
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'cp1@test.com');
    await openSettings(page);
    await page.evaluate(() => document.querySelector('.settings-collapse-hdr[data-section="pricing"]').click());
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector('.settings-sub-collapse-hdr[data-sub="grain"]').click());
    await page.waitForTimeout(150);
    const defThresh = await page.evaluate(() => document.getElementById('set-complex-threshold')?.value);
    ok(defThresh === '3', 'T1a: Threshold field defaults to 3 (got ' + defThresh + ')');
    await page.fill('#set-complex-threshold', '4');
    await page.click('.set-sub-save[data-sub="grain"]');
    await page.waitForTimeout(600);
    const persisted = await page.evaluate(() => _getSettings().multipliers.complexPatternThreshold);
    ok(persisted === 4, 'T1b: Threshold saved to settings (got ' + persisted + ')');
    const dump = await getMock('/_test/dump');
    const savedThresh = dump.profiles && dump.profiles[0] && dump.profiles[0].settings
      ? dump.profiles[0].settings.multipliers.complexPatternThreshold : null;
    ok(savedThresh === 4, 'T1c: Threshold persisted to Supabase (got ' + savedThresh + ')');
    await page.close();

    // ── T2: Data model defaults ──
    console.log('\n--- T2: Data model defaults ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cp2@test.com');
    await openNewQuote(page);
    const model = await page.evaluate(() => {
      const co = _getProductTemplate('cutting_board', _getSettings());
      return { tc: co.thicknessCount, ac: co.angledCuts };
    });
    ok(model.tc === 0 && model.ac === false, 'T2: cutting_board template has thicknessCount:0, angledCuts:false');
    // UI rows present
    const rows = await page.evaluate(() => ({
      thickCount: document.querySelectorAll('[data-thickcount]').length,
      angled: !!document.getElementById('qe-angled-cuts')
    }));
    ok(rows.thickCount === 6 && rows.angled, 'T2b: Thickness Count pills (0-5) + Angled Cuts checkbox render');
    await page.close();

    // ── T3: Thickness Count boundary triggers Complex Pattern ──
    console.log('\n--- T3: Thickness Count boundary ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cp3@test.com');
    await openNewQuote(page);
    // default threshold 3
    await page.evaluate(() => document.querySelector('[data-thickcount="2"]').click());
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === false, 'T3a: thicknessCount=2 (<3) → Complex Pattern OFF');
    await page.evaluate(() => document.querySelector('[data-thickcount="3"]').click());
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === true, 'T3b: thicknessCount=3 (>=3) → Complex Pattern ON');
    await page.evaluate(() => document.querySelector('[data-thickcount="1"]').click());
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === false, 'T3c: thicknessCount back to 1 → Complex Pattern OFF');
    await page.close();

    // ── T4: Angled Cuts triggers Complex Pattern ──
    console.log('\n--- T4: Angled Cuts trigger ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cp4@test.com');
    await openNewQuote(page);
    await page.evaluate(() => { const c = document.getElementById('qe-angled-cuts'); c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); });
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === true, 'T4a: Angled Cuts checked → Complex Pattern ON');
    await page.evaluate(() => { const c = document.getElementById('qe-angled-cuts'); c.checked = false; c.dispatchEvent(new Event('change', {bubbles:true})); });
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === false, 'T4b: Angled Cuts unchecked → Complex Pattern OFF');
    await page.close();

    // ── T5: Manual override holds until input changes ──
    console.log('\n--- T5: Manual override holds ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cp5@test.com');
    await openNewQuote(page);
    // Auto ON via thickness count 3
    await page.evaluate(() => document.querySelector('[data-thickcount="3"]').click());
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === true, 'T5a: auto-enabled via thicknessCount=3');
    // Manually uncheck complex pattern
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.qe-co-feat-check')].find(c => c.closest('.quote-feature-row').textContent.includes('Complex Pattern'));
      cb.checked = false; cb.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === false, 'T5b: manual uncheck holds (still OFF, no input change)');
    // Change an unrelated thing: toggle glue-ups — should NOT recompute complex pattern
    await page.evaluate(() => document.querySelector('[data-glue="2"]').click());
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === false, 'T5c: manual state survives unrelated change (glue-ups)');
    // Now change thickness count again → recompute overwrites back ON
    await page.evaluate(() => document.querySelector('[data-thickcount="4"]').click());
    await page.waitForTimeout(200);
    ok(await cpEnabled(page) === true, 'T5d: changing thicknessCount recomputes and overwrites back ON');
    await page.close();

    // ── T6: Hint text reflects live threshold ──
    console.log('\n--- T6: Hint text live threshold ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cp6@test.com');
    await openSettings(page);
    await page.evaluate(() => { const s = _getSettings(); s.multipliers.complexPatternThreshold = 5; localStorage.setItem('wbc_settings', JSON.stringify(s)); });
    await page.evaluate(() => _renderSettingsBody());
    await page.evaluate(() => document.querySelector('.settings-collapse-hdr[data-section="pricing"]').click());
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector('.settings-sub-collapse-hdr[data-sub="grain"]').click());
    await page.waitForTimeout(150);
    // open cp info
    await page.evaluate(() => document.querySelector('.settings-info-btn[data-info="cp"]').click());
    await page.waitForTimeout(150);
    const cpText = await page.evaluate(() => document.getElementById('settings-info-text').textContent);
    await page.evaluate(() => document.getElementById('settings-info-close').click());
    ok(cpText.includes('5 or more different thicknesses'), 'T6a: cp hint uses live threshold 5 (' + cpText.slice(0,60) + ')');
    await page.evaluate(() => document.querySelector('.settings-info-btn[data-info="grain"]').click());
    await page.waitForTimeout(150);
    const grainText = await page.evaluate(() => document.getElementById('settings-info-text').textContent);
    await page.evaluate(() => document.getElementById('settings-info-close').click());
    ok(grainText.includes('5 or more thicknesses'), 'T6b: grain hint uses live threshold 5');
    // Quote editor alert
    await openNewQuote(page);
    let alertMsg = '';
    page.on('dialog', async d => { alertMsg = d.message(); await d.dismiss(); });
    await page.evaluate(() => { const b = document.getElementById('qe-complex-info'); if(b) b.click(); });
    await page.waitForTimeout(200);
    ok(alertMsg.includes('5 or more different thicknesses'), 'T6c: quote editor complex-pattern alert uses live threshold 5');
    await page.close();

    // ── T7: Existing complex_pattern modifier unaffected ──
    console.log('\n--- T7: Complex pattern modifier intact ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cp7@test.com');
    await openNewQuote(page);
    // 25x18 CB, base 405; enable complex via angled cuts → +25%
    await page.fill('#qe-dim-l', '25'); await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(200);
    await page.evaluate(() => { const c = document.getElementById('qe-angled-cuts'); c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); });
    await page.waitForTimeout(200);
    const priceInfo = await page.evaluate(() => {
      const co = _getProductTemplate ? null : null;
      const q = { dimensions: { length: '25', width: '18' }, productType: 'cutting_board',
        constructionOptions: JSON.parse(JSON.stringify((function(){
          // reconstruct from DOM state via collect
          return null;
        })())) };
      return null;
    });
    // Verify via the construction price footer element
    const cpModifierApplied = await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.qe-co-feat-check')].find(c => c.closest('.quote-feature-row').textContent.includes('Complex Pattern'));
      const summary = cb.closest('.quote-feature-row').querySelector('.qe-co-feat-summary');
      return { checked: cb.checked, summary: summary ? summary.textContent : null };
    });
    ok(cpModifierApplied.checked && cpModifierApplied.summary === '+25%',
      'T7: Complex Pattern still applies its +25% modifier when auto-enabled (' + cpModifierApplied.summary + ')');
    await page.close();

    // ── T8: Save/restore thicknessCount + angledCuts ──
    console.log('\n--- T8: Save/restore ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cp8@test.com');
    await openNewQuote(page);
    await page.fill('#qe-cust-name', 'CP Client'); await page.fill('#qe-email', 'cpc@test.com');
    await page.evaluate(() => document.querySelector('[data-thickcount="4"]').click());
    await page.waitForTimeout(200);
    await page.evaluate(() => { const c = document.getElementById('qe-angled-cuts'); c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true})); });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#quote-edit-screen .btn-primary')];
      const s = btns.find(b => b.textContent.trim() === 'Save Quote'); if(s) s.click();
    });
    await page.waitForTimeout(600);
    const editBtn = await page.$('#qd-edit-btn');
    if(editBtn) await editBtn.click();
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => {
      const tc = document.querySelector('[data-thickcount].active');
      const ac = document.getElementById('qe-angled-cuts');
      return { thickCount: tc ? tc.getAttribute('data-thickcount') : null, angled: ac ? ac.checked : null };
    });
    ok(restored.thickCount === '4' && restored.angled === true, 'T8: thicknessCount=4 + angledCuts restored on reopen');
    await page.close();

  } catch(err) {
    console.error('FATAL:', err);
    fail++;
  } finally {
    await browser.close();
    staticServer.close();
    mockProc.kill();
    console.log('\nRESULTS: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
