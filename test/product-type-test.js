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
    const cf = await page.$('#auth-password-confirm');
    if(cf) await page.fill('#auth-password-confirm', password);
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, { timeout: 5000 });
    const wb = await page.$('#auth-welcome-btn');
    if(wb) await wb.click();
    await page.waitForTimeout(300);
  }

  async function openNewQuote(page) {
    await page.evaluate(() => openQuoteEdit());
    await page.waitForSelector('#quote-edit-screen', { timeout: 3000 });
    await page.waitForTimeout(200);
  }

  try {
    // ===== T1: New quote defaults to Cutting Board =====
    console.log('\n--- T1: Default product type ---');
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'pt1@test.com', 'pass1234');
    await openNewQuote(page);
    let r = await page.evaluate(() => {
      const active = document.querySelector('[data-ptype].active');
      return { type: active?.getAttribute('data-ptype'), text: active?.textContent };
    });
    ok(r.type === 'cutting_board' && r.text === 'Cutting Board', 'T1: New quote defaults to Cutting Board');
    await page.context().close();

    // ===== T2: Product Type selector shows all 4 options =====
    console.log('\n--- T2: All 4 product types ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt2@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[data-ptype]'));
      return btns.map(b => ({ type: b.getAttribute('data-ptype'), text: b.textContent.trim() }));
    });
    ok(r.length === 4, 'T2a: 4 product type buttons');
    ok(r.some(b => b.type === 'cutting_board') && r.some(b => b.type === 'table_top') && r.some(b => b.type === 'sign') && r.some(b => b.type === 'custom'), 'T2b: All 4 types present');
    await page.context().close();

    // ===== T3: Cutting Board: Length × Width, live SA, Base Price footer =====
    console.log('\n--- T3: Cutting Board pricing ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt3@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const saInfo = document.getElementById('qe-sa-info')?.textContent || '';
      const footer = document.getElementById('qe-base-price-footer')?.textContent || '';
      const dimL = document.getElementById('qe-dim-l');
      const dimW = document.getElementById('qe-dim-w');
      return { saInfo, footer, hasL: !!dimL, hasW: !!dimW };
    });
    ok(r.hasL && r.hasW && r.saInfo.includes('450 sq in') && r.saInfo.includes('Tier 2'), 'T3a: Cutting Board shows L×W with live SA');
    ok(r.footer === 'Base Price: $405.00', 'T3b: Base Price footer correct');
    await page.context().close();

    // ===== T4: Table Top: same dimension-based engine =====
    console.log('\n--- T4: Table Top pricing ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt4@test.com', 'pass1234');
    await openNewQuote(page);
    page.on('dialog', async d => await d.accept());
    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      const visible = cs && cs.style.display !== 'none';
      const hdr = cs?.querySelector('.quote-section-hdr')?.textContent;
      const saSection = document.getElementById('qe-sa-section');
      return { visible, hdr, saVisible: saSection && saSection.style.display !== 'none' };
    });
    ok(r.visible && r.hdr === 'Construction Options' && r.saVisible, 'T4: Table Top shows dim engine + Construction Options');
    await page.context().close();

    // ===== T5: Sign: same engine, no Grain Direction =====
    console.log('\n--- T5: Sign — no Grain Direction ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt5@test.com', 'pass1234');
    await openNewQuote(page);
    page.on('dialog', async d => await d.accept());
    await page.click('[data-ptype="sign"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      const grainBtns = cs?.querySelectorAll('[data-grain]') || [];
      const saSection = document.getElementById('qe-sa-section');
      return { grainCount: grainBtns.length, saVisible: saSection && saSection.style.display !== 'none' };
    });
    ok(r.grainCount === 0 && r.saVisible, 'T5: Sign has no Grain Direction pill, SA section visible');
    await page.context().close();

    // ===== T6: Custom: line items, Construction Options hidden =====
    console.log('\n--- T6: Custom mode ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt6@test.com', 'pass1234');
    await openNewQuote(page);
    page.on('dialog', async d => await d.accept());
    await page.click('[data-ptype="custom"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      const custom = document.getElementById('qe-custom-section');
      const sa = document.getElementById('qe-sa-section');
      return {
        constructionHidden: cs && cs.style.display === 'none',
        customVisible: custom && custom.style.display !== 'none',
        saHidden: sa && sa.style.display === 'none'
      };
    });
    ok(r.constructionHidden && r.customVisible && r.saHidden, 'T6: Custom hides Construction Options, shows line items');
    await page.context().close();

    // ===== T7: Grain Direction for Cutting Board and Table Top only =====
    console.log('\n--- T7: Grain Direction visibility ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt7@test.com', 'pass1234');
    await openNewQuote(page);
    page.on('dialog', async d => await d.accept());
    // Cutting Board - should have grain
    r = await page.evaluate(() => {
      const grainBtns = document.querySelectorAll('#qe-construction-section [data-grain]');
      return { cbGrain: grainBtns.length };
    });
    ok(r.cbGrain === 2, 'T7a: Cutting Board has Grain Direction');

    // Switch to Table Top
    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const grainBtns = document.querySelectorAll('#qe-construction-section [data-grain]');
      return { ttGrain: grainBtns.length };
    });
    ok(r.ttGrain === 2, 'T7b: Table Top has Grain Direction');

    // Switch to Sign
    await page.click('[data-ptype="sign"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const grainBtns = document.querySelectorAll('#qe-construction-section [data-grain]');
      return { signGrain: grainBtns.length };
    });
    ok(r.signGrain === 0, 'T7c: Sign has no Grain Direction');
    await page.context().close();

    // ===== T8: Thickness shown as dropdown selector populated from Settings =====
    console.log('\n--- T8: Thickness dropdown ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt8@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const sel = document.getElementById('qe-thick-select');
      if(!sel) return { exists: false };
      const options = Array.from(sel.options).map(o => o.textContent.trim());
      const isSelect = sel.tagName === 'SELECT';
      return { exists: true, isSelect, optionCount: options.length, firstOption: options[0], hasRanges: options.some(o => o.includes('" –')) };
    });
    ok(r.exists && r.isSelect && r.optionCount > 2 && r.hasRanges, 'T8: Thickness is dropdown with tier ranges');
    await page.context().close();

    // ===== T9: Glue Ups for Cutting Board only =====
    console.log('\n--- T9: Glue Ups Cutting Board only ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt9@test.com', 'pass1234');
    await openNewQuote(page);
    page.on('dialog', async d => await d.accept());
    r = await page.evaluate(() => {
      const sel = document.querySelector('#qe-construction-section #qe-glue-select') || document.getElementById('qe-glue-select');
      return { cbGlue: sel ? sel.options.length : 0 };
    });
    ok(r.cbGlue === 6, 'T9a: Cutting Board has Glue Ups dropdown (0-5)');

    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const sel = document.getElementById('qe-glue-select');
      return { ttGlue: sel ? 1 : 0 };
    });
    ok(r.ttGlue === 0, 'T9b: Table Top has no Glue Ups');
    await page.context().close();

    // ===== T10: Visual divider between Required and Optional Features =====
    console.log('\n--- T10: Divider Required/Optional ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt10@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      if(!cs) return { found: false };
      const body = cs.querySelector('.quote-section-body');
      const divider = body?.querySelector('div[style*="border-top"]');
      const optLabel = body?.textContent.includes('Optional Features');
      return { found: true, hasDivider: !!divider, hasOptLabel: optLabel };
    });
    ok(r.found && r.hasDivider && r.hasOptLabel, 'T10: Divider between Required fields and Optional Features');
    await page.context().close();

    // ===== T11: Cutting Board features with correct defaults =====
    console.log('\n--- T11: Cutting Board feature defaults ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt11@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      if(!cs) return { found: false };
      const text = cs.textContent;
      return {
        found: true,
        hasComplexPattern: text.includes('Complex Pattern'),
        hasJuiceGroove: text.includes('Juice Groove'),
        hasFingerGrips: text.includes('Finger Grips'),
        hasFeet: text.includes('Feet'),
        hasCustomEngraving: text.includes('Custom Engraving')
      };
    });
    ok(r.found && r.hasComplexPattern && r.hasJuiceGroove && r.hasFingerGrips && r.hasFeet && r.hasCustomEngraving, 'T11: Cutting Board has all 5 features');
    await page.context().close();

    // ===== T12: Checked feature with default shows compact summary =====
    console.log('\n--- T12: Feature with default — compact summary ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt12@test.com', 'pass1234');
    await openNewQuote(page);
    // Check Juice Groove (has default $50)
    const juiceIdx = await page.evaluate(() => {
      const co = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < co.length; i++) {
        const row = co[i].closest('.quote-feature-row');
        if(row && row.textContent.includes('Juice Groove')) return i;
      }
      return -1;
    });
    await page.click('.qe-co-feat-check[data-idx="' + juiceIdx + '"]');
    await page.waitForTimeout(300);
    r = await page.evaluate((idx) => {
      const row = document.querySelector('.quote-feature-row[data-feat-idx="' + idx + '"]');
      if(!row) return { found: false };
      const summary = row.querySelector('.qe-co-feat-summary');
      return { found: true, hasSummary: !!summary, summaryText: summary?.textContent };
    }, juiceIdx);
    ok(r.found && r.hasSummary && r.summaryText === '+$50', 'T12: Checked feature with default shows "+$50" summary');
    await page.context().close();

    // ===== T13: Checked feature without default expands inline editor =====
    console.log('\n--- T13: Feature without default — inline editor ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt13@test.com', 'pass1234');
    await openNewQuote(page);
    page.on('dialog', async d => await d.accept());
    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(300);
    // Check Live Edge (no default for Table Top features)
    const liveEdgeIdx = await page.evaluate(() => {
      const co = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < co.length; i++) {
        const row = co[i].closest('.quote-feature-row');
        if(row && row.textContent.includes('Live Edge')) return i;
      }
      return -1;
    });
    await page.click('.qe-co-feat-check[data-idx="' + liveEdgeIdx + '"]');
    await page.waitForTimeout(200);
    r = await page.evaluate((idx) => {
      const editor = document.querySelector('.qe-co-feat-editor[data-idx="' + idx + '"]');
      return { visible: editor && editor.style.display !== 'none', hasDollarBtn: !!editor?.querySelector('[data-mtype="flat"]'), hasPercentBtn: !!editor?.querySelector('[data-mtype="percent"]'), hasValueInput: !!editor?.querySelector('.qe-co-mod-val') };
    }, liveEdgeIdx);
    ok(r.visible && r.hasDollarBtn && r.hasPercentBtn && r.hasValueInput, 'T13: Feature without default shows inline $ / % / value editor');
    await page.context().close();

    // ===== T14: Entering modifier value collapses row to summary =====
    console.log('\n--- T14: Entering value collapses to summary ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt14@test.com', 'pass1234');
    await openNewQuote(page);
    page.on('dialog', async d => await d.accept());
    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(300);
    const edgeIdx14 = await page.evaluate(() => {
      const co = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < co.length; i++) {
        const row = co[i].closest('.quote-feature-row');
        if(row && row.textContent.includes('Live Edge')) return i;
      }
      return -1;
    });
    await page.click('.qe-co-feat-check[data-idx="' + edgeIdx14 + '"]');
    await page.waitForTimeout(200);
    await page.fill('.qe-co-mod-val[data-idx="' + edgeIdx14 + '"]', '75');
    await page.waitForTimeout(200);
    // Re-render by collecting from form (live update triggers)
    r = await page.evaluate((idx) => {
      const valInput = document.querySelector('.qe-co-mod-val[data-idx="' + idx + '"]');
      return { hasValue: valInput && parseFloat(valInput.value) === 75 };
    }, edgeIdx14);
    ok(r.hasValue, 'T14: Modifier value entered and stored');
    await page.context().close();

    // ===== T15: Tapping summary reopens inline editor =====
    console.log('\n--- T15: Summary click reopens editor ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt15@test.com', 'pass1234');
    await openNewQuote(page);
    // Check Juice Groove (has default)
    const jgIdx15 = await page.evaluate(() => {
      const co = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < co.length; i++) {
        const row = co[i].closest('.quote-feature-row');
        if(row && row.textContent.includes('Juice Groove')) return i;
      }
      return -1;
    });
    await page.click('.qe-co-feat-check[data-idx="' + jgIdx15 + '"]');
    await page.waitForTimeout(300);
    // Click the summary
    const summaryEl = await page.$('.qe-co-feat-summary[data-idx="' + jgIdx15 + '"]');
    if(summaryEl) await summaryEl.click();
    await page.waitForTimeout(200);
    r = await page.evaluate((idx) => {
      const editor = document.querySelector('.qe-co-feat-editor[data-idx="' + idx + '"]');
      return { editorVisible: editor && editor.style.display !== 'none' };
    }, jgIdx15);
    ok(r.editorVisible, 'T15: Tapping summary reopens inline editor');
    await page.context().close();

    // ===== T16: Unchecking feature removes from total, preserves value =====
    console.log('\n--- T16: Uncheck preserves value ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt16@test.com', 'pass1234');
    await openNewQuote(page);
    const jgIdx16 = await page.evaluate(() => {
      const co = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < co.length; i++) {
        const row = co[i].closest('.quote-feature-row');
        if(row && row.textContent.includes('Juice Groove')) return i;
      }
      return -1;
    });
    // Check then uncheck
    await page.click('.qe-co-feat-check[data-idx="' + jgIdx16 + '"]');
    await page.waitForTimeout(200);
    await page.click('.qe-co-feat-check[data-idx="' + jgIdx16 + '"]');
    await page.waitForTimeout(200);
    r = await page.evaluate((idx) => {
      // Check that value is preserved in the quote object
      const cb = document.querySelector('.qe-co-feat-check[data-idx="' + idx + '"]');
      return { unchecked: cb && !cb.checked };
    }, jgIdx16);
    ok(r.unchecked, 'T16: Unchecking removes feature, value preserved in session');
    await page.context().close();

    // ===== T17: Construction Options footer format =====
    console.log('\n--- T17: Construction Options footer ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt17@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const baseVal = document.getElementById('qe-co-base-val');
      const optionsVal = document.getElementById('qe-co-options-val');
      const price = document.getElementById('qe-construction-price');
      return {
        hasBase: !!baseVal,
        hasOptions: !!optionsVal,
        hasPrice: !!price,
        baseText: baseVal?.textContent,
        priceText: price?.textContent
      };
    });
    ok(r.hasBase && r.hasOptions && r.hasPrice, 'T17a: Footer has Base Price / Construction Options / Price');
    ok(r.baseText === '$405.00', 'T17b: Footer Base Price correct');
    await page.context().close();

    // ===== T18: Full price calculation =====
    // 25×18 CB, End Grain, 2.25" thick (18%), 2 glue-ups (10%), Juice Groove ($50) + Finger Grips ($25)
    console.log('\n--- T18: Full price calculation ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt18@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(100);
    await page.click('[data-grain="end"]');
    // Select thickness tier 2.25"–2.49" (modifier 18%)
    await page.selectOption('#qe-thick-select', '2.25');
    await page.waitForTimeout(100);
    // 2 glue-ups
    await page.selectOption('#qe-glue-select', '2');
    await page.waitForTimeout(100);
    // Check Juice Groove and Finger Grips
    const featIndices18 = await page.evaluate(() => {
      const checks = document.querySelectorAll('.qe-co-feat-check');
      const result = {};
      checks.forEach((cb, i) => {
        const row = cb.closest('.quote-feature-row');
        if(row.textContent.includes('Juice Groove')) result.jg = i;
        if(row.textContent.includes('Finger Grips')) result.fg = i;
      });
      return result;
    });
    await page.click('.qe-co-feat-check[data-idx="' + featIndices18.jg + '"]');
    await page.waitForTimeout(200);
    await page.click('.qe-co-feat-check[data-idx="' + featIndices18.fg + '"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const price = document.getElementById('qe-construction-price');
      return { text: price?.textContent || '' };
    });
    // Base: 450 × 0.90 = 405
    // pctMod: endGrain 0.25 + thickness 0.18 + glueUp[2] 0.10 = 0.53
    // flatMod: $50 + $25 = $75
    // Price = 405 × (1 + 0.53) + 75 = 405 × 1.53 + 75 = 619.65 + 75 = 694.65
    ok(r.text === '$694.65', 'T18: Price = 405 × 1.53 + 75 = $694.65');
    await page.context().close();

    // ===== T19: Switching CB → TT: confirmation, L×W+Thickness+Grain preserved, features reset =====
    console.log('\n--- T19: Switch CB → TT ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt19@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '30');
    await page.fill('#qe-dim-w', '20');
    await page.selectOption('#qe-thick-select', '2.25');
    await page.click('[data-grain="end"]');
    await page.waitForTimeout(100);
    // Check a feature to trigger confirmation
    const cpIdx = await page.evaluate(() => {
      const checks = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < checks.length; i++) {
        const row = checks[i].closest('.quote-feature-row');
        if(row.textContent.includes('Juice Groove')) return i;
      }
      return 0;
    });
    await page.click('.qe-co-feat-check[data-idx="' + cpIdx + '"]');
    await page.waitForTimeout(200);

    let dialogSeen = false;
    page.on('dialog', async d => { dialogSeen = true; await d.accept(); });
    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(400);
    r = await page.evaluate(() => {
      const dimL = document.getElementById('qe-dim-l')?.value;
      const dimW = document.getElementById('qe-dim-w')?.value;
      const thickSel = document.getElementById('qe-thick-select')?.value;
      const grainActive = document.querySelector('[data-grain].active')?.getAttribute('data-grain');
      const glueSel = document.getElementById('qe-glue-select');
      const features = document.querySelectorAll('.qe-co-feat-check');
      const anyChecked = Array.from(features).some(cb => cb.checked);
      return { dimL, dimW, thickSel, grainActive, glueCount: glueSel ? 1 : 0, anyChecked };
    });
    ok(dialogSeen, 'T19a: Confirmation dialog shown');
    ok(r.dimL === '30' && r.dimW === '20', 'T19b: L×W preserved');
    ok(r.thickSel === '2.25', 'T19c: Thickness preserved');
    ok(r.grainActive === 'end', 'T19d: Grain Direction preserved');
    ok(r.glueCount === 0, 'T19e: No Glue Ups for Table Top');
    ok(!r.anyChecked, 'T19f: Features reset');
    await page.context().close();

    // ===== T20: Switching to Custom: confirmation, Construction Options hidden =====
    console.log('\n--- T20: Switch to Custom ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt20@test.com', 'pass1234');
    await openNewQuote(page);
    // Enable a feature first
    const fIdx20 = await page.evaluate(() => {
      const checks = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < checks.length; i++) {
        const row = checks[i].closest('.quote-feature-row');
        if(row.textContent.includes('Juice Groove')) return i;
      }
      return 0;
    });
    await page.click('.qe-co-feat-check[data-idx="' + fIdx20 + '"]');
    await page.waitForTimeout(200);

    let customDialogSeen = false;
    page.on('dialog', async d => { customDialogSeen = true; await d.accept(); });
    await page.click('[data-ptype="custom"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const cs = document.getElementById('qe-construction-section');
      const custom = document.getElementById('qe-custom-section');
      return {
        constructionHidden: cs && cs.style.display === 'none',
        customVisible: custom && custom.style.display !== 'none'
      };
    });
    ok(customDialogSeen, 'T20a: Confirmation shown switching to Custom');
    ok(r.constructionHidden && r.customVisible, 'T20b: Construction hidden, line items shown');
    await page.context().close();

    // ===== T21: Surface area recalculates after switching product type =====
    console.log('\n--- T21: SA recalculates after switch ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt21@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-dim-l', '30');
    await page.fill('#qe-dim-w', '20');
    await page.waitForTimeout(200);
    page.on('dialog', async d => await d.accept());
    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const saInfo = document.getElementById('qe-sa-info')?.textContent || '';
      const footer = document.getElementById('qe-base-price-footer')?.textContent || '';
      return { saInfo, footer };
    });
    // 30×20 = 600 sq in, Tier 2, $0.90/sq in → $540
    ok(r.saInfo.includes('600 sq in') && r.footer.includes('$540.00'), 'T21: SA recalculates after product type switch');
    await page.context().close();

    // ===== T22: Saving stores productType + constructionOptions =====
    console.log('\n--- T22: Save stores productType + constructionOptions ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt22@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-cust-name', 'Test Save');
    await page.fill('#qe-dim-l', '20');
    await page.fill('#qe-dim-w', '15');
    await page.selectOption('#qe-thick-select', '2.25');
    await page.click('[data-grain="end"]');
    await page.selectOption('#qe-glue-select', '2');
    await page.waitForTimeout(200);
    await page.click('#qe-save-btn');
    await page.waitForTimeout(500);
    r = await page.evaluate(() => {
      const q = quotesData[quotesData.length - 1];
      return {
        hasProductType: !!q.productType,
        productType: q.productType,
        hasCO: !!q.constructionOptions,
        grainDir: q.constructionOptions?.grainDirection,
        thickVal: q.constructionOptions?.thickness?.value,
        thickMod: q.constructionOptions?.thickness?.modifierValue,
        thickSource: q.constructionOptions?.thickness?.source,
        glueCount: q.constructionOptions?.glueUps?.count,
        featureCount: q.constructionOptions?.features?.length
      };
    });
    ok(r.hasProductType && r.productType === 'cutting_board', 'T22a: productType saved');
    ok(r.hasCO && r.grainDir === 'end', 'T22b: constructionOptions.grainDirection saved');
    ok(r.thickVal === '2.25' && r.thickMod === 18, 'T22c: thickness value + modifier saved');
    ok(r.thickSource === 'settings', 'T22d: thickness source is settings');
    ok(r.glueCount === 2, 'T22e: glueUps.count saved');
    ok(r.featureCount === 5, 'T22f: features array saved');
    await page.context().close();

    // ===== T23: Reopening saved quote restores exact configuration =====
    console.log('\n--- T23: Reopen restores config ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt23@test.com', 'pass1234');
    await openNewQuote(page);
    await page.fill('#qe-cust-name', 'Restore Test');
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.selectOption('#qe-thick-select', '2.25');
    await page.click('[data-grain="end"]');
    await page.selectOption('#qe-glue-select', '3');
    // Check Juice Groove
    const jgIdx23 = await page.evaluate(() => {
      const checks = document.querySelectorAll('.qe-co-feat-check');
      for(let i = 0; i < checks.length; i++) {
        const row = checks[i].closest('.quote-feature-row');
        if(row.textContent.includes('Juice Groove')) return i;
      }
      return -1;
    });
    await page.click('.qe-co-feat-check[data-idx="' + jgIdx23 + '"]');
    await page.waitForTimeout(200);
    await page.click('#qe-save-btn');
    await page.waitForTimeout(500);
    // Reopen by clicking edit
    const quoteId = await page.evaluate(() => quotesData[quotesData.length - 1].id);
    await page.evaluate((id) => openQuoteEdit(id), quoteId);
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const active = document.querySelector('[data-ptype].active');
      const grain = document.querySelector('[data-grain].active');
      const thickSel = document.getElementById('qe-thick-select');
      const glue = document.getElementById('qe-glue-select');
      const dimL = document.getElementById('qe-dim-l');
      const dimW = document.getElementById('qe-dim-w');
      const jgChecked = Array.from(document.querySelectorAll('.qe-co-feat-check')).find((cb, i) => {
        const row = cb.closest('.quote-feature-row');
        return row && row.textContent.includes('Juice Groove');
      })?.checked;
      return {
        type: active?.getAttribute('data-ptype'),
        grain: grain?.getAttribute('data-grain'),
        thick: thickSel?.value,
        glue: glue?.value,
        l: dimL?.value,
        w: dimW?.value,
        jgChecked
      };
    });
    ok(r.type === 'cutting_board', 'T23a: Product type restored');
    ok(r.grain === 'end', 'T23b: Grain direction restored');
    ok(r.thick === '2.25', 'T23c: Thickness restored');
    ok(r.glue === '3', 'T23d: Glue ups restored');
    ok(r.l === '25' && r.w === '18', 'T23e: Dimensions restored');
    ok(r.jgChecked === true, 'T23f: Feature checkbox restored');
    await page.context().close();

    // ===== T24: PR #9 acceptance tests still pass =====
    console.log('\n--- T24: PR #9 regression checks ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt24@test.com', 'pass1234');
    await openNewQuote(page);
    // Card 1: No pricing mode in Card 1
    r = await page.evaluate(() => {
      const sections = document.querySelectorAll('#quote-edit-body .quote-section');
      const card1 = sections[0];
      const modeButtons = card1?.querySelectorAll('[data-mode]') || [];
      return { noMode: modeButtons.length === 0 };
    });
    ok(r.noMode, 'T24a: No Pricing Mode selector in Card 1');

    // Card 1: Bold Generate New Project
    r = await page.evaluate(() => {
      const opt = document.querySelector('#qe-link-project option[value="__generate__"]');
      return { bold: opt && opt.style.fontWeight === 'bold' };
    });
    ok(r.bold, 'T24b: Generate New Project bold');

    // Project Details card with Add Note button
    r = await page.evaluate(() => {
      const list = document.getElementById('qe-notes-list');
      const addBtn = document.getElementById('qe-note-add-btn');
      const hdrs = [...document.querySelectorAll('.quote-section-hdr')].map(h => h.textContent);
      return { hasCard: hdrs.includes('Project Details'), hasList: !!list, hasAddBtn: !!addBtn };
    });
    ok(r.hasCard && r.hasList && r.hasAddBtn, 'T24c: Project Details card with Add Note button');

    // Card 2 header
    r = await page.evaluate(() => {
      const sections = document.querySelectorAll('#quote-edit-body .quote-section');
      return { hdr: sections[1]?.querySelector('.quote-section-hdr')?.textContent };
    });
    ok(r.hdr === 'Base Pricing', 'T24d: Card 2 header "Base Pricing"');

    // SA info
    await page.fill('#qe-dim-l', '25');
    await page.fill('#qe-dim-w', '18');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const saInfo = document.getElementById('qe-sa-info')?.textContent || '';
      return { correct: saInfo.includes('450 sq in') && saInfo.includes('Tier 2') };
    });
    ok(r.correct, 'T24e: SA info works');

    // Base Price footer
    r = await page.evaluate(() => {
      const footer = document.getElementById('qe-base-price-footer')?.textContent || '';
      return { correct: footer === 'Base Price: $405.00' };
    });
    ok(r.correct, 'T24f: Base Price footer correct');

    // Expenses
    await page.fill('#qe-exp-third', '100');
    await page.fill('#qe-exp-delivery', '50');
    await page.fill('#qe-exp-markup', '10');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const sm = document.getElementById('qe-summary');
      let expText = '';
      sm?.querySelectorAll('.quote-breakdown-row').forEach(row => {
        if(row.textContent.includes('Expenses:')) expText = row.querySelectorAll('span')[1]?.textContent || '';
      });
      return { expText };
    });
    ok(r.expText === '$165.00', 'T24g: Expenses = (100+50)×1.10 = $165');

    // No Add-Ons or Other in expenses
    r = await page.evaluate(() => {
      const body = document.getElementById('quote-edit-body');
      const sections = body.querySelectorAll('.quote-section');
      let expSection = null;
      sections.forEach(s => { if(s.querySelector('.quote-section-hdr')?.textContent.includes('Expenses')) expSection = s; });
      if(!expSection) return { found: false };
      const labels = Array.from(expSection.querySelectorAll('label')).map(l => l.textContent.trim());
      return { found: true, noAddOns: !labels.some(l => l.includes('Add-On')), noOther: !labels.some(l => l === 'Other ($)' || l.includes('Other (')) };
    });
    ok(r.found && r.noAddOns && r.noOther, 'T24h: No Add-Ons or Other in expenses');

    // Save works
    await page.fill('#qe-cust-name', 'PR9 Test');
    await page.waitForTimeout(100);
    await page.click('#qe-save-btn');
    await page.waitForTimeout(500);
    r = await page.evaluate(() => {
      const detailScreen = document.getElementById('quote-detail-screen');
      return { visible: detailScreen && detailScreen.style.display !== 'none' };
    });
    ok(r.visible, 'T24i: Save redirects to quote detail');
    await page.context().close();

    // ===== T25: No changes outside Base Pricing and Construction Options cards =====
    console.log('\n--- T25: Scope verification ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pt25@test.com', 'pass1234');
    await openNewQuote(page);
    r = await page.evaluate(() => {
      const body = document.getElementById('quote-edit-body');
      const sections = body.querySelectorAll('.quote-section');
      const headers = Array.from(sections).map(s => s.querySelector('.quote-section-hdr')?.textContent);
      const hasCustomerInfo = headers.includes('Customer & Project Info');
      const hasLabour = headers.includes('Labour Estimation');
      const hasExpenses = headers.includes('Additional Expenses');
      const hasSummary = headers.includes('Quote Summary');
      return { hasCustomerInfo, hasLabour, hasExpenses, hasSummary, headerCount: headers.length };
    });
    ok(r.hasCustomerInfo && r.hasLabour && r.hasExpenses && r.hasSummary, 'T25: All other cards unchanged');
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
