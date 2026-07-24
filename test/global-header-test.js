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
  // Start mock server
  const mockProc = spawn('node', [path.join(__dirname, 'mock-supabase.js'), String(MOCK_PORT)], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    mockProc.stdout.on('data', d => { if(d.toString().includes('listening')) resolve(); });
    mockProc.on('error', reject);
    setTimeout(() => reject(new Error('mock startup timeout')), 5000);
  });

  // Prepare test HTML
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
    // Wait for signed-out state
    await page.waitForFunction(() => !window._currentUser && typeof _currentUser !== 'undefined' && _currentUser === null, { timeout: 5000 }).catch(() => {});

    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });

    // Make sure we're in signup mode
    const toggleBtn = await page.$('#auth-toggle-btn');
    if(toggleBtn) {
      const txt = await toggleBtn.innerText();
      if(txt.includes('Sign up')) await toggleBtn.click();
    }
    await page.waitForTimeout(100);

    await page.fill('#auth-email', email);
    await page.fill('#auth-password', password);
    const confirmField = await page.$('#auth-password-confirm');
    if(confirmField) await page.fill('#auth-password-confirm', password);
    if(username) await page.fill('#auth-username', username);
    if(companyName) await page.fill('#auth-company', companyName);
    await page.click('#auth-submit-btn');

    await page.waitForFunction(() => {
      return typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email;
    }, { timeout: 5000 });
    const welcomeBtn = await page.$('#auth-welcome-btn');
    if(welcomeBtn) await welcomeBtn.click();
    await page.waitForTimeout(300);
  }

  // Current Settings is a single scrollable page with collapsible cards.
  // Expand a top-level section (account | pricing) and a pricing sub-section
  // (surface | thickness | glue | grain | features | labor | threshold).
  async function expandSection(page, sec) {
    await page.evaluate((s) => {
      const hdr = document.querySelector('.settings-collapse-hdr[data-section="' + s + '"]');
      if(hdr && !hdr.classList.contains('expanded')) hdr.click();
    }, sec);
    await page.waitForTimeout(200);
  }
  async function expandSubSection(page, sub) {
    await page.evaluate((s) => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="' + s + '"]');
      if(hdr && !hdr.classList.contains('expanded')) hdr.click();
    }, sub);
    await page.waitForTimeout(200);
  }
  async function saveSub(page, sub) {
    await page.click('.set-sub-save[data-sub="' + sub + '"]');
    await page.waitForTimeout(500);
  }

  async function signIn(page, emailOrUsername, password) {
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });

    // Make sure we're in signin mode
    const toggleBtn = await page.$('#auth-toggle-btn');
    if(toggleBtn) {
      const txt = await toggleBtn.innerText();
      if(txt.includes('Sign in')) await toggleBtn.click();
    }
    await page.waitForTimeout(100);

    await page.fill('#auth-email', emailOrUsername);
    await page.fill('#auth-password', password);
    await page.click('#auth-submit-btn');

    await page.waitForFunction(() => {
      return typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email;
    }, { timeout: 5000 });
    await page.waitForTimeout(300);
  }

  try {
    // =============== TEST 1: Landing page CTA card - Calculate Lumber ===============
    console.log('\n--- Test 1: Calculate Lumber is a full-width card with icon ---');
    await resetMock();
    let page = await freshPage();
    let result = await page.evaluate(() => {
      const btn = document.getElementById('start-btn');
      if(!btn) return { exists: false };
      const hasCard = btn.classList.contains('landing-cta-card');
      const icon = btn.querySelector('.landing-cta-icon svg');
      const title = btn.querySelector('.landing-cta-title');
      return { exists: true, hasCard, hasIcon: !!icon, titleText: title?.textContent };
    });
    ok(result.exists && result.hasCard && result.hasIcon && result.titleText === 'Calculate Lumber',
      'T1: Calculate Lumber is full-width card with icon');
    await page.context().close();

    // =============== TEST 2: Sign In / Create Account card (signed out) ===============
    console.log('\n--- Test 2: Sign In/Create Account card (signed out) ---');
    page = await freshPage();
    result = await page.evaluate(() => {
      const btn = document.getElementById('landing-account-btn');
      if(!btn) return { exists: false };
      const hasCard = btn.classList.contains('landing-cta-card');
      const icon = btn.querySelector('.landing-cta-icon svg');
      const title = btn.querySelector('.landing-cta-title');
      const vis = getComputedStyle(btn).display !== 'none';
      return { exists: true, hasCard, hasIcon: !!icon, titleText: title?.textContent, visible: vis };
    });
    ok(result.exists && result.hasCard && result.hasIcon && result.titleText === 'Sign In / Create Account' && result.visible,
      'T2: Sign In/Create Account card visible when signed out');
    await page.context().close();

    // =============== TEST 3: No account button on landing when signed in ===============
    console.log('\n--- Test 3: No account btn on landing when signed in ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test@example.com', 'Test1234!');
    result = await page.evaluate(() => {
      const btn = document.getElementById('landing-account-btn');
      return { display: btn ? getComputedStyle(btn).display : 'missing' };
    });
    ok(result.display === 'none', 'T3: Account btn hidden when signed in');
    await page.context().close();

    // =============== TEST 4: Resume Calculation card ===============
    console.log('\n--- Test 4: Resume Calculation card ---');
    await resetMock();
    page = await freshPage();
    result = await page.evaluate(() => {
      const btn = document.getElementById('resume-btn');
      if(!btn) return { exists: false };
      const hasCard = btn.classList.contains('landing-cta-card');
      const icon = btn.querySelector('.landing-cta-icon svg');
      const title = btn.querySelector('.landing-cta-title');
      return { exists: true, hasCard, hasIcon: !!icon, titleText: title?.textContent };
    });
    ok(result.exists && result.hasCard && result.hasIcon && result.titleText === 'Resume Calculation',
      'T4: Resume Calculation card exists with icon');
    await page.context().close();

    // =============== TEST 5: Username field in account creation ===============
    console.log('\n--- Test 5: Username field in account creation ---');
    await resetMock();
    page = await freshPage();
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });
    const toggle5 = await page.$('#auth-toggle-btn');
    if(toggle5) {
      const txt = await toggle5.innerText();
      if(txt.includes('Sign up')) await toggle5.click();
    }
    await page.waitForTimeout(100);
    result = await page.evaluate(() => {
      const field = document.getElementById('auth-username');
      const wrapper = document.getElementById('auth-signup-fields');
      return {
        fieldExists: !!field,
        wrapperVisible: wrapper ? getComputedStyle(wrapper).display !== 'none' : false
      };
    });
    ok(result.fieldExists && result.wrapperVisible, 'T5: Username field present in signup');
    await page.context().close();

    // =============== TEST 6: Company Name field in account creation ===============
    console.log('\n--- Test 6: Company Name field in account creation ---');
    await resetMock();
    page = await freshPage();
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });
    const toggle6 = await page.$('#auth-toggle-btn');
    if(toggle6) {
      const txt = await toggle6.innerText();
      if(txt.includes('Sign up')) await toggle6.click();
    }
    await page.waitForTimeout(100);
    result = await page.evaluate(() => {
      const field = document.getElementById('auth-company');
      const wrapper = document.getElementById('auth-signup-fields');
      return {
        fieldExists: !!field,
        wrapperVisible: wrapper ? getComputedStyle(wrapper).display !== 'none' : false
      };
    });
    ok(result.fieldExists && result.wrapperVisible, 'T6: Company Name field present in signup');
    await page.context().close();

    // =============== TEST 7: Sign in with username ===============
    console.log('\n--- Test 7: Sign in with email OR username ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'user7@example.com', 'Pass7777!', 'testuser7');
    await page.context().close();
    // Sign in on a FRESH page: after a signup the app replaces the auth-modal body with a
    // welcome screen (login inputs are gone until reload), so signing back in must use a new page.
    page = await freshPage();
    await signIn(page, 'testuser7', 'Pass7777!');
    result = await page.evaluate(() => {
      return { loggedIn: !!_currentUser, email: _currentUser?.email };
    });
    ok(result.loggedIn && result.email === 'user7@example.com', 'T7: Sign in with username works');
    await page.context().close();

    // =============== TEST 8: Feature grid tool cards ===============
    console.log('\n--- Test 8: Feature grid tool cards ---');
    page = await freshPage();
    result = await page.evaluate(() => {
      const grid = document.querySelector('.feature-grid');
      if(!grid) return { exists: false };
      const cards = grid.querySelectorAll('.feature-card');
      const texts = Array.from(cards).map(c => c.textContent.trim());
      return { exists: true, count: cards.length, texts };
    });
    ok(result.exists && result.count === 7, 'T8: Feature grid has 7 tool cards');
    await page.context().close();

    // =============== TEST 9: Settings gear on landing ===============
    console.log('\n--- Test 9: Settings gear on landing page ---');
    page = await freshPage();
    result = await page.evaluate(() => {
      const gear = document.getElementById('landing-gear-btn');
      if(!gear) return { exists: false };
      const rect = gear.getBoundingClientRect();
      return { exists: true, visible: rect.width > 0 && rect.height > 0 };
    });
    ok(result.exists && result.visible, 'T9: Settings gear visible on landing');
    await page.context().close();

    // =============== TEST 10: Settings gear in global header on non-landing screens ===============
    console.log('\n--- Test 10: Settings gear in global header ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test10@example.com', 'Test1234!');
    await page.evaluate(() => showShop());
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      const header = document.getElementById('shop-header');
      const gear = header?.querySelector('.gh-settings-btn');
      return { exists: !!gear, visible: gear ? gear.getBoundingClientRect().width > 0 : false };
    });
    ok(result.exists && result.visible, 'T10: Settings gear in global header on shop screen');
    await page.context().close();

    // =============== TEST 11: Settings shows 2 top-level sections ===============
    console.log('\n--- Test 11: Settings home shows exactly 2 sections ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test11@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(300);
    // Settings is now a single scrollable page with two collapsible cards (account + pricing).
    result = await page.evaluate(() => {
      const hdrs = document.querySelectorAll('.settings-collapse-hdr');
      const sections = Array.from(hdrs).map(h => ({
        sec: h.getAttribute('data-section'),
        text: (h.querySelector('.settings-sub-label') || h).textContent.replace(/[▶►i]/g, '').trim()
      }));
      return { count: hdrs.length, sections };
    });
    const hasAccount = result.sections.some(s => s.sec === 'account' && s.text === 'My Account');
    const hasPricing = result.sections.some(s => s.sec === 'pricing' && s.text === 'Quote Defaults');
    ok(result.count === 2 && hasAccount && hasPricing,
      'T11: Settings shows My Account + Quote Defaults sections');
    await page.context().close();

    // =============== TEST 12: Settings uses global header (Variant D) ===============
    console.log('\n--- Test 12: Settings uses global header ---');
    await resetMock();
    page = await freshPage();
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    result = await page.evaluate(() => {
      const header = document.getElementById('settings-header');
      if(!header) return { exists: false };
      const hasGlobal = header.classList.contains('global-header');
      const backBtn = document.getElementById('settings-back-btn');
      const tools = header.querySelector('.gh-tools-btn');
      const qc = header.querySelector('.gh-quickcalc-btn');
      const gear = header.querySelector('.gh-settings-btn');
      return { exists: true, hasGlobal, hasBack: !!backBtn, hasTools: !!tools, hasQC: !!qc, hasGear: !!gear };
    });
    ok(result.exists && result.hasGlobal && result.hasBack && result.hasTools && result.hasQC && result.hasGear,
      'T12: Settings uses Variant D global header');
    await page.context().close();

    // =============== TEST 13: My Account editable ===============
    console.log('\n--- Test 13: My Account username/company editable ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test13@example.com', 'Test1234!', 'myuser13', 'My Co 13');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    // Click My Account
    await expandSection(page, 'account');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const username = document.getElementById('set-username');
      const company = document.getElementById('set-company-name');
      return {
        usernameExists: !!username,
        companyExists: !!company,
        usernameDisabled: username?.disabled,
        companyDisabled: company?.disabled
      };
    });
    ok(result.usernameExists && result.companyExists && !result.usernameDisabled && !result.companyDisabled,
      'T13: Username and Company Name are editable in My Account');
    await page.context().close();

    // =============== TEST 14: Sign Out works from My Account ===============
    console.log('\n--- Test 14: Sign Out works ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test14@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    // Sign Out moved to the Settings header (settings-ux); no longer inside the My Account card.
    await page.click('#settings-signout-btn');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      return { loggedIn: !!_currentUser };
    });
    ok(!result.loggedIn, 'T14: Sign Out works from Settings header');
    await page.context().close();

    // =============== TEST 15: Delete Account is grey underlined text ===============
    console.log('\n--- Test 15: Delete Account is grey underlined text ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test15@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'account');
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      const btn = document.getElementById('set-acct-delete');
      if(!btn) return { exists: false };
      const cs = getComputedStyle(btn);
      return {
        exists: true,
        isUnderlined: cs.textDecoration.includes('underline'),
        noBg: cs.background === 'none' || cs.backgroundColor === 'rgba(0, 0, 0, 0)'
      };
    });
    ok(result.exists && result.isUnderlined && result.noBg, 'T15: Delete Account is grey underlined text');
    await page.context().close();

    // =============== TEST 16: Pricing explainer trigger ===============
    console.log('\n--- Test 16: Pricing explainer trigger ---');
    await resetMock();
    page = await freshPage();
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    // The "how pricing works" explainer is now an info (i) trigger on the Quote Defaults header.
    result = await page.evaluate(() => {
      const btn = document.getElementById('pricing-explainer-open');
      return { exists: !!btn, isInfoBtn: !!btn && btn.classList.contains('settings-info-btn') };
    });
    ok(result.exists && result.isInfoBtn, 'T16: Pricing explainer trigger present on Quote Defaults');
    await page.context().close();

    // =============== TEST 17: Pricing explainer modal ===============
    console.log('\n--- Test 17: Pricing explainer modal content ---');
    await resetMock();
    page = await freshPage();
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await page.click('#pricing-explainer-open');
    await page.waitForTimeout(200);
    result = await page.evaluate(() => {
      const modal = document.getElementById('pricing-explainer-modal');
      const isOpen = modal?.classList.contains('open');
      const body = modal?.querySelector('.pricing-modal-body');
      const t = (body?.textContent || '').toLowerCase();
      // Layered-pricing explanation: surface-area base, percentage increases (thickness/glue),
      // feature add-ons, then labor.
      return {
        isOpen,
        hasSurface: t.includes('surface area'),
        hasThickness: t.includes('thickness'),
        hasGlue: t.includes('glue'),
        hasFeatures: t.includes('feature'),
        hasLabor: t.includes('labor')
      };
    });
    ok(result.isOpen && result.hasSurface && result.hasThickness && result.hasGlue && result.hasFeatures && result.hasLabor,
      'T17: Pricing explainer modal opens with layered-pricing content');
    await page.context().close();

    // =============== TEST 18: Your Pricing Defaults sub-menu has 7 options ===============
    console.log('\n--- Test 18: Pricing Defaults sub-menu ---');
    await resetMock();
    page = await freshPage();
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    // Sub-options are now collapsible sub-section headers within the pricing card (not a sub-menu).
    result = await page.evaluate(() => {
      const items = document.querySelectorAll('.settings-collapse-body[data-section="pricing"] .settings-sub-collapse-hdr');
      const texts = Array.from(items).map(el => el.textContent.replace(/[›▶]/g, '').trim());
      return { count: items.length, texts };
    });
    ok(result.count === 7, 'T18: Quote Defaults has 7 sub-sections');
    await page.context().close();

    // =============== TEST 19: Labour Rates save ===============
    console.log('\n--- Test 19: Labour Rates save ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test19@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'labor');
    await page.waitForTimeout(200);
    // Clear and fill
    await page.evaluate(() => {
      document.getElementById('set-shop-rate').value = '75';
      document.getElementById('set-employee-rate').value = '25';
    });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('wbc_settings'));
      return { shopRate: s?.defaultShopRate, employeeRate: s?.defaultEmployeeRate };
    });
    ok(result.shopRate === 75 && result.employeeRate === 25, 'T19: Labour Rates save correctly');
    await page.context().close();

    // =============== TEST 20: Surface Area Tiers ===============
    console.log('\n--- Test 20: Surface Area Tiers ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test20@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'surface');
    await page.waitForTimeout(200);
    // Surface Area pricing is now per-tier $/sq in rates (surfaceAreaTiers), default 3 tiers.
    result = await page.evaluate(() => {
      const rates = document.querySelectorAll('.set-sa-rate');
      return { rateCount: rates.length };
    });
    ok(result.rateCount === 3, 'T20: Surface Area has 3 editable tier rates');
    // Edit the first tier rate and save
    await page.evaluate(() => { document.querySelector('.set-sa-rate[data-idx="0"]').value = '1.5'; });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('wbc_settings'));
      return { firstRate: s?.surfaceAreaTiers?.[0]?.rate };
    });
    ok(result.firstRate === 1.5, 'T20b: Surface Area tier rate saved');
    await page.context().close();

    // =============== TEST 21: Thickness Tiers ===============
    console.log('\n--- Test 21: Thickness Tiers ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test21@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'thickness');
    await page.waitForTimeout(200);
    result = await page.evaluate(() => {
      const mods = document.querySelectorAll('.set-thick-mod');
      return { count: mods.length };
    });
    ok(result.count === 13, 'T21: 13 thickness tier modifiers editable');
    await page.evaluate(() => { document.querySelector('.set-thick-mod[data-idx="1"]').value = '5'; });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('wbc_settings'));
      return { mod: s?.thicknessTiers?.[1]?.modifier };
    });
    ok(result.mod === 0.05, 'T21b: Thickness modifier saved');
    await page.context().close();

    // =============== TEST 22: Glue Ups ===============
    console.log('\n--- Test 22: Glue Ups ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test22@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'glue');
    await page.waitForTimeout(200);
    result = await page.evaluate(() => {
      const mods = document.querySelectorAll('.set-glue-mod');
      return { count: mods.length };
    });
    ok(result.count === 6, 'T22: Glue Ups has 6 editable modifiers');
    await page.evaluate(() => { document.querySelector('.set-glue-mod[data-idx="2"]').value = '12'; });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('wbc_settings'));
      return { mod: s?.multipliers?.glueUps?.[2] };
    });
    ok(result.mod === 0.12, 'T22b: Glue Ups modifier saved');
    await page.context().close();

    // =============== TEST 23: Grain & Pattern ===============
    console.log('\n--- Test 23: Grain & Pattern ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test23@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'grain');
    await page.waitForTimeout(200);
    // Grain & Pattern sub-section: End Grain + Complex Pattern % inputs, each with an info (i) trigger.
    result = await page.evaluate(() => {
      const body = document.querySelector('.settings-sub-collapse-body[data-sub="grain"]');
      const eg = document.getElementById('set-end-grain');
      const cp = document.getElementById('set-complex');
      const egInfo = body?.querySelector('.settings-info-btn[data-info="eg"]');
      const cpInfo = body?.querySelector('.settings-info-btn[data-info="cp"]');
      const text = body?.textContent || '';
      return {
        eg: !!eg, cp: !!cp, egInfo: !!egInfo, cpInfo: !!cpInfo,
        hasHeadings: text.includes('End Grain') && text.includes('Complex Pattern')
      };
    });
    ok(result.eg && result.cp && result.egInfo && result.cpInfo && result.hasHeadings,
      'T23: End Grain & Complex Pattern inputs and info triggers present');
    await page.evaluate(() => {
      document.getElementById('set-end-grain').value = '30';
      document.getElementById('set-complex').value = '35';
    });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('wbc_settings'));
      return { eg: s?.multipliers?.endGrain, cp: s?.multipliers?.complexPattern };
    });
    ok(result.eg === 0.30 && result.cp === 0.35, 'T23b: Grain & Pattern saved');
    await page.context().close();

    // =============== TEST 24: Feature Add-Ons ===============
    console.log('\n--- Test 24: Feature Add-Ons ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test24@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'features');
    await page.waitForTimeout(200);
    result = await page.evaluate(() => {
      const names = document.querySelectorAll('.set-feat-name');
      const addBtn = document.getElementById('set-add-feat');
      const delBtns = document.querySelectorAll('[data-del-feat]');
      return { count: names.length, hasAdd: !!addBtn, delCount: delBtns.length };
    });
    ok(result.count === 4 && result.hasAdd && result.delCount === 4, 'T24: 4 default features, add & delete available');
    // Add a feature
    await page.click('#set-add-feat');
    await page.waitForTimeout(200);
    result = await page.evaluate(() => document.querySelectorAll('.set-feat-name').length);
    ok(result === 5, 'T24b: Add Feature creates new row');
    // Delete one
    await page.click('[data-del-feat="0"]');
    await page.waitForTimeout(200);
    result = await page.evaluate(() => document.querySelectorAll('.set-feat-name').length);
    ok(result === 4, 'T24c: Delete feature removes row');
    // Edit and save
    await page.evaluate(() => {
      document.querySelector('.set-feat-name[data-idx="0"]').value = 'Custom Thing';
      document.querySelector('.set-feat-price[data-idx="0"]').value = '99';
    });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('wbc_settings'));
      return { firstName: s?.featureAddOns?.[0]?.name, firstPrice: s?.featureAddOns?.[0]?.price };
    });
    ok(result.firstName === 'Custom Thing' && result.firstPrice === 99, 'T24d: Feature edits saved');
    await page.context().close();

    // =============== TEST 25: Minimum Quote Threshold ===============
    console.log('\n--- Test 25: Minimum Quote Threshold ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test25@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'threshold');
    await page.waitForTimeout(200);
    await page.evaluate(() => { document.getElementById('set-min-threshold').value = '100'; });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(500);
    result = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('wbc_settings'));
      return { threshold: s?.minThreshold };
    });
    ok(result.threshold === 100, 'T25: Minimum Quote Threshold saves');
    await page.context().close();

    // =============== TEST 26: Clear-on-focus / restore-on-blur ===============
    console.log('\n--- Test 26: Clear-on-focus / restore-on-blur ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test26@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'labor');
    await page.waitForTimeout(200);
    // Focus and check clearing
    const shopRateVal = await page.evaluate(() => document.getElementById('set-shop-rate').value);
    await page.focus('#set-shop-rate');
    await page.waitForTimeout(100);
    const clearedVal = await page.evaluate(() => document.getElementById('set-shop-rate').value);
    // Blur the field to trigger restore-on-blur
    await page.evaluate(() => document.getElementById('set-shop-rate').blur());
    await page.waitForTimeout(100);
    const restoredVal = await page.evaluate(() => document.getElementById('set-shop-rate').value);
    ok(clearedVal === '' && restoredVal === shopRateVal, 'T26: Field clears on focus, restores on blur');
    await page.context().close();

    // =============== TEST 27: Quick Calc icon in header ===============
    console.log('\n--- Test 27: Quick Calc icon in header ---');
    await resetMock();
    page = await freshPage();
    await page.evaluate(() => { document.getElementById('start-btn').click(); });
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      const qcBtn = document.querySelector('#app-header .gh-quickcalc-btn');
      if(!qcBtn) return { exists: false };
      const hasSvg = !!qcBtn.querySelector('svg');
      const text = qcBtn.textContent.trim();
      return { exists: true, hasSvg, isIcon: hasSvg && !text.includes('Quick Calc') };
    });
    ok(result.exists && result.isIcon, 'T27: Quick Calc is icon (not text) in header');
    await page.context().close();

    // =============== TEST 28: Tools dropdown in global header ===============
    console.log('\n--- Test 28: Tools dropdown ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test28@example.com', 'Test1234!');
    await page.evaluate(() => showShop());
    await page.waitForTimeout(300);
    const toolsBtn = await page.$('#shop-header .gh-tools-btn');
    ok(!!toolsBtn, 'T28a: Tools button exists in header');
    if(toolsBtn) {
      await toolsBtn.click();
      await page.waitForTimeout(200);
      result = await page.evaluate(() => {
        const dd = document.querySelector('#shop-header .tools-dropdown.open');
        if(!dd) return { open: false };
        const items = dd.querySelectorAll('button');
        const texts = Array.from(items).map(b => b.textContent.trim());
        return { open: true, count: items.length, texts };
      });
      ok(result.open && result.count === 4, 'T28b: Tools dropdown has 4 items');
    }
    await page.context().close();

    // =============== TEST 29: Tools dropdown navigation ===============
    console.log('\n--- Test 29: Tools dropdown navigation ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test29@example.com', 'Test1234!');
    await page.evaluate(() => showShop());
    await page.waitForTimeout(300);
    // Click tools, click quotes
    await page.click('#shop-header .gh-tools-btn');
    await page.waitForTimeout(200);
    await page.click('.tools-dropdown [data-tool="quotes"]');
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      return { quotesVisible: document.getElementById('quotes-screen')?.style.display !== 'none' };
    });
    ok(result.quotesVisible, 'T29: Tools dropdown navigates correctly');
    await page.context().close();

    // =============== TEST 30: Calculator header buttons ===============
    console.log('\n--- Test 30: Calculator header ---');
    await resetMock();
    page = await freshPage();
    await page.evaluate(() => { document.getElementById('start-btn').click(); });
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      const header = document.getElementById('app-header');
      if(!header) return { exists: false };
      const back = header.querySelector('#back-btn');
      const clear = header.querySelector('#start-over-btn');
      const tools = header.querySelector('.gh-tools-btn');
      const qc = header.querySelector('.gh-quickcalc-btn');
      const save = header.querySelector('#save-btn');
      const gear = header.querySelector('.gh-settings-btn');
      return {
        exists: true,
        hasBack: !!back, hasClear: !!clear, hasTools: !!tools,
        hasQC: !!qc, hasSave: !!save, hasGear: !!gear
      };
    });
    ok(result.exists && result.hasBack && result.hasClear && result.hasTools && result.hasQC && result.hasSave && result.hasGear,
      'T30: Calculator header has Back, Clear, Tools, QC, Save, Settings');
    await page.context().close();

    // =============== TEST 31: Top-level screen headers ===============
    console.log('\n--- Test 31: Top-level screen headers ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test31@example.com', 'Test1234!');
    await page.evaluate(() => showShop());
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      const header = document.getElementById('shop-header');
      if(!header) return { exists: false };
      const back = header.querySelector('button[id*="back"]') || header.querySelector('.btn');
      const tools = header.querySelector('.gh-tools-btn');
      const qc = header.querySelector('.gh-quickcalc-btn');
      const gear = header.querySelector('.gh-settings-btn');
      const clear = header.querySelector('[id*="clear"]');
      const save = header.querySelector('#save-btn');
      return {
        exists: true, hasBack: !!back, hasTools: !!tools,
        hasQC: !!qc, hasGear: !!gear, noClear: !clear, noSave: !save
      };
    });
    ok(result.exists && result.hasBack && result.hasTools && result.hasQC && result.hasGear && result.noClear && result.noSave,
      'T31: Top-level screen: Back + Tools + QC + Settings, no Clear/Save');
    await page.context().close();

    // =============== TEST 32: Individual item screen headers ===============
    console.log('\n--- Test 32: Individual item screen headers ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test32@example.com', 'Test1234!');
    await page.evaluate(() => showProjects());
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      const header = document.getElementById('projects-header');
      if(!header) return { exists: false };
      const back = header.querySelector('button[id*="back"]') || header.querySelector('.btn');
      const tools = header.querySelector('.gh-tools-btn');
      const qc = header.querySelector('.gh-quickcalc-btn');
      const gear = header.querySelector('.gh-settings-btn');
      return { exists: true, hasBack: !!back, hasTools: !!tools, hasQC: !!qc, hasGear: !!gear };
    });
    ok(result.exists && result.hasBack && result.hasTools && result.hasQC && result.hasGear,
      'T32: Individual item screen has global header elements');
    await page.context().close();

    // =============== TEST 33: Settings syncs across devices ===============
    console.log('\n--- Test 33: Settings syncs (Supabase save/fetch) ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'test33@example.com', 'Test1234!');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(200);
    await expandSection(page, 'pricing');
    await page.waitForTimeout(200);
    await expandSubSection(page, 'labor');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      document.getElementById('set-shop-rate').value = '85';
      document.getElementById('set-employee-rate').value = '30';
    });
    await page.click('.settings-sub-collapse-body.expanded .set-sub-save');
    await page.waitForTimeout(1000);
    // Check mock dump
    const dumpResp = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:' + MOCK_PORT + '/_test/dump', res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    const profileSettings = dumpResp.profiles?.[0]?.settings;
    ok(profileSettings && profileSettings.defaultShopRate === 85 && profileSettings.defaultEmployeeRate === 30,
      'T33: Settings synced to Supabase profiles');
    await page.context().close();

    // =============== TEST 34: All existing functionality unchanged ===============
    console.log('\n--- Test 34: Existing functionality ---');
    await resetMock();
    page = await freshPage();
    // Start calculator
    await page.evaluate(() => { document.getElementById('start-btn').click(); });
    await page.waitForTimeout(300);
    result = await page.evaluate(() => {
      const appScreen = document.getElementById('app-screen');
      const visible = appScreen && getComputedStyle(appScreen).display !== 'none';
      return { calcVisible: visible };
    });
    ok(result.calcVisible, 'T34: Calculator opens normally');
    await page.context().close();

  } catch(e) {
    console.error('TEST ERROR:', e);
    fail++;
  }

  console.log('\n========================================');
  console.log('RESULTS: ' + pass + ' passed, ' + fail + ' failed, ' + (pass + fail) + ' total');
  console.log('========================================');

  await browser.close();
  staticServer.close();
  mockProc.kill();
  process.exit(fail > 0 ? 1 : 0);
})();
