const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MOCK_PORT = 8901, STATIC_PORT = 8900;
const BROWSER_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if(!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
function ok(cond, msg) { if(cond){pass++;console.log('  PASS: '+msg);} else {fail++;console.log('  FAIL: '+msg);} }

(async () => {
  const mockProc = spawn('node', [path.join(__dirname, 'mock-supabase.js'), String(MOCK_PORT)], { stdio: ['pipe','pipe','pipe'] });
  await new Promise((res, rej) => { mockProc.stdout.on('data', d => { if(d.toString().includes('listening')) res(); }); setTimeout(()=>rej(new Error('to')), 5000); });

  const srcHtml = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const testHtml = srcHtml
    .replace(/https:\/\/hmywfzcjsatzpuciqmge\.supabase\.co/g, 'http://127.0.0.1:' + MOCK_PORT)
    .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/g, 'http://127.0.0.1:' + STATIC_PORT + '/supabase.umd.js')
    .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/2\.5\.1\/jspdf\.umd\.min\.js/g, 'http://127.0.0.1:' + STATIC_PORT + '/jspdf.umd.min.js');

  const staticServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if(url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, {'Content-Type':'text/html'}); res.end(testHtml); return; }
    const fp = path.join(__dirname, url.pathname);
    if(fs.existsSync(fp) && fs.statSync(fp).isFile()) { const e = path.extname(fp); res.writeHead(200, {'Content-Type': e==='.js'?'application/javascript':'application/json'}); res.end(fs.readFileSync(fp)); return; }
    res.writeHead(404); res.end('nf');
  });
  await new Promise(r => staticServer.listen(STATIC_PORT, r));
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true, args: ['--no-sandbox'] });

  async function signUp(page, email) {
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser === null, { timeout: 5000 }).catch(()=>{});
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });
    const tg = await page.$('#auth-toggle-btn'); if(tg){ const t = await tg.innerText(); if(t.includes('Sign up')) await tg.click(); }
    await page.waitForTimeout(100);
    await page.fill('#auth-email', email); await page.fill('#auth-password', 'pass123');
    const cf = await page.$('#auth-password-confirm'); if(cf) await page.fill('#auth-password-confirm', 'pass123');
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, { timeout: 5000 });
    const wb = await page.$('#auth-welcome-btn'); if(wb) await wb.click();
    await page.waitForTimeout(300);
  }

  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.clear(); });
    await page.goto('http://127.0.0.1:' + STATIC_PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await signUp(page, 'ic1@test.com');
    await page.evaluate(() => showSettings());
    await page.waitForTimeout(300);

    // ── Part 2: circular info icon in Pricing Defaults header (collapsed) ──
    const icon = await page.evaluate(() => {
      const el = document.getElementById('pricing-explainer-open');
      if(!el) return null;
      const cs = getComputedStyle(el);
      const hdr = document.querySelector('.settings-collapse-hdr[data-section="pricing"]');
      const label = hdr.querySelector('.settings-sub-label');
      const chevron = hdr.querySelector('.settings-collapse-chevron');
      const ir = el.getBoundingClientRect(), lr = label.getBoundingClientRect(), cr = chevron.getBoundingClientRect();
      const labelTextRight = (() => {
        // approximate right edge of the "Pricing Defaults" text (first child text node)
        const range = document.createRange();
        range.selectNodeContents(label);
        range.setEnd(el, 0); // up to the icon
        return range.getBoundingClientRect().right;
      })();
      return {
        tag: el.tagName, id: el.id, role: el.getAttribute('role'),
        hasInfoClass: el.classList.contains('settings-info-btn'),
        text: el.textContent.trim(),
        w: Math.round(parseFloat(cs.width)), h: Math.round(parseFloat(cs.height)),
        radius: cs.borderRadius, borderW: cs.borderTopWidth,
        inHeader: hdr.contains(el),
        insideLabel: label.contains(el),
        nearLabelText: Math.abs(ir.left - labelTextRight) < 14,
        onLeftHalf: (ir.left + ir.width/2) < window.innerWidth / 2,
        beforeChevron: ir.right <= cr.left + 1
      };
    });
    ok(icon && icon.tag === 'SPAN' && icon.id === 'pricing-explainer-open' && icon.role === 'button',
      'Icon keeps span, id=pricing-explainer-open, role=button');
    ok(icon && icon.hasInfoClass && icon.text === 'i' && icon.w === 18 && icon.h === 18 && icon.borderW === '1px',
      'Icon is 18px circle with 1px border and "i" (settings-info-btn style)');
    ok(icon && icon.inHeader && icon.insideLabel && icon.nearLabelText && icon.onLeftHalf && icon.beforeChevron,
      'Icon sits just right of the "Pricing Defaults" text on the left, chevron still far right');
    await page.screenshot({ path: path.join(SHOT_DIR, 'pricing-header-icon.png'), fullPage: true });
    console.log('  screenshot: pricing-header-icon.png');

    // Tapping icon opens modal without toggling card
    const wasExpanded = await page.evaluate(() => document.querySelector('.settings-collapse-hdr[data-section="pricing"]').classList.contains('expanded'));
    await page.evaluate(() => document.getElementById('pricing-explainer-open').click());
    await page.waitForTimeout(200);
    const afterIconTap = await page.evaluate(() => ({
      modalOpen: document.getElementById('pricing-explainer-modal').classList.contains('open'),
      cardExpanded: document.querySelector('.settings-collapse-hdr[data-section="pricing"]').classList.contains('expanded')
    }));
    ok(afterIconTap.modalOpen && !wasExpanded && !afterIconTap.cardExpanded,
      'Tapping icon opens modal without toggling the card');
    await page.evaluate(() => document.getElementById('pricing-explainer-close').click());
    await page.waitForTimeout(150);

    // Tapping header elsewhere still toggles
    await page.evaluate(() => document.querySelector('.settings-collapse-hdr[data-section="pricing"]').click());
    await page.waitForTimeout(200);
    const toggled = await page.evaluate(() => document.querySelector('.settings-collapse-hdr[data-section="pricing"]').classList.contains('expanded'));
    ok(toggled, 'Tapping header (not icon) still toggles the card');

    // ── Part 3: sub-section chevrons rotate on expand/collapse ──
    const subs = ['surface','thickness','glue','grain','features','labor','threshold'];
    let allRotate = true; const details = [];
    for(const sub of subs) {
      // ensure collapsed
      const collapsedRot = await page.evaluate((s) => {
        const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="' + s + '"]');
        if(hdr.classList.contains('expanded')) hdr.click();
        const chev = hdr.querySelector('.settings-collapse-chevron');
        return getComputedStyle(chev).transform;
      }, sub);
      await page.waitForTimeout(50);
      await page.evaluate((s) => {
        const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="' + s + '"]');
        hdr.click();
      }, sub);
      await page.waitForTimeout(300);
      const expandedRot = await page.evaluate((s) => {
        const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="' + s + '"]');
        const chev = hdr.querySelector('.settings-collapse-chevron');
        return getComputedStyle(chev).transform;
      }, sub);
      // collapsed transform is 'none' or identity; expanded should be a 90deg matrix (rotate → matrix(0,1,-1,0,0,0))
      const rotates = (collapsedRot === 'none' || collapsedRot === 'matrix(1, 0, 0, 1, 0, 0)') &&
                      expandedRot.startsWith('matrix') && expandedRot !== 'matrix(1, 0, 0, 1, 0, 0)';
      if(!rotates) { allRotate = false; details.push(sub + ':' + collapsedRot + '->' + expandedRot); }
      // collapse back
      await page.evaluate((s) => { const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="' + s + '"]'); if(hdr.classList.contains('expanded')) hdr.click(); }, sub);
      await page.waitForTimeout(30);
    }
    ok(allRotate, 'All 7 sub-section chevrons rotate 90deg on expand' + (allRotate ? '' : ' [' + details.join(' ') + ']'));

    // Screenshot: one sub-section expanded showing rotated chevron
    await page.evaluate(() => document.querySelector('.settings-sub-collapse-hdr[data-sub="surface"]').click());
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOT_DIR, 'subsection-chevron-rotated.png'), fullPage: true });
    console.log('  screenshot: subsection-chevron-rotated.png');

    // ── Part 1: Complex Pattern is fully manual, original wording ──
    // Open a new cutting-board quote — no thickness-count / angled-cuts rows
    await page.evaluate(() => openQuoteEdit());
    await page.waitForSelector('#quote-edit-screen', { timeout: 3000 });
    await page.waitForTimeout(200);
    const revert = await page.evaluate(() => ({
      thickCountRows: document.querySelectorAll('[data-thickcount]').length,
      angledCuts: !!document.getElementById('qe-angled-cuts'),
      hasComplexCheckbox: [...document.querySelectorAll('.qe-co-feat-check')].some(c => c.closest('.quote-feature-row').textContent.includes('Complex Pattern'))
    }));
    ok(revert.thickCountRows === 0 && !revert.angledCuts && revert.hasComplexCheckbox,
      'Revert: no Thickness Count / Angled Cuts rows; Complex Pattern checkbox present and manual');

    // Manual toggle works and holds
    const manual = await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.qe-co-feat-check')].find(c => c.closest('.quote-feature-row').textContent.includes('Complex Pattern'));
      cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true}));
      return cb.checked;
    });
    await page.waitForTimeout(200);
    const stillChecked = await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.qe-co-feat-check')].find(c => c.closest('.quote-feature-row').textContent.includes('Complex Pattern'));
      return cb.checked;
    });
    ok(manual && stillChecked, 'Revert: Complex Pattern checkbox toggles manually and holds');

    // Alert wording restored
    let alertMsg = '';
    page.on('dialog', async d => { alertMsg = d.message(); await d.dismiss(); });
    await page.evaluate(() => { const b = document.getElementById('qe-complex-info'); if(b) b.click(); });
    await page.waitForTimeout(200);
    ok(alertMsg.includes('three or more different thicknesses'), 'Revert: complex-pattern alert restored to "three or more" wording');

    await page.close();
  } catch(err) { console.error('FATAL:', err); fail++; }
  finally {
    await browser.close(); staticServer.close(); mockProc.kill();
    console.log('\nRESULTS: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
