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

  try {
    await postMock('/_test/reset', {});
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.clear(); });
    await page.goto('http://127.0.0.1:' + STATIC_PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    // sign up
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { timeout: 3000 });
    const toggleBtn = await page.$('#auth-toggle-btn');
    if(toggleBtn) { const txt = await toggleBtn.innerText(); if(txt.includes('Sign up')) await toggleBtn.click(); }
    await page.waitForTimeout(100);
    await page.fill('#auth-email', 'seam@test.com');
    await page.fill('#auth-password', 'pass123');
    const cf = await page.$('#auth-password-confirm');
    if(cf) await page.fill('#auth-password-confirm', 'pass123');
    await page.click('#auth-submit-btn');
    await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, { timeout: 5000 });
    const wb = await page.$('#auth-welcome-btn');
    if(wb) await wb.click();
    await page.waitForTimeout(300);

    await page.evaluate(() => showSettings());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('.settings-collapse-hdr[data-section="pricing"]').click());
    await page.waitForTimeout(200);

    // ─── Collapsed state: fully rounded ───
    const collapsed = await page.evaluate(() => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="labor"]');
      const cs = getComputedStyle(hdr);
      return { br: cs.borderRadius, bb: cs.borderBottomLeftRadius };
    });
    ok(collapsed.br === '8px' && collapsed.bb === '8px', 'Collapsed: header fully rounded (' + collapsed.br + ')');

    // ─── Expand Labor Rates ───
    await page.evaluate(() => document.querySelector('.settings-sub-collapse-hdr[data-sub="labor"]').click());
    await page.waitForTimeout(200);

    const expanded = await page.evaluate(() => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="labor"]');
      const body = document.querySelector('.settings-sub-collapse-body[data-sub="labor"]');
      const hcs = getComputedStyle(hdr);
      const bcs = getComputedStyle(body);
      const hr = hdr.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      return {
        hdrTopRadius: hcs.borderTopLeftRadius,
        hdrBottomRadius: hcs.borderBottomLeftRadius,
        bodyTopRadius: bcs.borderTopLeftRadius,
        bodyBottomRadius: bcs.borderBottomLeftRadius,
        hdrBorderBottom: hcs.borderBottomWidth,
        bodyBorderTop: bcs.borderTopWidth,
        gap: br.top - hr.bottom,
        leftAligned: Math.abs(hr.left - br.left) < 0.5,
        rightAligned: Math.abs(hr.right - br.right) < 0.5,
        saveCentered: (() => {
          const save = document.querySelector('.set-sub-save[data-sub="labor"]');
          if(!save) return false;
          const sr = save.getBoundingClientRect();
          const saveCenter = sr.left + sr.width / 2;
          const bodyCenter = br.left + br.width / 2;
          return Math.abs(saveCenter - bodyCenter) < 2;
        })()
      };
    });
    ok(expanded.hdrTopRadius === '8px' && expanded.hdrBottomRadius === '0px',
      'Expanded: header radius 8px top / 0 bottom (got top ' + expanded.hdrTopRadius + ', bottom ' + expanded.hdrBottomRadius + ')');
    ok(expanded.bodyTopRadius === '0px' && expanded.bodyBottomRadius === '8px',
      'Expanded: body radius 0 top / 8px bottom (got top ' + expanded.bodyTopRadius + ', bottom ' + expanded.bodyBottomRadius + ')');
    ok(Math.abs(expanded.gap) < 0.5, 'Expanded: body flush to header, no gap (gap=' + expanded.gap + 'px)');
    ok(expanded.hdrBorderBottom === '0px' && expanded.bodyBorderTop === '0px',
      'Expanded: no double border at the seam (hdr-bottom=' + expanded.hdrBorderBottom + ', body-top=' + expanded.bodyBorderTop + ')');
    ok(expanded.leftAligned && expanded.rightAligned, 'Expanded: header and body edges aligned');
    ok(expanded.saveCentered, 'Save button centered horizontally in body');

    // Screenshot: Labor Rates expanded
    await page.screenshot({ path: path.join(SHOT_DIR, 'labor-expanded-seamless.png'), fullPage: true });
    console.log('  screenshot: labor-expanded-seamless.png');

    // ─── All 7 sub-sections have outside ⓘ ───
    const allInfo = await page.evaluate(() => {
      const subs = ['labor','surface','thickness','glue','grain','features','threshold'];
      const infos = ['labor','sa','thick','glue','grain','feat','minq'];
      const results = subs.map((sub, i) => {
        const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="' + sub + '"]');
        const ibtn = document.querySelector('.settings-info-btn[data-info="' + infos[i] + '"]');
        const row = hdr ? hdr.closest('.settings-sub-hdr-row') : null;
        const body = document.querySelector('.settings-sub-collapse-body[data-sub="' + sub + '"]');
        return {
          sub,
          outside: !!(ibtn && hdr && !hdr.contains(ibtn) && row && row.contains(ibtn)),
          hasInfoClass: !!(body && body.classList.contains('has-info'))
        };
      });
      return results;
    });
    ok(allInfo.every(r => r.outside && r.hasInfoClass),
      'All 7 sub-sections have outside ⓘ + has-info body (' + allInfo.filter(r=>r.outside).length + '/7)');

    // ─── ⓘ opens modal with correct hint text (labor + glue + minq spot checks) ───
    async function checkModal(dataInfo, phrase) {
      await page.evaluate((di) => document.querySelector('.settings-info-btn[data-info="' + di + '"]').click(), dataInfo);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        const m = document.getElementById('settings-info-modal');
        return { open: m && m.classList.contains('open'), text: m ? m.querySelector('#settings-info-text').textContent : '' };
      });
      await page.evaluate(() => document.getElementById('settings-info-close').click());
      await page.waitForTimeout(100);
      return r.open && r.text.includes(phrase);
    }
    ok(await checkModal('labor', 'never shared with the customer'), 'Labor Rates ⓘ shows its hint text');
    ok(await checkModal('grain', 'premium standard in cutting board craft'), 'Grain & Pattern ⓘ shows its hint text');
    ok(await checkModal('feat', 'fixed dollar amounts'), 'Feature Add-Ons ⓘ shows its hint text');
    ok(await checkModal('minq', 'minimum quote amount'), 'Minimum Quote Threshold ⓘ shows its hint text');
    ok(await checkModal('glue', 'initial long grain panel'), 'Glue Ups ⓘ shows updated hint text');
    ok(await checkModal('sa', 'excludes its upper limit'), 'Surface Area ⓘ shows updated hint text');
    ok(await checkModal('thick', 'more raw lumber to mill down'), 'Thickness ⓘ shows updated hint text');

    // ─── Multi-paragraph rendering in info modal ───
    await page.evaluate(() => document.querySelector('.settings-info-btn[data-info="grain"]').click());
    await page.waitForTimeout(150);
    const para = await page.evaluate(() => {
      const el = document.getElementById('settings-info-text');
      return { ws: getComputedStyle(el).whiteSpace, hasBreaks: el.textContent.includes('\n\n') };
    });
    await page.evaluate(() => document.getElementById('settings-info-close').click());
    ok(para.ws === 'pre-line' && para.hasBreaks, 'Hint text renders paragraphs separated by blank lines');

    // ─── Sub-section order: labor after features, before threshold ───
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('.settings-sub-collapse-hdr')].map(h => h.getAttribute('data-sub'))
    );
    ok(JSON.stringify(order) === JSON.stringify(['surface','thickness','glue','grain','features','labor','threshold']),
      'Section order: Labor Rates after Feature Add-Ons, before Minimum Quote Threshold (' + order.join(',') + ')');

    // ─── Explainer link lives in the Pricing Defaults header row ───
    // Collapse the Pricing Defaults card first so we test the header state.
    await page.evaluate(() => {
      const hdr = document.querySelector('.settings-collapse-hdr[data-section="pricing"]');
      if(hdr && hdr.classList.contains('expanded')) hdr.click();
    });
    await page.waitForTimeout(200);
    const link = await page.evaluate(() => {
      const el = document.getElementById('pricing-explainer-open');
      if(!el) return null;
      const cs = getComputedStyle(el);
      const hdr = document.querySelector('.settings-collapse-hdr[data-section="pricing"]');
      const chevron = hdr ? hdr.querySelector('.settings-collapse-chevron') : null;
      const lr = el.getBoundingClientRect();
      const cr = chevron ? chevron.getBoundingClientRect() : null;
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        underlined: cs.textDecorationLine.includes('underline'),
        small: Math.round(parseFloat(cs.fontSize)) === 12,
        muted: cs.color,
        inHeader: !!(hdr && hdr.contains(el)),
        leftOfChevron: cr ? (lr.right <= cr.left + 1) : false,
        sameRow: cr ? Math.abs((lr.top + lr.height/2) - (cr.top + cr.height/2)) < 3 : false
      };
    });
    ok(link && link.tag === 'SPAN' && link.role === 'button' && link.underlined && link.small,
      'Explainer is a 12px underlined span with role=button (not a button element)');
    ok(link && link.inHeader && link.leftOfChevron && link.sameRow,
      'Explainer link sits in the header row, just left of the chevron, vertically centered');

    // Screenshot: collapsed Pricing Defaults header with link + chevron side by side
    await page.screenshot({ path: path.join(SHOT_DIR, 'pricing-header-link.png'), fullPage: true });
    console.log('  screenshot: pricing-header-link.png');

    // Tapping the link opens the modal WITHOUT toggling the card
    const wasExpanded = await page.evaluate(() =>
      document.querySelector('.settings-collapse-hdr[data-section="pricing"]').classList.contains('expanded'));
    await page.evaluate(() => document.getElementById('pricing-explainer-open').click());
    await page.waitForTimeout(200);
    const explainer = await page.evaluate(() => {
      const m = document.getElementById('pricing-explainer-modal');
      const txt = m ? m.textContent : '';
      const hdr = document.querySelector('.settings-collapse-hdr[data-section="pricing"]');
      return {
        open: m && m.classList.contains('open'),
        cardStillCollapsed: !hdr.classList.contains('expanded'),
        p1: txt.includes('built in layers, starting with a base price'),
        p2: txt.includes('not from the running total'),
        p3: txt.includes('after all percentage increases have been applied'),
        p4: txt.includes('calculated separately and added to arrive at your final quote total'),
        paraCount: m ? m.querySelectorAll('.pricing-modal-body p').length : 0
      };
    });
    ok(explainer.open && explainer.p1 && explainer.p2 && explainer.p3 && explainer.p4 && explainer.paraCount === 4,
      'Explainer modal shows the 4 updated paragraphs');
    ok(!wasExpanded && explainer.cardStillCollapsed,
      'Tapping the link opens the modal without toggling the Pricing Defaults card');
    await page.evaluate(() => document.getElementById('pricing-explainer-close').click());
    await page.waitForTimeout(150);

    // Tapping the header (not the link) toggles the card as normal
    await page.evaluate(() => document.querySelector('.settings-collapse-hdr[data-section="pricing"]').click());
    await page.waitForTimeout(200);
    const toggled = await page.evaluate(() =>
      document.querySelector('.settings-collapse-hdr[data-section="pricing"]').classList.contains('expanded'));
    ok(toggled, 'Tapping the header row (not the link) still toggles the card');

    // ─── + Add Glue Up ───
    await page.evaluate(() => document.querySelector('.settings-sub-collapse-hdr[data-sub="glue"]').click());
    await page.waitForTimeout(200);
    const glueBefore = await page.evaluate(() => document.querySelectorAll('.set-glue-mod').length);
    await page.evaluate(() => document.getElementById('set-glue-add').click());
    await page.waitForTimeout(300);
    const glueAfter = await page.evaluate(() => {
      const inputs = document.querySelectorAll('.set-glue-mod');
      const last = inputs[inputs.length - 1];
      const bodyOpen = document.querySelector('.settings-sub-collapse-body[data-sub="glue"]').classList.contains('expanded');
      return { count: inputs.length, lastVal: last.value, editable: !last.disabled, bodyOpen };
    });
    ok(glueAfter.count === glueBefore + 1 && glueAfter.editable && glueAfter.bodyOpen,
      '+ Add Glue Up adds editable row beyond 5 (' + glueBefore + ' → ' + glueAfter.count + ', last=' + glueAfter.lastVal + '%)');
    // Edit the new row and confirm it persists through collect
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('.set-glue-mod');
      inputs[inputs.length - 1].value = '42';
      _collectAllSettings();
    });
    const persisted = await page.evaluate(() => {
      const arr = _getSettings().multipliers.glueUps;
      return { len: arr.length, last: arr[arr.length - 1] };
    });
    ok(persisted.len === glueAfter.count && Math.abs(persisted.last - 0.42) < 0.001,
      'New glue-up modifier is editable and collected (last=' + persisted.last + ')');
    await page.evaluate(() => document.querySelector('.settings-sub-collapse-hdr[data-sub="glue"]').click());
    await page.waitForTimeout(200);

    // ─── Save → collapses, corners restore ───
    await page.evaluate(() => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="labor"]');
      if(hdr && !hdr.classList.contains('expanded')) hdr.click();
    });
    await page.waitForTimeout(200);
    await page.click('.set-sub-save[data-sub="labor"]');
    await page.waitForTimeout(1800);
    const after = await page.evaluate(() => {
      const hdr = document.querySelector('.settings-sub-collapse-hdr[data-sub="labor"]');
      const body = document.querySelector('.settings-sub-collapse-body[data-sub="labor"]');
      const cs = getComputedStyle(hdr);
      return {
        collapsed: !body.classList.contains('expanded'),
        radius: cs.borderRadius,
        bottomRadius: cs.borderBottomLeftRadius
      };
    });
    ok(after.collapsed && after.radius === '8px' && after.bottomRadius === '8px',
      'After Save: collapsed, corners fully rounded again (' + after.radius + ')');

    await page.screenshot({ path: path.join(SHOT_DIR, 'labor-collapsed-after-save.png'), fullPage: false });
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
