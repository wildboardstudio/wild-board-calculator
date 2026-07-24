const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MOCK_PORT = 8901;
const STATIC_PORT = 8900;
const BROWSER_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if(!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

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
      const req = http.request({
        hostname: '127.0.0.1', port: MOCK_PORT, path: mockPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
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
      if(msg.type() === 'error' && !msg.text().includes('ERR_BLOCKED_BY_CLIENT') && !msg.text().includes('favicon') && !msg.text().includes('404'))
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
    const confirmField = await page.$('#auth-password-confirm');
    if(confirmField) await page.fill('#auth-password-confirm', password);
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, { timeout: 5000 });
    const welcomeBtn = await page.$('#auth-welcome-btn');
    if(welcomeBtn) await welcomeBtn.click();
    await page.waitForTimeout(300);
  }

  async function openSettings(page) {
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(300);
  }

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

  // Geometry containment check: card rect must surround body content rect
  async function checkContainment(page, sectionSel, cardSel) {
    return await page.evaluate(({ sectionSel, cardSel }) => {
      const body = document.querySelector(sectionSel);
      if(!body || !body.classList.contains('expanded')) return { ok: false, reason: 'not expanded' };
      const card = body.closest(cardSel);
      if(!card) return { ok: false, reason: 'no card ancestor' };
      const cardRect = card.getBoundingClientRect();
      const cs = getComputedStyle(card);
      // Card must not clip children
      const clips = cs.overflow === 'hidden' || cs.overflowY === 'hidden';
      // Every descendant of body must be inside card bounds
      let allInside = true; let worst = null;
      const els = body.querySelectorAll('*');
      for(const el of els) {
        const r = el.getBoundingClientRect();
        if(r.width === 0 && r.height === 0) continue;
        if(r.bottom > cardRect.bottom + 1 || r.top < cardRect.top - 1 || r.left < cardRect.left - 1 || r.right > cardRect.right + 1) {
          allInside = false; worst = { tag: el.tagName, cls: el.className && el.className.toString ? el.className.toString() : '', r: { t: r.top, b: r.bottom, l: r.left, rt: r.right }, card: { t: cardRect.top, b: cardRect.bottom, l: cardRect.left, r: cardRect.right } };
          break;
        }
      }
      const hasBorder = parseFloat(cs.borderTopWidth) > 0;
      return { ok: allInside && !clips && hasBorder, allInside, clips, hasBorder, worst };
    }, { sectionSel, cardSel });
  }

  try {
    // ─── T1: Header Sign Out button ───
    console.log('\n--- T1: Header Sign Out ---');
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'u1@test.com', 'pass123');
    await openSettings(page);
    const t1 = await page.evaluate(() => {
      const btn = document.getElementById('settings-signout-btn');
      if(!btn) return { exists: false };
      const visible = btn.style.display !== 'none' && btn.offsetParent !== null;
      // right side: button center right of screen center
      const r = btn.getBoundingClientRect();
      const onRight = (r.left + r.width / 2) > window.innerWidth / 2;
      return { exists: true, visible, onRight, text: btn.textContent.trim() };
    });
    ok(t1.exists && t1.visible && t1.onRight && t1.text === 'Sign Out', 'T1: Settings header shows Sign Out button (top right)');
    await page.close();

    // ─── T2: Sign Out works ───
    console.log('\n--- T2: Sign Out flow ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u2@test.com', 'pass123');
    await openSettings(page);
    await page.click('#settings-signout-btn');
    await page.waitForTimeout(800);
    const t2 = await page.evaluate(() => ({
      signedOut: _currentUser === null,
      landingVisible: document.getElementById('landing-screen').style.display !== 'none',
      settingsHidden: document.getElementById('settings-screen').style.display === 'none'
    }));
    ok(t2.signedOut && t2.landingVisible && t2.settingsHidden, 'T2: Sign Out signs out and returns to landing');
    await page.close();

    // ─── T3: No global Save button ───
    console.log('\n--- T3: No global Save ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u3@test.com', 'pass123');
    await openSettings(page);
    const t3 = await page.evaluate(() => {
      const globalSave = document.getElementById('settings-save-btn');
      return { gone: !globalSave };
    });
    ok(t3.gone, 'T3: No global Save button at bottom of Settings');
    await page.close();

    // ─── T4: My Account Save inside card at bottom ───
    console.log('\n--- T4: My Account Save placement ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u4@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    const t4 = await page.evaluate(() => {
      const save = document.getElementById('set-acct-save');
      if(!save) return { ok: false };
      const card = save.closest('.settings-card');
      const body = save.closest('.settings-collapse-body[data-section="account"]');
      // Save is below the last input (company name)
      const company = document.getElementById('set-company-name');
      const below = company && save.getBoundingClientRect().top > company.getBoundingClientRect().bottom;
      return { ok: !!card && !!body && below };
    });
    ok(t4.ok, 'T4: My Account Save button inside card at bottom');
    await page.close();

    // ─── T5 + T6: My Account Save saves + collapses ───
    console.log('\n--- T5/T6: My Account save + collapse ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u5@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    await page.fill('#set-first-name', 'Kenny');
    await page.fill('#set-last-name', 'Board');
    await page.fill('#set-username', 'kboard');
    await page.fill('#set-company-name', 'Wild Board Studio');
    await page.click('#set-acct-save');
    await page.waitForTimeout(500);
    const savedLabel = await page.evaluate(() => document.getElementById('set-acct-save').textContent);
    const dump = await getMock('/_test/dump');
    const prof = (dump.profiles || []).find(p => p.first_name === 'Kenny');
    ok(prof && prof.last_name === 'Board' && prof.username === 'kboard' && prof.company_name === 'Wild Board Studio',
      'T5: My Account Save persists profile fields to Supabase');
    // Wait for collapse (1.5s after save)
    await page.waitForTimeout(1600);
    const t6 = await page.evaluate(() => {
      const body = document.querySelector('.settings-collapse-body[data-section="account"]');
      const hdr = document.querySelector('.settings-collapse-hdr[data-section="account"]');
      return { collapsed: !body.classList.contains('expanded') && !hdr.classList.contains('expanded'), savedLabelSeen: true };
    });
    ok(savedLabel.includes('Saved') && t6.collapsed, 'T6: My Account card collapses after saving (with Saved ✓ feedback)');
    await page.close();

    // ─── T7: No Sign Out inside My Account card ───
    console.log('\n--- T7: Sign Out not in card ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u7@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    const t7 = await page.evaluate(() => {
      const body = document.querySelector('.settings-collapse-body[data-section="account"]');
      const btns = [...body.querySelectorAll('button')].map(b => b.textContent.trim());
      return { hasSignOut: btns.includes('Sign Out') };
    });
    ok(!t7.hasSignOut, 'T7: Sign Out NOT present inside My Account card');
    await page.close();

    // ─── T8: Delete Account grey underlined below Save ───
    console.log('\n--- T8: Delete Account style/position ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u8@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    const t8 = await page.evaluate(() => {
      const del = document.getElementById('set-acct-delete');
      const save = document.getElementById('set-acct-save');
      if(!del || !save) return { ok: false };
      const cs = getComputedStyle(del);
      const underlined = cs.textDecorationLine.includes('underline');
      const notButton = (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') && cs.borderStyle === 'none';
      const belowSave = del.getBoundingClientRect().top > save.getBoundingClientRect().bottom;
      return { ok: underlined && notButton && belowSave };
    });
    ok(t8.ok, 'T8: Delete Account is grey underlined text below Save');
    await page.close();

    // ─── T9: Sub-section Save collapses sub-section ───
    console.log('\n--- T9: Sub-section save collapse ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u9@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'pricing');
    await expandSubSection(page, 'surface');
    const subSaveExists = await page.evaluate(() => !!document.querySelector('.set-sub-save[data-sub="surface"]'));
    await page.click('.set-sub-save[data-sub="surface"]');
    await page.waitForTimeout(300);
    const subSavedLabel = await page.evaluate(() => document.querySelector('.set-sub-save[data-sub="surface"]').textContent);
    await page.waitForTimeout(1500);
    const t9 = await page.evaluate(() => {
      const body = document.querySelector('.settings-sub-collapse-body[data-sub="surface"]');
      return { collapsed: !body.classList.contains('expanded') };
    });
    ok(subSaveExists && subSavedLabel.includes('Saved') && t9.collapsed,
      'T9: Sub-section Save button collapses the sub-section after saving');
    await page.close();

    // ─── T10: My Account containment (geometry + screenshot) ───
    console.log('\n--- T10: My Account containment ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u10@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    const t10 = await checkContainment(page, '.settings-collapse-body[data-section="account"]', '.settings-card');
    await page.screenshot({ path: path.join(SHOT_DIR, 'account-expanded.png'), fullPage: true });
    ok(t10.ok, 'T10: My Account expanded content contained within card boundary (screenshot: account-expanded.png)' + (t10.ok ? '' : ' ' + JSON.stringify(t10)));
    await page.close();

    // ─── T11: Pricing Defaults containment (geometry + screenshot) ───
    console.log('\n--- T11: Pricing Defaults containment ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u11@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'pricing');
    const t11 = await checkContainment(page, '.settings-collapse-body[data-section="pricing"]', '.settings-card');
    await page.screenshot({ path: path.join(SHOT_DIR, 'pricing-expanded.png'), fullPage: true });
    ok(t11.ok, 'T11: Pricing Defaults expanded content contained within card boundary (screenshot: pricing-expanded.png)' + (t11.ok ? '' : ' ' + JSON.stringify(t11)));
    await page.close();

    // ─── T12: Sub-section nested containment (geometry + screenshot) ───
    console.log('\n--- T12: Sub-section nested containment ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u12@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'pricing');
    await expandSubSection(page, 'surface');
    await expandSubSection(page, 'thickness');
    const t12 = await checkContainment(page, '.settings-collapse-body[data-section="pricing"]', '.settings-card');
    const t12b = await page.evaluate(() => {
      // sub-body must be DOM descendant of the pricing card
      const sub = document.querySelector('.settings-sub-collapse-body[data-sub="surface"]');
      const card = document.querySelector('.settings-collapse-body[data-section="pricing"]')?.closest('.settings-card');
      return { nested: !!(sub && card && card.contains(sub)) };
    });
    await page.screenshot({ path: path.join(SHOT_DIR, 'subsection-expanded.png'), fullPage: true });
    ok(t12.ok && t12b.nested, 'T12: Expanded sub-section content nested inside Pricing Defaults card (screenshot: subsection-expanded.png)' + (t12.ok ? '' : ' ' + JSON.stringify(t12)));
    await page.close();

    // ─── T13: Change Password opens modal, no immediate email ───
    console.log('\n--- T13: Change Password modal ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u13@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    // Track recover requests
    let recoverCalls = 0;
    page.on('request', r => { if(r.url().includes('/auth/v1/recover')) recoverCalls++; });
    await page.click('#set-change-password-btn');
    await page.waitForTimeout(400);
    const t13 = await page.evaluate(() => {
      const m = document.getElementById('change-password-modal');
      return { open: m && m.classList.contains('open') };
    });
    ok(t13.open && recoverCalls === 0, 'T13: Change Password opens confirmation modal without sending email');

    // ─── T14: Modal shows current email ───
    const t14 = await page.evaluate(() => document.getElementById('change-password-email').textContent);
    ok(t14 === 'u13@test.com', 'T14: Confirmation modal shows user\'s current email (' + t14 + ')');

    // ─── T15: Modal explains sign-out consequence ───
    const t15 = await page.evaluate(() => document.getElementById('change-password-modal').textContent);
    ok(t15.includes('signed out of all devices'), 'T15: Modal explains sign-out consequence');

    // ─── T16: Send Reset Link → email sent, signed out, landing ───
    console.log('\n--- T16: Send Reset Link flow ---');
    await page.click('#change-password-send-btn');
    await page.waitForTimeout(1000);
    const t16 = await page.evaluate(() => ({
      signedOut: _currentUser === null,
      landingVisible: document.getElementById('landing-screen').style.display !== 'none',
      modalClosed: !document.getElementById('change-password-modal').classList.contains('open'),
      banner: !!document.getElementById('password-reset-banner')
    }));
    ok(recoverCalls === 1 && t16.signedOut && t16.landingVisible && t16.modalClosed && t16.banner,
      'T16: Send Reset Link sends email, signs out, returns to landing with message');
    await page.close();

    // ─── T17: Cancel closes modal, stays signed in ───
    console.log('\n--- T17: Cancel flow ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u17@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    await page.click('#set-change-password-btn');
    await page.waitForTimeout(300);
    await page.click('#change-password-cancel-btn');
    await page.waitForTimeout(300);
    const t17 = await page.evaluate(() => ({
      modalClosed: !document.getElementById('change-password-modal').classList.contains('open'),
      stillSignedIn: _currentUser !== null,
      settingsVisible: document.getElementById('settings-screen').style.display !== 'none'
    }));
    ok(t17.modalClosed && t17.stillSignedIn && t17.settingsVisible, 'T17: Cancel closes modal, user remains signed in');
    await page.close();

    // ─── T18: Existing functionality unchanged ───
    console.log('\n--- T18: Existing functionality ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 'u18@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'pricing');
    // Tier editing: add a surface tier
    await expandSubSection(page, 'surface');
    const before = await page.evaluate(() => document.querySelectorAll('.set-sa-rate').length);
    await page.evaluate(() => document.getElementById('set-sa-add').click());
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelectorAll('.set-sa-rate').length);
    // Feature add-ons: add a feature
    await expandSubSection(page, 'features');
    const featBefore = await page.evaluate(() => document.querySelectorAll('.set-feat-name').length);
    await page.evaluate(() => document.getElementById('set-add-feat').click());
    await page.waitForTimeout(300);
    const featAfter = await page.evaluate(() => document.querySelectorAll('.set-feat-name').length);
    // Info modal still works
    await page.evaluate(() => { const b = document.querySelector('.settings-info-btn[data-info="sa"]'); if(b) b.click(); });
    await page.waitForTimeout(200);
    const infoOpen = await page.evaluate(() => {
      const m = document.getElementById('settings-info-modal');
      return m && m.classList.contains('open');
    });
    ok(after === before + 1 && featAfter === featBefore + 1 && infoOpen,
      'T18: Existing Settings functionality unchanged (tier editing, feature add-ons, info modal)');
    await page.close();

  } catch(err) {
    console.error('FATAL:', err);
    fail++;
  } finally {
    await browser.close();
    staticServer.close();
    mockProc.kill();
    console.log('\n========================================');
    console.log('RESULTS: ' + pass + ' passed, ' + fail + ' failed out of ' + (pass + fail));
    console.log('========================================');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
