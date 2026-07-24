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
    const confirmField = await page.$('#auth-password-confirm');
    if(confirmField) await page.fill('#auth-password-confirm', password);
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, { timeout: 5000 });
    // Dismiss welcome screen if shown
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
      if(hdr) hdr.click();
    }, sec);
    await page.waitForTimeout(200);
  }

  try {
    // ─── T1: Settings home labels ───
    console.log('\n--- T1: Settings home labels ---');
    await resetMock();
    let page = await freshPage();
    await signUp(page, 's1@test.com', 'pass123');
    await openSettings(page);
    const labels = await page.evaluate(() => {
      return [...document.querySelectorAll('.settings-collapse-hdr')].map(h => h.textContent.replace('▶','').trim());
    });
    ok(labels.some(l => l.includes('My Account')) &&
       labels.some(l => l === 'Pricing Defaults') &&
       !labels.some(l => l.includes('Your Pricing Defaults')),
      'T1: Shows "My Account" and "Pricing Defaults" (not "Your Pricing Defaults")');
    await page.close();

    // ─── T2: Both collapsed by default ───
    console.log('\n--- T2: Collapsed by default ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's2@test.com', 'pass123');
    await openSettings(page);
    const collapsed = await page.evaluate(() => {
      const acct = document.querySelector('.settings-collapse-body[data-section="account"]');
      const pricing = document.querySelector('.settings-collapse-body[data-section="pricing"]');
      return {
        acctCollapsed: acct && !acct.classList.contains('expanded'),
        pricingCollapsed: pricing && !pricing.classList.contains('expanded')
      };
    });
    ok(collapsed.acctCollapsed && collapsed.pricingCollapsed, 'T2: Both cards collapsed by default');
    await page.close();

    // ─── T3: My Account expands, contained in card ───
    console.log('\n--- T3: My Account containment ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's3@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    const containment3 = await page.evaluate(() => {
      const body = document.querySelector('.settings-collapse-body[data-section="account"]');
      if(!body || !body.classList.contains('expanded')) return { ok: false };
      const card = body.closest('.settings-card');
      if(!card) return { ok: false, reason: 'no card wrapper' };
      const bodyRect = body.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      // body must be contained within card bounds
      const contained = bodyRect.left >= cardRect.left - 1 && bodyRect.right <= cardRect.right + 1 &&
                        bodyRect.bottom <= cardRect.bottom + 1 && bodyRect.top >= cardRect.top - 1;
      return { ok: contained, isChild: card.contains(body) };
    });
    ok(containment3.ok && containment3.isChild, 'T3: My Account content contained within the card');
    await page.close();

    // ─── T4: My Account full field set ───
    console.log('\n--- T4: My Account fields ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's4@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    const fields = await page.evaluate(() => {
      return {
        firstName: !!document.getElementById('set-first-name'),
        lastName: !!document.getElementById('set-last-name'),
        email: !!document.getElementById('set-change-email-btn'),
        changePwd: !!document.getElementById('set-change-password-btn'),
        username: !!document.getElementById('set-username'),
        company: !!document.getElementById('set-company-name'),
        save: !!document.getElementById('set-acct-save'),
        signout: !!document.getElementById('set-acct-signout'),
        del: !!document.getElementById('set-acct-delete')
      };
    });
    ok(fields.firstName && fields.lastName && fields.email && fields.changePwd &&
       fields.username && fields.company && fields.save && fields.signout && fields.del,
      'T4: My Account has First/Last Name, Email+Change, Change Password, Username, Company, Save, Sign Out, Delete');
    await page.close();

    // ─── T5: Loads saved values ───
    console.log('\n--- T5: Load saved values ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's5@test.com', 'pass123');
    // Get user id and seed profile via PATCH through the app's own save
    await openSettings(page);
    await expandSection(page, 'account');
    // Save some values
    await page.fill('#set-first-name', 'Henry');
    await page.fill('#set-last-name', 'Smith');
    await page.fill('#set-username', 'hsmith');
    await page.fill('#set-company-name', 'Wild Board Studio');
    await page.click('#set-acct-save');
    await page.waitForTimeout(600);
    // Re-open settings (re-render) and check values reload from mock
    await page.evaluate(() => { document.getElementById('set-first-name').value = ''; });
    await openSettings(page);
    await expandSection(page, 'account');
    await page.waitForTimeout(500);
    const loaded = await page.evaluate(() => ({
      first: document.getElementById('set-first-name')?.value,
      last: document.getElementById('set-last-name')?.value,
      username: document.getElementById('set-username')?.value,
      company: document.getElementById('set-company-name')?.value
    }));
    ok(loaded.first === 'Henry' && loaded.last === 'Smith' && loaded.username === 'hsmith' && loaded.company === 'Wild Board Studio',
      'T5: My Account loads existing saved values from Supabase');
    await page.close();

    // ─── T6: Save updates Supabase ───
    console.log('\n--- T6: Save to Supabase ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's6@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    await page.fill('#set-first-name', 'Jane');
    await page.fill('#set-last-name', 'Doe');
    await page.fill('#set-username', 'jdoe');
    await page.fill('#set-company-name', 'Doe Woodworks');
    await page.click('#set-acct-save');
    await page.waitForTimeout(600);
    const dump = await getMock('/_test/dump');
    const prof = (dump.profiles || []).find(p => p.first_name === 'Jane');
    ok(prof && prof.first_name === 'Jane' && prof.last_name === 'Doe' && prof.username === 'jdoe' && prof.company_name === 'Doe Woodworks',
      'T6: Save button updates first_name, last_name, username, company_name in Supabase');
    await page.close();

    // ─── T7: Change Password ───
    console.log('\n--- T7: Change Password ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's7@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    await page.click('#set-change-password-btn');
    await page.waitForTimeout(600);
    const pwdMsg = await page.evaluate(() => {
      const m = document.getElementById('set-password-msg');
      return { visible: m && m.style.display !== 'none', text: m ? m.textContent : '' };
    });
    ok(pwdMsg.visible && pwdMsg.text.includes('password reset link has been sent'),
      'T7: Change Password sends reset email and shows confirmation');
    await page.close();

    // ─── T8: Delete Account is grey underlined text ───
    console.log('\n--- T8: Delete Account style ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's8@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'account');
    const delStyle = await page.evaluate(() => {
      const btn = document.getElementById('set-acct-delete');
      if(!btn) return null;
      const cs = getComputedStyle(btn);
      return {
        textDecoration: cs.textDecorationLine,
        bg: cs.backgroundColor,
        border: cs.borderStyle
      };
    });
    const isGreyUnderlined = delStyle && delStyle.textDecoration.includes('underline') &&
      (delStyle.bg === 'rgba(0, 0, 0, 0)' || delStyle.bg === 'transparent') &&
      (delStyle.border === 'none' || delStyle.border === '');
    ok(isGreyUnderlined, 'T8: Delete Account is grey underlined text (not red button)');
    await page.close();

    // ─── T9: Pricing Defaults expands, contained ───
    console.log('\n--- T9: Pricing Defaults containment ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's9@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'pricing');
    const containment9 = await page.evaluate(() => {
      const body = document.querySelector('.settings-collapse-body[data-section="pricing"]');
      if(!body || !body.classList.contains('expanded')) return { ok: false };
      const card = body.closest('.settings-card');
      if(!card) return { ok: false, reason: 'no card wrapper' };
      const bodyRect = body.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const contained = bodyRect.left >= cardRect.left - 1 && bodyRect.right <= cardRect.right + 1 &&
                        bodyRect.bottom <= cardRect.bottom + 1 && bodyRect.top >= cardRect.top - 1;
      return { ok: contained, isChild: card.contains(body) };
    });
    ok(containment9.ok && containment9.isChild, 'T9: Pricing Defaults content contained within the card');
    await page.close();

    // ─── T10-T14: Info button placement ───
    async function checkInfoRow(page, dataInfo, name) {
      return await page.evaluate((di) => {
        const btn = document.querySelector('.settings-info-btn[data-info="' + di + '"]');
        if(!btn) return { ok: false, reason: 'no btn' };
        const row = btn.closest('.settings-sub-collapse-hdr') || btn.closest('h3') || btn.parentElement;
        if(!row) return { ok: false, reason: 'no row' };
        const btnRect = btn.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        // Info button center-x should be in right portion of row
        const btnCenterX = btnRect.left + btnRect.width / 2;
        const rowRightPortion = rowRect.left + rowRect.width * 0.5;
        const onRight = btnCenterX > rowRightPortion;
        // Same vertical line as row (vertically within row bounds)
        const sameLine = btnRect.top >= rowRect.top - 2 && btnRect.bottom <= rowRect.bottom + 2;
        return { ok: onRight && sameLine, onRight, sameLine, btnCenterX, rowRightPortion };
      }, dataInfo);
    }

    console.log('\n--- T10-T14: Info button placement ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's10@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'pricing');
    // Expand grain sub-section so End Grain / Complex Pattern render visible
    await page.evaluate(() => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="grain"]');
      if(hdr) hdr.click();
    });
    await page.waitForTimeout(200);

    const t10 = await checkInfoRow(page, 'sa', 'Surface Area');
    ok(t10.ok, 'T10: Surface Area Pricing Tiers — label left, ⓘ far right on same line');
    const t11 = await checkInfoRow(page, 'thick', 'Thickness');
    ok(t11.ok, 'T11: Thickness Tiers — label left, ⓘ far right on same line');
    const t12 = await checkInfoRow(page, 'glue', 'Glue Ups');
    ok(t12.ok, 'T12: Glue Ups — label left, ⓘ far right on same line');
    const t13 = await checkInfoRow(page, 'eg', 'End Grain');
    ok(t13.ok, 'T13: End Grain — label left, ⓘ far right on same line');
    const t14 = await checkInfoRow(page, 'cp', 'Complex Pattern');
    ok(t14.ok, 'T14: Complex Pattern — label left, ⓘ far right on same line');
    await page.close();

    // ─── T15: Existing functionality unchanged ───
    console.log('\n--- T15: Existing functionality ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 's15@test.com', 'pass123');
    await openSettings(page);
    await expandSection(page, 'pricing');
    // Info modal still works
    await page.evaluate(() => {
      const btn = document.querySelector('.settings-info-btn[data-info="sa"]');
      if(btn) btn.click();
    });
    await page.waitForTimeout(200);
    const modalOpen = await page.evaluate(() => {
      const m = document.getElementById('settings-info-modal');
      return m && m.classList.contains('open');
    });
    // Close modal
    await page.evaluate(() => {
      const c = document.getElementById('settings-info-close');
      if(c) c.click();
    });
    await page.waitForTimeout(100);
    // Tier editing: expand surface, add a tier
    await page.evaluate(() => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="surface"]');
      if(hdr) hdr.click();
    });
    await page.waitForTimeout(200);
    const tierCountBefore = await page.evaluate(() => document.querySelectorAll('.set-sa-rate').length);
    await page.evaluate(() => { const b = document.getElementById('set-sa-add'); if(b) b.click(); });
    await page.waitForTimeout(300);
    const tierCountAfter = await page.evaluate(() => document.querySelectorAll('.set-sa-rate').length);
    // Settings save still works
    const saveWorks = await page.evaluate(() => typeof _saveSettingsLocal === 'function' || typeof saveSettingsToSupabase === 'function' || typeof _collectAllSettings === 'function');
    ok(modalOpen && tierCountAfter === tierCountBefore + 1 && saveWorks,
      'T15: Existing Settings functionality unchanged (info modal, tier editing, save)');
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
