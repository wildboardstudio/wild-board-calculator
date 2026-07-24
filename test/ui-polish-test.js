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

  try {
    // ===== T1: Calculate Lumber card shows ruler-dimension-line icon, content centered =====
    console.log('\n--- T1: Calculate Lumber card icon + centered ---');
    await resetMock();
    let page = await freshPage();
    let r = await page.evaluate(() => {
      const btn = document.getElementById('start-btn');
      if(!btn) return { exists: false };
      const icon = btn.querySelector('.landing-cta-icon svg');
      const hasRulerPaths = icon && icon.querySelector('rect[x="2"][y="12"]') !== null;
      const style = getComputedStyle(btn);
      const centered = style.textAlign === 'center' || style.alignItems === 'center';
      return { exists: true, hasIcon: !!icon, hasRulerPaths, centered };
    });
    ok(r.exists && r.hasIcon && r.hasRulerPaths, 'T1: Calculate Lumber card shows ruler icon');
    ok(r.centered, 'T1: Calculate Lumber card content centered');
    await page.context().close();

    // ===== T2: Sign In / Create Account card content centered =====
    console.log('\n--- T2: Sign In card centered ---');
    page = await freshPage();
    r = await page.evaluate(() => {
      const btn = document.getElementById('landing-account-btn');
      if(!btn) return { exists: false };
      const style = getComputedStyle(btn);
      const centered = style.textAlign === 'center' || style.alignItems === 'center';
      return { exists: true, centered };
    });
    ok(r.exists && r.centered, 'T2: Sign In card content centered');
    await page.context().close();

    // ===== T3: Home button present in global header on all screens =====
    console.log('\n--- T3: Home button present on all screens ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test@test.com', 'Test1234!');

    // Check app-screen header (after clicking Calculate Lumber)
    await page.click('#start-btn');
    await page.waitForSelector('#app-screen', { state: 'visible', timeout: 3000 });
    let homeVisible = await page.evaluate(() => {
      const header = document.getElementById('app-header');
      const homeBtn = header ? header.querySelector('.gh-home-btn') : null;
      return homeBtn && getComputedStyle(homeBtn).display !== 'none';
    });
    ok(homeVisible, 'T3a: Home button on app-screen');

    // Check saved-screen
    await page.evaluate(() => { showSaved(); });
    await page.waitForTimeout(200);
    homeVisible = await page.evaluate(() => {
      const header = document.querySelector('#saved-screen .global-header, [id="saved-header"]');
      const homeBtn = header ? header.querySelector('.gh-home-btn') : null;
      return homeBtn && getComputedStyle(homeBtn).display !== 'none';
    });
    ok(homeVisible, 'T3b: Home button on saved-screen');

    // Check shop-screen
    await page.evaluate(() => { showShop(); });
    await page.waitForTimeout(200);
    homeVisible = await page.evaluate(() => {
      const header = document.querySelector('#shop-screen .global-header, [id="shop-header"]');
      const homeBtn = header ? header.querySelector('.gh-home-btn') : null;
      return homeBtn && getComputedStyle(homeBtn).display !== 'none';
    });
    ok(homeVisible, 'T3c: Home button on shop-screen');

    // Check settings-screen
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(200);
    homeVisible = await page.evaluate(() => {
      const header = document.querySelector('#settings-screen .global-header, [id="settings-header"]');
      const homeBtn = header ? header.querySelector('.gh-home-btn') : null;
      return homeBtn && getComputedStyle(homeBtn).display !== 'none';
    });
    ok(homeVisible, 'T3d: Home button on settings-screen');

    // Check projects-screen
    await page.evaluate(() => { showProjects(); });
    await page.waitForTimeout(200);
    homeVisible = await page.evaluate(() => {
      const header = document.querySelector('#projects-screen .global-header, [id="projects-header"]');
      const homeBtn = header ? header.querySelector('.gh-home-btn') : null;
      return homeBtn && getComputedStyle(homeBtn).display !== 'none';
    });
    ok(homeVisible, 'T3e: Home button on projects-screen');

    // Check quotes-screen
    await page.evaluate(() => { showQuotes(); });
    await page.waitForTimeout(200);
    homeVisible = await page.evaluate(() => {
      const header = document.querySelector('#quotes-screen .global-header, [id="quotes-header"]');
      const homeBtn = header ? header.querySelector('.gh-home-btn') : null;
      return homeBtn && getComputedStyle(homeBtn).display !== 'none';
    });
    ok(homeVisible, 'T3f: Home button on quotes-screen');
    await page.context().close();

    // ===== T4: Home button always returns to landing page =====
    console.log('\n--- T4: Home button returns to landing ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'home@test.com', 'Test1234!');
    // Navigate to app screen
    await page.click('#start-btn');
    await page.waitForSelector('#app-screen', { state: 'visible', timeout: 3000 });
    // Click home
    await page.click('#app-header .gh-home-btn');
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const landing = document.getElementById('landing-screen');
      return landing && getComputedStyle(landing).display !== 'none';
    });
    ok(r, 'T4: Home button returns to landing from app screen');
    await page.context().close();

    // ===== T5 & T6: Project ↔ Quote bidirectional linking =====
    console.log('\n--- T5/T6: Project ↔ Quote linking ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'link@test.com', 'Test1234!');

    // Create a project
    await page.evaluate(() => { showProjects(); });
    await page.waitForTimeout(200);
    await page.click('#projects-add-btn');
    await page.waitForSelector('#project-modal', { state: 'visible', timeout: 3000 });
    await page.fill('#proj-name-input', 'Test Project');
    await page.click('#proj-modal-save');
    await page.waitForTimeout(500);

    // Create a quote linked to the project
    await page.evaluate(() => { showQuotes(); });
    await page.waitForTimeout(200);
    await page.click('#quotes-add-btn');
    await page.waitForTimeout(500);
    await page.fill('#qe-cust-name', 'Test Customer');
    await page.fill('#qe-email', 'customer@test.com');
    // Link project
    const projSelect = await page.$('#qe-link-project');
    if(projSelect) {
      const options = await page.evaluate(() => {
        const sel = document.getElementById('qe-link-project');
        return sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.text })) : [];
      });
      const projOption = options.find(o => o.text.includes('Test Project'));
      if(projOption) await page.selectOption('#qe-link-project', projOption.value);
    }
    await page.click('#qe-save-btn');
    await page.waitForTimeout(500);

    // Now check quote detail for linked project card
    const hasLinkedProjCard = await page.evaluate(() => {
      const row = document.getElementById('quote-linked-proj-row');
      return !!row;
    });
    ok(hasLinkedProjCard, 'T6: Quote Detail shows Linked Project card');

    // Navigate to project from quote
    if(hasLinkedProjCard) {
      await page.click('#quote-linked-proj-row');
      await page.waitForTimeout(300);
      const onProjDetail = await page.evaluate(() => {
        const el = document.getElementById('project-detail-screen');
        return el && getComputedStyle(el).display !== 'none';
      });
      ok(onProjDetail, 'T6b: Clicking linked project navigates to project detail');

      // T8: Back from project returns to quote
      await page.click('#proj-detail-back-btn');
      await page.waitForTimeout(300);
      const backToQuote = await page.evaluate(() => {
        const el = document.getElementById('quote-detail-screen');
        return el && getComputedStyle(el).display !== 'none';
      });
      ok(backToQuote, 'T8: Back from Project (entered from Quote) returns to Quote');
    } else {
      ok(false, 'T6b: Clicking linked project navigates to project detail (skipped - no card)');
      ok(false, 'T8: Back from Project (entered from Quote) returns to Quote (skipped)');
    }

    // Navigate to project detail to check for linked quote card
    await page.evaluate(() => { showProjects(); });
    await page.waitForTimeout(200);
    await page.click('.proj-card');
    await page.waitForTimeout(300);
    const hasLinkedQuoteCard = await page.evaluate(() => {
      const card = document.getElementById('proj-linked-quote-card');
      return !!card;
    });
    ok(hasLinkedQuoteCard, 'T5: Project Detail shows Linked Quote card');

    // T7: Navigate to quote from project and back
    if(hasLinkedQuoteCard) {
      await page.click('#proj-linked-quote-row');
      await page.waitForTimeout(300);
      const onQuoteDetail = await page.evaluate(() => {
        const el = document.getElementById('quote-detail-screen');
        return el && getComputedStyle(el).display !== 'none';
      });
      ok(onQuoteDetail, 'T5b: Clicking linked quote navigates to quote detail');

      await page.click('#quote-detail-back-btn');
      await page.waitForTimeout(300);
      const backToProject = await page.evaluate(() => {
        const el = document.getElementById('project-detail-screen');
        return el && getComputedStyle(el).display !== 'none';
      });
      ok(backToProject, 'T7: Back from Quote (entered from Project) returns to Project');
    } else {
      ok(false, 'T5b: Clicking linked quote navigates to quote detail (skipped)');
      ok(false, 'T7: Back from Quote (entered from Project) returns to Project (skipped)');
    }
    await page.context().close();

    // ===== T9: Landing page blank bug =====
    console.log('\n--- T9: Landing page blank bug ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'nav@test.com', 'Test1234!');
    const screens = ['start-btn', 'settings', 'projects', 'quotes', 'shop'];
    let allLandingOk = true;
    for(const screen of screens) {
      if(screen === 'start-btn') {
        await page.click('#start-btn');
        await page.waitForTimeout(200);
        await page.click('#app-header .gh-home-btn');
      } else if(screen === 'settings') {
        await page.evaluate(() => { showSettings(); });
        await page.waitForTimeout(200);
        await page.click('#settings-back-btn');
      } else if(screen === 'projects') {
        await page.evaluate(() => { showProjects(); });
        await page.waitForTimeout(200);
        await page.click('#projects-back-btn');
      } else if(screen === 'quotes') {
        await page.evaluate(() => { showQuotes(); });
        await page.waitForTimeout(200);
        await page.click('#quotes-back-btn');
      } else if(screen === 'shop') {
        await page.evaluate(() => { showShop(); });
        await page.waitForTimeout(200);
        await page.click('#shop-back-btn');
      }
      await page.waitForTimeout(300);
      const landingVisible = await page.evaluate(() => {
        const landing = document.getElementById('landing-screen');
        return landing && getComputedStyle(landing).display !== 'none';
      });
      if(!landingVisible) { allLandingOk = false; console.log('    FAIL on screen: ' + screen); }
    }
    ok(allLandingOk, 'T9: Landing page visible after navigating back from all 5 screens');
    await page.context().close();

    // ===== T10: My Account email field read-only + Change Email button =====
    console.log('\n--- T10: My Account email read-only + Change Email ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'acct@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    // Expand My Account
    await page.click('.settings-collapse-hdr[data-section="account"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const acctBody = document.querySelector('.settings-collapse-body[data-section="account"]');
      const emailInputs = acctBody ? acctBody.querySelectorAll('input[type="text"][disabled]') : [];
      const emailDisabled = emailInputs.length > 0;
      const changeBtn = document.getElementById('set-change-email-btn');
      return {
        emailReadonly: emailDisabled,
        hasChangeBtn: !!changeBtn
      };
    });
    ok(r.emailReadonly, 'T10a: Email field is read-only');
    ok(r.hasChangeBtn, 'T10b: Change Email button present');
    await page.context().close();

    // ===== T11: Change Email modal =====
    console.log('\n--- T11: Change Email modal ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'change@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="account"]');
    await page.waitForTimeout(200);
    await page.click('#set-change-email-btn');
    await page.waitForTimeout(200);
    let modalOpen = await page.evaluate(() => {
      const modal = document.getElementById('change-email-modal');
      return modal && modal.classList.contains('open');
    });
    ok(modalOpen, 'T11a: Change Email modal opens');
    // Fill in email and send
    await page.fill('#change-email-input', 'new@test.com');
    await page.click('#change-email-send-btn');
    await page.waitForTimeout(500);
    const msgText = await page.evaluate(() => {
      const msg = document.getElementById('change-email-msg');
      return msg ? msg.textContent : '';
    });
    ok(msgText.includes('verification') || msgText.includes('Verification'), 'T11b: Shows verification confirmation');
    await page.context().close();

    // ===== T12: Username and Company Name fields have no placeholder =====
    console.log('\n--- T12: No placeholder on username/company ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'noplaceholder@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="account"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const u = document.getElementById('set-username');
      const c = document.getElementById('set-company-name');
      return {
        usernamePlaceholder: u ? u.getAttribute('placeholder') || '' : '',
        companyPlaceholder: c ? c.getAttribute('placeholder') || '' : ''
      };
    });
    ok(!r.usernamePlaceholder && !r.companyPlaceholder, 'T12: No placeholder on Username and Company Name');
    await page.context().close();

    // ===== T13: Settings opens with all sections collapsed =====
    console.log('\n--- T13: Settings all collapsed by default ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'collapsed@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    r = await page.evaluate(() => {
      const headers = document.querySelectorAll('.settings-collapse-hdr');
      const anyExpanded = Array.from(headers).some(h => h.classList.contains('expanded'));
      return { count: headers.length, anyExpanded };
    });
    ok(r.count >= 2 && !r.anyExpanded, 'T13: All sections collapsed by default');
    await page.context().close();

    // ===== T14: Tapping section header expands/collapses =====
    console.log('\n--- T14: Section toggle ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'toggle@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    // Click account header to expand
    await page.click('.settings-collapse-hdr[data-section="account"]');
    await page.waitForTimeout(200);
    let expanded = await page.evaluate(() => {
      return document.querySelector('.settings-collapse-hdr[data-section="account"]').classList.contains('expanded');
    });
    ok(expanded, 'T14a: Section expands on click');
    // Click again to collapse
    await page.click('.settings-collapse-hdr[data-section="account"]');
    await page.waitForTimeout(200);
    expanded = await page.evaluate(() => {
      return document.querySelector('.settings-collapse-hdr[data-section="account"]').classList.contains('expanded');
    });
    ok(!expanded, 'T14b: Section collapses on second click');
    await page.context().close();

    // ===== T15: Single Save button saves all to Supabase =====
    console.log('\n--- T15: Single Save button ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'save@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    const hasSaveBtn = await page.evaluate(() => {
      const btn = document.getElementById('settings-save-btn');
      return btn && getComputedStyle(btn).display !== 'none';
    });
    ok(hasSaveBtn, 'T15: Save button present at bottom of Settings');
    await page.context().close();

    // ===== T16/T17: "How does pricing work?" button =====
    console.log('\n--- T16/T17: Pricing explainer button ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pricing@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    // Expand pricing section
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const btn = document.getElementById('pricing-explainer-open');
      if(!btn) return { exists: false };
      const style = getComputedStyle(btn);
      const isButton = btn.tagName === 'BUTTON' || style.cursor === 'pointer';
      return { exists: true, isButton, text: btn.textContent.trim() };
    });
    ok(r.exists && r.text.includes('How does pricing work'), 'T16: "How does pricing work?" button visible');
    // Click it
    if(r.exists) {
      await page.click('#pricing-explainer-open');
      await page.waitForTimeout(200);
      const modalOpen2 = await page.evaluate(() => {
        const m = document.getElementById('pricing-explainer-modal');
        return m && m.classList.contains('open');
      });
      ok(modalOpen2, 'T17: Clicking "How does pricing work?" opens modal');
    } else {
      ok(false, 'T17: Pricing explainer modal (skipped)');
    }
    await page.context().close();

    // ===== T18: "Labor" spelled correctly =====
    console.log('\n--- T18: Labor spelling ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'labor@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const body = document.getElementById('settings-body');
      const text = body ? body.textContent : '';
      const hasLabor = text.includes('Labor');
      const hasLabour = /Labour/i.test(text);
      return { hasLabor, hasLabour };
    });
    ok(r.hasLabor && !r.hasLabour, 'T18: "Labor" spelled correctly (not "Labour") in Settings');
    await page.context().close();

    // ===== T19: Labor Rates fields are compact width =====
    console.log('\n--- T19: Labor rates compact width ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'compact@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="labor"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const shopRate = document.getElementById('set-shop-rate');
      const empRate = document.getElementById('set-employee-rate');
      const shopW = shopRate ? shopRate.offsetWidth : 999;
      const empW = empRate ? empRate.offsetWidth : 999;
      return { shopW, empW };
    });
    ok(r.shopW <= 200 && r.empW <= 200, 'T19: Labor rate fields are compact (not full width)');
    await page.context().close();

    // ===== T20: Surface Area Pricing Tiers header label =====
    console.log('\n--- T20: Surface Area Pricing Tiers label ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'salabel@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="surface"]');
      return hdr ? hdr.textContent.trim() : '';
    });
    ok(r.includes('Surface Area Pricing Tiers'), 'T20: Sub-section header labeled "Surface Area Pricing Tiers"');
    await page.context().close();

    // ===== T21: Label column text centered in SA tiers table =====
    console.log('\n--- T21: Label column centered ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'center@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="surface"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const labelInput = document.querySelector('.set-sa-label');
      if(!labelInput) return { centered: false };
      const style = getComputedStyle(labelInput);
      return { centered: style.textAlign === 'center' };
    });
    ok(r.centered, 'T21: Label column text is centered');
    await page.context().close();

    // ===== T22: Base Total column (not "Example") shows correct calculation =====
    console.log('\n--- T22: Base Total column ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'basetotal@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="surface"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const table = document.querySelector('.settings-sub-collapse-body[data-sub="surface"] table');
      if(!table) return { hasBaseTotal: false };
      const headers = Array.from(table.querySelectorAll('th')).map(h => h.textContent.trim());
      const hasBaseTotal = headers.includes('Base Total');
      const hasExample = headers.includes('Example');
      return { hasBaseTotal, hasExample };
    });
    ok(r.hasBaseTotal && !r.hasExample, 'T22: Column named "Base Total" (not "Example")');
    await page.context().close();

    // ===== T23: Tier boundaries — no gap, no overlap =====
    console.log('\n--- T23: Tier boundaries ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'boundaries@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="surface"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const s = typeof _getSettings === 'function' ? _getSettings() : null;
      if(!s || !s.surfaceAreaTiers) return { valid: false };
      const tiers = s.surfaceAreaTiers;
      let valid = true;
      for(let i = 1; i < tiers.length; i++) {
        const prevMax = tiers[i - 1].max;
        const currMin = tiers[i].min;
        if(prevMax !== currMin) { valid = false; break; }
      }
      return { valid, count: tiers.length };
    });
    ok(r.valid, 'T23: Tier N min = Tier (N-1) max exactly');
    await page.context().close();

    // ===== T24: Add/remove SA tiers =====
    console.log('\n--- T24: Add/remove SA tiers ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'addrem@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="surface"]');
    await page.waitForTimeout(200);
    // Count initial tiers
    let initialCount = await page.evaluate(() => document.querySelectorAll('.set-sa-label').length);
    // Add a tier
    await page.click('#set-sa-add');
    await page.waitForTimeout(300);
    let afterAddCount = await page.evaluate(() => document.querySelectorAll('.set-sa-label').length);
    ok(afterAddCount === initialCount + 1, 'T24a: Add tier works');
    // Remove a tier
    const delBtn = await page.$('.set-sa-del');
    if(delBtn) {
      await delBtn.click();
      await page.waitForTimeout(300);
      let afterDelCount = await page.evaluate(() => document.querySelectorAll('.set-sa-label').length);
      ok(afterDelCount === afterAddCount - 1, 'T24b: Remove tier works');
    } else {
      ok(false, 'T24b: Remove tier (no delete button found)');
    }
    // Minimum 1 tier check
    r = await page.evaluate(() => {
      const tiers = document.querySelectorAll('.set-sa-label');
      const delBtns = document.querySelectorAll('.set-sa-del');
      return { tiers: tiers.length, delBtns: delBtns.length };
    });
    // When there's only 1 tier, no delete button should appear
    while(r.tiers > 1) {
      await page.click('.set-sa-del');
      await page.waitForTimeout(300);
      r = await page.evaluate(() => ({ tiers: document.querySelectorAll('.set-sa-label').length, delBtns: document.querySelectorAll('.set-sa-del').length }));
    }
    ok(r.tiers >= 1 && r.delBtns === 0, 'T24c: Minimum 1 tier enforced');
    await page.context().close();

    // ===== T25: Thickness tier range boundaries editable =====
    console.log('\n--- T25: Thickness tier boundaries editable ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'thickedit@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="thickness"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const minInputs = document.querySelectorAll('.set-thick-min');
      const maxInputs = document.querySelectorAll('.set-thick-max');
      let allEditable = true;
      minInputs.forEach(inp => { if(inp.hasAttribute('readonly') || inp.hasAttribute('disabled')) allEditable = false; });
      maxInputs.forEach(inp => { if(inp.hasAttribute('readonly') || inp.hasAttribute('disabled')) allEditable = false; });
      return { minCount: minInputs.length, maxCount: maxInputs.length, allEditable };
    });
    ok(r.minCount > 0 && r.maxCount > 0 && r.allEditable, 'T25: Thickness tier boundaries are editable');
    await page.context().close();

    // ===== T26: Add/remove thickness tiers =====
    console.log('\n--- T26: Add/remove thickness tiers ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'thickaddrem@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="thickness"]');
    await page.waitForTimeout(200);
    initialCount = await page.evaluate(() => document.querySelectorAll('.set-thick-min').length);
    await page.click('#set-thick-add');
    await page.waitForTimeout(300);
    afterAddCount = await page.evaluate(() => document.querySelectorAll('.set-thick-min').length);
    ok(afterAddCount === initialCount + 1, 'T26a: Add thickness tier works');
    // Remove
    const thickDel = await page.$('.set-thick-del');
    if(thickDel) {
      await thickDel.click();
      await page.waitForTimeout(300);
      const afterDel = await page.evaluate(() => document.querySelectorAll('.set-thick-min').length);
      ok(afterDel === afterAddCount - 1, 'T26b: Remove thickness tier works');
    } else {
      ok(false, 'T26b: Remove thickness tier (no delete button)');
    }
    await page.context().close();

    // ===== T27: Default thickness tiers end at 3.75–3.99" =====
    console.log('\n--- T27: Default thickness tiers cutoff ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'thickdefault@test.com', 'Test1234!');
    r = await page.evaluate(() => {
      const s = typeof getDefaultSettings === 'function' ? getDefaultSettings() : null;
      if(!s || !s.thicknessTiers) return { valid: false };
      const tiers = s.thicknessTiers;
      const last = tiers[tiers.length - 1];
      return { valid: last.min === 3.75 && last.max === 3.99, lastMin: last.min, lastMax: last.max, count: tiers.length };
    });
    ok(r.valid, 'T27: Default thickness tiers end at 3.75–3.99"');
    await page.context().close();

    // ===== T28: All info buttons are small circle icons =====
    console.log('\n--- T28: Info buttons are small circles ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'info@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const btns = document.querySelectorAll('.settings-info-btn');
      let allSmall = true;
      btns.forEach(btn => {
        const style = getComputedStyle(btn);
        const w = parseInt(style.width);
        if(w > 30) allSmall = false;
      });
      return { count: btns.length, allSmall };
    });
    ok(r.count > 0 && r.allSmall, 'T28: All info buttons are small circle icons (not full-width)');
    await page.context().close();

    // ===== T29: Grain & Pattern info buttons are small icons =====
    console.log('\n--- T29: Grain & Pattern info buttons ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'grain@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="grain"]');
    await page.waitForTimeout(200);
    r = await page.evaluate(() => {
      const grainBody = document.querySelector('.settings-sub-collapse-body[data-sub="grain"]');
      if(!grainBody) return { found: false };
      const infoBtns = grainBody.querySelectorAll('.settings-info-btn');
      const fullWidthBtns = grainBody.querySelectorAll('button.btn');
      return { found: true, infoBtnCount: infoBtns.length, fullWidthBtnCount: fullWidthBtns.length };
    });
    ok(r.found && r.infoBtnCount >= 2, 'T29: End Grain and Complex Pattern have small info icons');
    await page.context().close();

    // ===== T30: Clear-on-focus / restore-on-blur =====
    console.log('\n--- T30: Clear-on-focus / restore-on-blur ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'cof@test.com', 'Test1234!');
    await page.evaluate(() => { showSettings(); });
    await page.waitForTimeout(300);
    await page.click('.settings-collapse-hdr[data-section="pricing"]');
    await page.waitForTimeout(200);
    await page.click('.settings-sub-collapse-hdr[data-sub="labor"]');
    await page.waitForTimeout(200);
    // Set shop rate to a known value
    await page.fill('#set-shop-rate', '25');
    await page.waitForTimeout(100);
    // Click elsewhere to blur
    await page.click('#settings-save-btn');
    await page.waitForTimeout(200);
    // Now focus the field — it should clear
    const beforeFocus = await page.evaluate(() => document.getElementById('set-shop-rate').value);
    await page.focus('#set-shop-rate');
    await page.waitForTimeout(100);
    const afterFocus = await page.evaluate(() => document.getElementById('set-shop-rate').value);
    // Blur without typing — it should restore
    await page.click('#settings-save-btn');
    await page.waitForTimeout(200);
    const afterBlur = await page.evaluate(() => document.getElementById('set-shop-rate').value);
    ok(afterFocus === '' && afterBlur === beforeFocus, 'T30: Clear-on-focus and restore-on-blur works');
    await page.context().close();

    // ===== T31: All existing functionality unchanged =====
    console.log('\n--- T31: Existing functionality smoke test ---');
    await resetMock();
    page = await freshPage();
    // Test basic calculate lumber flow
    await page.click('#start-btn');
    await page.waitForSelector('#app-screen', { state: 'visible', timeout: 3000 });
    const calcScreenVis = await page.evaluate(() => {
      const el = document.getElementById('app-screen');
      return el && getComputedStyle(el).display !== 'none';
    });
    ok(calcScreenVis, 'T31: Calculate Lumber screen works (existing functionality)');
    await page.context().close();

  } catch(err) {
    console.error('\n!!! UNCAUGHT ERROR:', err.message || err);
    fail++;
  } finally {
    await browser.close();
    staticServer.close();
    mockProc.kill();
    console.log('\n========================================');
    console.log('RESULTS: ' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' total)');
    console.log('========================================');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
