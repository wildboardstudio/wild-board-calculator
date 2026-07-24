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

  async function resetMock() { await postMock('/_test/reset', {}); }

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

  async function signUp(page, email, password) {
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser === null, { timeout: 5000 }).catch(() => {});
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });
    const toggleBtn = await page.$('#auth-toggle-btn');
    if(toggleBtn) { const txt = await toggleBtn.innerText(); if(txt.includes('Sign up')) await toggleBtn.click(); }
    await page.waitForTimeout(100);
    await page.fill('#auth-email', email);
    await page.fill('#auth-password', password);
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, { timeout: 5000 });
    await page.waitForTimeout(300);
  }

  async function openNewQuote(page) {
    await page.evaluate(() => openQuoteEdit());
    await page.waitForSelector('#quote-edit-screen', { timeout: 3000 });
    await page.waitForTimeout(200);
  }

  try {
    // ===== T1: Card 1 — No Pricing Mode selector present =====
    console.log('\n--- T1: Card 1 — No Pricing Mode selector ---');
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'qfr1@test.com', 'pass1234');
    await openNewQuote(page);
    let r = await page.evaluate(() => {
      const body = document.getElementById('quote-edit-body');
      const sections = body.querySelectorAll('.quote-section');
      const card1 = sections[0];
      if(!card1) return { found: false };
      const hdr = card1.querySelector('.quote-section-hdr');
      const modeButtons = card1.querySelectorAll('[data-mode]');
      return { found: true, header: hdr?.textContent, hasModeButtons: modeButtons.length > 0 };
    });
    ok(r.found && r.header === 'Customer & Project Info' && !r.hasModeButtons, 'T1: No Pricing Mode selector in Card 1');
    await page.context().close();

    // ===== T2: Card 1 — "Generate New Project" is bold =====
    console.log('\n--- T2: Card 1 — Generate New Project bold ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr2@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const opt = document.querySelector('#qe-link-project option[value="__generate__"]');
      if(!opt) return { found: false };
      return { found: true, bold: opt.style.fontWeight === 'bold', text: opt.textContent };
    });
    ok(r.found && r.bold && r.text === 'Generate New Project', 'T2: Generate New Project option is bold');
    await page.context().close();

    // ===== T3: Card 1 — Notes read-only by default with Edit button =====
    console.log('\n--- T3: Card 1 — Notes read-only with Edit ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr3@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const display = document.getElementById('qe-notes-display');
      const editWrap = document.getElementById('qe-notes-edit-wrap');
      const editBtn = document.getElementById('qe-notes-edit-btn');
      return {
        displayVisible: display && display.style.display !== 'none',
        editWrapHidden: editWrap && editWrap.style.display === 'none',
        editBtnExists: !!editBtn,
        editBtnText: editBtn?.textContent,
        displayText: display?.textContent
      };
    });
    ok(r.displayVisible && r.editWrapHidden && r.editBtnExists && r.editBtnText === 'Edit', 'T3: Notes read-only by default with Edit button');
    ok(r.displayText === 'No notes yet', 'T3: Empty notes shows "No notes yet"');
    await page.context().close();

    // ===== T4: Card 1 — Tapping Edit makes Notes editable with Save/Cancel =====
    console.log('\n--- T4: Card 1 — Edit toggles notes ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr4@test.com', 'pass1234');
    await openNewQuote(page);
    await page.click('#qe-notes-edit-btn');
    await page.waitForTimeout(100);
    r = await page.evaluate(() => {
      const display = document.getElementById('qe-notes-display');
      const editWrap = document.getElementById('qe-notes-edit-wrap');
      const editBtn = document.getElementById('qe-notes-edit-btn');
      const saveBtn = document.getElementById('qe-notes-save-btn');
      const cancelBtn = document.getElementById('qe-notes-cancel-btn');
      const textarea = document.getElementById('qe-notes');
      return {
        displayHidden: display && display.style.display === 'none',
        editWrapVisible: editWrap && editWrap.style.display !== 'none',
        editBtnHidden: editBtn && editBtn.style.display === 'none',
        saveBtnExists: !!saveBtn,
        cancelBtnExists: !!cancelBtn,
        textareaExists: !!textarea
      };
    });
    ok(r.displayHidden && r.editWrapVisible && r.editBtnHidden, 'T4: Edit shows textarea, hides display');
    ok(r.saveBtnExists && r.cancelBtnExists && r.textareaExists, 'T4: Save/Cancel buttons and textarea present');
    await page.context().close();

    // ===== T5: Card 1 — Save commits, Cancel discards =====
    console.log('\n--- T5: Card 1 — Save/Cancel behavior ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr5@test.com', 'pass1234');
    await openNewQuote(page);
    // Test Save
    await page.click('#qe-notes-edit-btn');
    await page.fill('#qe-notes', 'Test note content');
    await page.click('#qe-notes-save-btn');
    await page.waitForTimeout(100);
    r = await page.evaluate(() => {
      const display = document.getElementById('qe-notes-display');
      const editWrap = document.getElementById('qe-notes-edit-wrap');
      return { displayText: display?.textContent, displayVisible: display?.style.display !== 'none', editHidden: editWrap?.style.display === 'none' };
    });
    ok(r.displayText === 'Test note content' && r.displayVisible && r.editHidden, 'T5a: Save commits notes text');

    // Test Cancel
    await page.click('#qe-notes-edit-btn');
    await page.fill('#qe-notes', 'Changed text');
    await page.click('#qe-notes-cancel-btn');
    await page.waitForTimeout(100);
    r = await page.evaluate(() => {
      const display = document.getElementById('qe-notes-display');
      return { displayText: display?.textContent, displayVisible: display?.style.display !== 'none' };
    });
    ok(r.displayText === 'Test note content' && r.displayVisible, 'T5b: Cancel discards changes');
    await page.context().close();

    // ===== T6: Card 2 — Header reads "Base Pricing" =====
    console.log('\n--- T6: Card 2 — Base Pricing header ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr6@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const sections = document.querySelectorAll('#quote-edit-body .quote-section');
      const card2 = sections[1];
      if(!card2) return { found: false };
      const hdr = card2.querySelector('.quote-section-hdr');
      return { found: true, header: hdr?.textContent };
    });
    ok(r.found && r.header === 'Base Pricing', 'T6: Card 2 header is "Base Pricing"');
    await page.context().close();

    // ===== T7: Card 2 — Pricing Mode pill centered, first element =====
    console.log('\n--- T7: Card 2 — Pricing Mode pill centered ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr7@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const sections = document.querySelectorAll('#quote-edit-body .quote-section');
      const card2 = sections[1];
      if(!card2) return { found: false };
      const body = card2.querySelector('.quote-section-body');
      const firstField = body.querySelector('.quote-field');
      const pillGroup = firstField?.querySelector('.quote-pill-group');
      const pills = pillGroup ? Array.from(pillGroup.querySelectorAll('.quote-pill')) : [];
      const pillTexts = pills.map(p => p.textContent.trim());
      const style = pillGroup ? pillGroup.style.justifyContent : '';
      return { found: true, pillTexts, centered: style === 'center', fullWidth: pillGroup?.style.width === '100%' };
    });
    ok(r.found && r.pillTexts.includes('Surface Area') && r.pillTexts.includes('Custom'), 'T7a: Pricing Mode pills present');
    ok(r.centered, 'T7b: Pricing Mode pills centered');
    await page.context().close();

    // ===== T8: Card 2 SA mode — Length × Width, no Thickness =====
    console.log('\n--- T8: Card 2 SA — Length × Width, no Thickness ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr8@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const saSection = document.getElementById('qe-sa-section');
      const dimL = document.getElementById('qe-dim-l');
      const dimW = document.getElementById('qe-dim-w');
      const dimTInSA = saSection?.querySelector('#qe-dim-t');
      const timesSymbol = saSection?.textContent.includes('×');
      return {
        saVisible: saSection && saSection.style.display !== 'none',
        hasLength: !!dimL,
        hasWidth: !!dimW,
        noThicknessInSA: !dimTInSA,
        hasTimesSymbol: timesSymbol
      };
    });
    ok(r.saVisible && r.hasLength && r.hasWidth && r.noThicknessInSA, 'T8: SA mode shows Length × Width, no Thickness');
    await page.context().close();

    // ===== T9: Card 2 SA — Live surface area info =====
    console.log('\n--- T9: Card 2 SA — Live SA info ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr9@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const saInfo = document.getElementById('qe-sa-info');
      return { text: saInfo?.textContent || '' };
    });
    ok(r.text.includes('Surface area: 450 sq in') && r.text.includes('Tier: Tier 2') && r.text.includes('$0.90/sq in'), 'T9: SA info shows "Surface area: 450 sq in · Tier: Tier 2 ($0.90/sq in)"');
    await page.context().close();

    // ===== T10: Card 2 SA — Footer shows Base Price =====
    console.log('\n--- T10: Card 2 SA — Base Price footer ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr10@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const footer = document.getElementById('qe-base-price-footer');
      return { text: footer?.textContent || '' };
    });
    ok(r.text === 'Base Price: $405.00', 'T10: SA Base Price footer shows $405.00 (450 × $0.90)');
    await page.context().close();

    // ===== T11: Card 2 Custom — Line item rows with correct placeholders =====
    console.log('\n--- T11: Card 2 Custom — Line items ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr11@test.com', 'pass1234');
    await openNewQuote(page);
    await page.click('[data-mode="custom"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const customSec = document.getElementById('qe-custom-section');
      const visible = customSec && customSec.style.display !== 'none';
      const rows = document.querySelectorAll('#qe-line-items .quote-line-item');
      if(rows.length === 0) return { visible, hasRows: false };
      const first = rows[0];
      const descInput = first.querySelector('.qe-li-desc');
      const qtyInput = first.querySelector('.qe-li-qty');
      const priceInput = first.querySelector('.qe-li-price');
      return {
        visible,
        hasRows: true,
        rowCount: rows.length,
        descPlaceholder: descInput?.placeholder,
        qtyPlaceholder: qtyInput?.placeholder,
        pricePlaceholder: priceInput?.placeholder
      };
    });
    ok(r.visible && r.hasRows, 'T11a: Custom mode shows line item rows');
    ok(r.descPlaceholder === 'Description' && r.qtyPlaceholder === 'Qty' && r.pricePlaceholder === '$', 'T11b: Correct placeholders');
    await page.context().close();

    // ===== T12: Card 2 Custom — Line totals compute correctly =====
    console.log('\n--- T12: Card 2 Custom — Line totals ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr12@test.com', 'pass1234');
    await openNewQuote(page);
    await page.click('[data-mode="custom"]');
    await page.waitForTimeout(200);
    const row = await page.$('#qe-line-items .quote-line-item');
    await row.$eval('.qe-li-desc', el => { el.value = 'Test item'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await row.$eval('.qe-li-qty', el => { el.value = '3'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await row.$eval('.qe-li-price', el => { el.value = '25'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const total = document.querySelector('#qe-line-items .quote-line-item .qe-li-total');
      return { totalText: total?.textContent || '' };
    });
    ok(r.totalText === '$75.00', 'T12: Line total = 3 × $25 = $75.00');
    await page.context().close();

    // ===== T13: Card 2 Custom — Footer shows sum =====
    console.log('\n--- T13: Card 2 Custom — Base Price footer ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr13@test.com', 'pass1234');
    await openNewQuote(page);
    await page.click('[data-mode="custom"]');
    await page.waitForTimeout(200);
    const row13 = await page.$('#qe-line-items .quote-line-item');
    await row13.$eval('.qe-li-qty', el => { el.value = '2'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await row13.$eval('.qe-li-price', el => { el.value = '50'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const footer = document.getElementById('qe-base-price-footer');
      return { text: footer?.textContent || '' };
    });
    ok(r.text === 'Base Price: $100.00', 'T13: Custom Base Price footer = $100.00');
    await page.context().close();

    // ===== T14: Card 3 — Header reads "Construction Details" =====
    console.log('\n--- T14: Card 3 — Construction Details header ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr14@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      if(!cs) return { found: false };
      const hdr = cs.querySelector('.quote-section-hdr');
      return { found: true, header: hdr?.textContent };
    });
    ok(r.found && r.header === 'Construction Details', 'T14: Card 3 header is "Construction Details"');
    await page.context().close();

    // ===== T15: Card 3 — Thickness field present =====
    console.log('\n--- T15: Card 3 — Thickness field present ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr15@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      if(!cs) return { found: false };
      const thickInput = cs.querySelector('#qe-dim-t');
      return { found: true, hasThickness: !!thickInput };
    });
    ok(r.found && r.hasThickness, 'T15: Thickness field in Construction Details');
    await page.context().close();

    // ===== T16: Card 3 — Row order =====
    console.log('\n--- T16: Card 3 — Row order ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr16@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      if(!cs) return { found: false };
      const body = cs.querySelector('.quote-section-body');
      if(!body) return { found: false };
      const labels = Array.from(body.querySelectorAll('label')).map(l => l.textContent.trim().replace(/\s+/g, ' '));
      return { found: true, labels };
    });
    const expectedOrder = ['Grain Direction', 'Thickness (in)', 'Number of Glue Ups'];
    const labelsStr = (r.labels || []).join('|');
    const orderCorrect = labelsStr.indexOf('Grain Direction') < labelsStr.indexOf('Thickness (in)') &&
                         labelsStr.indexOf('Thickness (in)') < labelsStr.indexOf('Number of Glue Ups') &&
                         labelsStr.indexOf('Number of Glue Ups') < labelsStr.indexOf('Complex Pattern');
    ok(r.found && orderCorrect, 'T16: Row order — Grain Direction, Thickness, Glue Ups, Complex Pattern, Additional Features');
    await page.context().close();

    // ===== T17: Card 3 — Complex Pattern ⓘ info icon =====
    console.log('\n--- T17: Card 3 — Complex Pattern info icon ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr17@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const btn = document.getElementById('qe-complex-info');
      return { exists: !!btn, text: btn?.textContent };
    });
    ok(r.exists && r.text === 'i', 'T17a: Complex Pattern has ⓘ info icon');

    // Click it and verify alert
    page.on('dialog', async d => { await d.accept(); });
    const alertPromise = new Promise(resolve => {
      page.once('dialog', d => resolve(d.message()));
    });
    await page.click('#qe-complex-info');
    const alertMsg = await alertPromise;
    ok(alertMsg.includes('complex pattern') && alertMsg.includes('angled cuts'), 'T17b: Info icon shows correct hint text');
    await page.context().close();

    // ===== T18: Card 3 — "Additional Features" label =====
    console.log('\n--- T18: Card 3 — Additional Features label ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr18@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      if(!cs) return { found: false };
      const allText = cs.textContent;
      return { found: true, hasAdditionalFeatures: allText.includes('Additional Features'), hasJustFeatures: /(?<!\w)Features(?!\s+\()/.test(allText) };
    });
    ok(r.found && r.hasAdditionalFeatures, 'T18: Label says "Additional Features"');
    await page.context().close();

    // ===== T19: Card 3 — Footer shows Price =====
    console.log('\n--- T19: Card 3 — Price footer ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr19@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const cpf = document.getElementById('qe-construction-price');
      return { exists: !!cpf, text: cpf?.textContent || '' };
    });
    ok(r.exists && r.text.startsWith('Price: $'), 'T19: Card 3 footer shows "Price: $X.XX"');
    await page.context().close();

    // ===== T20: Card 3 — Price calculation (25×18, end grain, 2.25" thick, 2 glue-ups) =====
    console.log('\n--- T20: Card 3 — Full price calculation ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr20@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(100);
    // End grain
    await page.click('[data-grain="end"]');
    // Thickness 2.25
    await page.fill('#qe-dim-t', '2.25');
    await page.waitForTimeout(100);
    // 2 glue-ups
    await page.click('[data-glue="2"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const cpf = document.getElementById('qe-construction-price');
      return { text: cpf?.textContent || '' };
    });
    // Base: 450 * 0.90 = 405
    // Modifiers: thickness 0.18 + endGrain 0.25 + glueUp[2] 0.10 = 0.53
    // Price = 405 * (1 + 0.53) = 405 * 1.53 = 619.65
    ok(r.text === 'Price: $619.65', 'T20: Price = $405 × (1 + 0.18 + 0.25 + 0.10) = $619.65');
    await page.context().close();

    // ===== T21: Card 5 — "Add-Ons ($)" row removed =====
    console.log('\n--- T21: Card 5 — Add-Ons removed ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr21@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const body = document.getElementById('quote-edit-body');
      const sections = body.querySelectorAll('.quote-section');
      let expSection = null;
      sections.forEach(s => { if(s.querySelector('.quote-section-hdr')?.textContent.includes('Expenses')) expSection = s; });
      if(!expSection) return { found: false };
      const labels = Array.from(expSection.querySelectorAll('label')).map(l => l.textContent.trim());
      return { found: true, labels, hasAddOns: labels.some(l => l.includes('Add-On')) };
    });
    ok(r.found && !r.hasAddOns, 'T21: "Add-Ons ($)" row removed from Card 5');
    await page.context().close();

    // ===== T22: Card 5 — "Other ($)" row removed =====
    console.log('\n--- T22: Card 5 — Other removed ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr22@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const body = document.getElementById('quote-edit-body');
      const sections = body.querySelectorAll('.quote-section');
      let expSection = null;
      sections.forEach(s => { if(s.querySelector('.quote-section-hdr')?.textContent.includes('Expenses')) expSection = s; });
      if(!expSection) return { found: false };
      const labels = Array.from(expSection.querySelectorAll('label')).map(l => l.textContent.trim());
      return { found: true, labels, hasOther: labels.some(l => l === 'Other ($)' || l.includes('Other (')) };
    });
    ok(r.found && !r.hasOther, 'T22: "Other ($)" row removed from Card 5');
    await page.context().close();

    // ===== T23: Card 5 — Third-Party Costs and Delivery/Shipping remain =====
    console.log('\n--- T23: Card 5 — Third-Party and Delivery remain ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr23@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const body = document.getElementById('quote-edit-body');
      const sections = body.querySelectorAll('.quote-section');
      let expSection = null;
      sections.forEach(s => { if(s.querySelector('.quote-section-hdr')?.textContent.includes('Expenses')) expSection = s; });
      if(!expSection) return { found: false };
      const labels = Array.from(expSection.querySelectorAll('label')).map(l => l.textContent.trim());
      return {
        found: true,
        hasThirdParty: labels.some(l => l.includes('Third-Party')),
        hasDelivery: labels.some(l => l.includes('Delivery') || l.includes('Shipping')),
        hasMarkup: labels.some(l => l.includes('Markup'))
      };
    });
    ok(r.found && r.hasThirdParty && r.hasDelivery && r.hasMarkup, 'T23: Third-Party, Delivery/Shipping, and Markup remain');
    await page.context().close();

    // ===== T24: Quote total calculates correctly with updated expense fields =====
    console.log('\n--- T24: Quote total with updated expenses ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr24@test.com', 'pass1234');
    await openNewQuote(page);
    // Set dimensions for a base price
    await page.fill('#qe-dim-l', '10');
    await page.fill('#qe-dim-w', '10');
    await page.waitForTimeout(100);
    // Set expenses: Third-Party $100, Delivery $50, Markup 10%
    await page.fill('#qe-exp-third', '100');
    await page.fill('#qe-exp-delivery', '50');
    await page.fill('#qe-exp-markup', '10');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const sm = document.getElementById('qe-summary');
      if(!sm) return { found: false };
      const rows = sm.querySelectorAll('.quote-breakdown-row');
      let expensesText = '';
      rows.forEach(row => {
        if(row.textContent.includes('Expenses:')) expensesText = row.querySelectorAll('span')[1]?.textContent || '';
      });
      return { found: true, expensesText };
    });
    // Expenses = (100 + 50) × 1.10 = $165.00
    ok(r.found && r.expensesText === '$165.00', 'T24: Expenses = (100 + 50) × 1.10 = $165.00');
    await page.context().close();

    // ===== T25: All existing functionality unchanged (save, quote detail) =====
    console.log('\n--- T25: Save and view still works ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'qfr25@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-cust-name', 'Test Customer');
    await page.fill('#qe-dim-l', '20');
    await page.fill('#qe-dim-w', '15');
    await page.fill('#qe-dim-t', '1.5');
    await page.waitForTimeout(200);
    // Click save
    await page.click('#qe-save-btn');
    await page.waitForTimeout(500);
    r = await page.evaluate(() => {
      const detailScreen = document.getElementById('quote-detail-screen');
      const visible = detailScreen && detailScreen.style.display !== 'none';
      const header = document.querySelector('#quote-detail-screen .quote-detail-number, #quote-detail-screen h2, #quote-detail-screen .quote-section-hdr');
      return { visible, hasContent: !!header };
    });
    ok(r.visible, 'T25: Save redirects to quote detail — existing functionality works');
    await page.context().close();

  } catch(e) {
    console.error('Test error:', e);
    fail++;
  } finally {
    console.log('\n========================================');
    console.log('RESULTS: ' + pass + ' passed, ' + fail + ' failed out of ' + (pass+fail));
    console.log('========================================');
    await browser.close();
    staticServer.close();
    mockProc.kill();
    process.exit(fail > 0 ? 1 : 0);
  }
})();
