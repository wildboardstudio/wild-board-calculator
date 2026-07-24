const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MOCK_PORT = 8901, STATIC_PORT = 8900;
const BROWSER_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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

  function postMock(mp, body) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const req = http.request({ hostname:'127.0.0.1', port:MOCK_PORT, path:mp, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} }, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));}); req.on('error',reject); req.write(data); req.end(); }); }
  async function resetMock() { await postMock('/_test/reset', {}); }

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
  async function freshPage() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.clear(); });
    page.on('console', m => { if(m.type()==='error' && !m.text().includes('404') && !m.text().includes('favicon') && !m.text().includes('ERR_BLOCKED')) console.log('[ERR]', m.text()); });
    await page.goto('http://127.0.0.1:' + STATIC_PORT + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    return page;
  }

  try {
    // ── T1: Migration ──
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'h1@test.com');
    const mig = await page.evaluate(() => {
      projectsData = [
        { id: 'p1', name: 'Kitchen', rate: 40, status: 'active' },
        { id: 'p2', name: 'Deck', rate: 0, status: 'active' }
      ];
      hoursData = { rate: 30, sessions: [
        { id: 's1', projectId: 'p1', date: '2025-01-02', start: '09:00', end: '11:00', breaks: [] },
        { id: 's2', projectId: 'p1', date: '2025-01-03', start: '13:00', end: '14:00', breaks: [] },
        { id: 's3', projectId: 'p2', date: '2025-01-04', start: '10:00', end: '12:00', breaks: [] }
      ], logs: [] };
      _migrateHoursLogs();
      const logs = hoursData.logs;
      const allAssigned = hoursData.sessions.every(s => !!s.logId);
      const p1log = logs.find(l => l.projectId === 'p1');
      const p2log = logs.find(l => l.projectId === 'p2');
      return {
        logCount: logs.length,
        allAssigned,
        sessionCount: hoursData.sessions.length,
        p1title: p1log && p1log.title, p1rate: p1log && p1log.rate,
        p2title: p2log && p2log.title, p2rate: p2log && p2log.rate,
        p1sessions: hoursData.sessions.filter(s => s.logId === (p1log && p1log.id)).length,
        p2sessions: hoursData.sessions.filter(s => s.logId === (p2log && p2log.id)).length,
        projectIdsIntact: hoursData.sessions.every(s => s.projectId)
      };
    });
    ok(mig.logCount === 2 && mig.allAssigned && mig.sessionCount === 3, 'T1a: One Log per project, all sessions assigned, none lost');
    ok(mig.p1title === 'Sessions from Kitchen' && mig.p1rate === 40, 'T1b: p1 Log titled + rate from _projGetRate (40)');
    ok(mig.p2title === 'Sessions from Deck' && mig.p2rate === 30, 'T1c: p2 Log falls back to hoursData.rate (30)');
    ok(mig.p1sessions === 2 && mig.p2sessions === 1 && mig.projectIdsIntact, 'T1d: sessions grouped correctly; projectId untouched');
    // Idempotent
    const idem = await page.evaluate(() => { const before = hoursData.logs.length; const changed = _migrateHoursLogs(); return { changed, after: hoursData.logs.length }; });
    ok(idem.changed === false && idem.after === 2, 'T1e: migration idempotent (no new logs on 2nd run)');
    await page.close();

    // ── T2: Landing tile opens Hours tool ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'h2@test.com');
    const tile = await page.evaluate(() => !!document.querySelector('.feature-card[aria-label="Hours"]'));
    ok(tile, 'T2a: Hours tile present on landing');
    await page.evaluate(() => { const c = document.querySelector('.feature-card[aria-label="Hours"]'); c.click(); });
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => ({
      visible: document.getElementById('hours-screen').style.display !== 'none',
      title: document.getElementById('hours-screen-title').textContent,
      newBtn: !!document.getElementById('hours-new-log-btn'),
      empty: document.getElementById('hours-body').textContent.includes('No logs yet')
    }));
    ok(opened.visible && opened.title === 'Hours' && opened.newBtn && opened.empty, 'T2b: Hours tool opens with empty logs list + New Log');
    await page.close();

    // ── T3: New Log — title required, rate prefill, with/without project ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'h3@test.com');
    await page.evaluate(() => {
      const s = _getSettings(); s.defaultShopRate = 55; localStorage.setItem('wbc_settings', JSON.stringify(s));
      projectsData = [{ id: 'pA', name: 'Alpha', status: 'active' }];
      showHoursTool();
    });
    await page.waitForTimeout(200);
    await page.click('#hours-new-log-btn');
    await page.waitForTimeout(200);
    const prefill = await page.evaluate(() => ({
      rate: document.getElementById('log-rate-input').value,
      hasProjectOpt: [...document.getElementById('log-project-input').options].some(o => o.textContent === 'Alpha'),
      noneOpt: document.getElementById('log-project-input').options[0].textContent
    }));
    ok(prefill.rate === '55' && prefill.hasProjectOpt && prefill.noneOpt === 'None', 'T3a: rate prefills from defaultShopRate (55); project dropdown w/ None');
    // Title required
    await page.click('#log-modal-save');
    await page.waitForTimeout(150);
    const titleReq = await page.evaluate(() => document.getElementById('log-modal-error').style.display !== 'none');
    ok(titleReq, 'T3b: Title required — save blocked when empty');
    // Create standalone log with edited rate
    await page.fill('#log-title-input', 'Standalone Log');
    await page.fill('#log-rate-input', '70');
    await page.click('#log-modal-save');
    await page.waitForTimeout(300);
    const created = await page.evaluate(() => {
      const log = hoursData.logs.find(l => l.title === 'Standalone Log');
      const card = log ? document.querySelector('.hours-log-card[data-log-id="' + log.id + '"]') : null;
      const detailInCard = !!(card && card.querySelector('.hours-log-detail'));
      return { exists: !!log, projectId: log && log.projectId, rate: log && log.rate, detailInCard, titleStaysHours: document.getElementById('hours-screen-title').textContent === 'Hours' };
    });
    ok(created.exists && created.projectId === null && created.rate === 70 && created.detailInCard && created.titleStaysHours,
      'T3c: standalone Log created w/ edited rate 70; detail expands inside its card (title stays "Hours")');
    await page.close();

    // ── T4: Log with project link + rate divergence ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'h4@test.com');
    await page.evaluate(() => {
      const s = _getSettings(); s.defaultShopRate = 50; localStorage.setItem('wbc_settings', JSON.stringify(s));
      projectsData = [{ id: 'pX', name: 'Xproj', status: 'active' }];
      showHoursTool();
    });
    await page.waitForTimeout(200);
    await page.click('#hours-new-log-btn');
    await page.waitForTimeout(200);
    await page.fill('#log-title-input', 'Linked Log');
    await page.selectOption('#log-project-input', 'pX');
    await page.fill('#log-rate-input', '90'); // diverge from default 50
    await page.click('#log-modal-save');
    await page.waitForTimeout(300);
    const linked = await page.evaluate(() => {
      const log = hoursData.logs.find(l => l.title === 'Linked Log');
      return { projectId: log.projectId, rate: log.rate, defaultRate: _getSettings().defaultShopRate };
    });
    ok(linked.projectId === 'pX' && linked.rate === 90 && linked.defaultRate === 50, 'T4: Log links project + rate diverges from global default (90 vs 50)');
    await page.close();

    // ── T5: Log detail — add session, list totals, most-recent-first list ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'h5@test.com');
    await page.evaluate(() => {
      projectsData = [{ id: 'pY', name: 'Yproj', status: 'active' }];
      hoursData = { rate: 0, sessions: [], logs: [
        { id: 'L1', title: 'Old Log', projectId: null, rate: 20, createdAt: '2025-01-01T00:00:00Z' },
        { id: 'L2', title: 'New Log', projectId: 'pY', rate: 100, createdAt: '2025-02-01T00:00:00Z' }
      ]};
      showHoursTool();
    });
    await page.waitForTimeout(200);
    const listOrder = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.hours-log-card')];
      return { count: cards.length, first: cards[0].textContent, last: cards[cards.length-1].textContent };
    });
    ok(listOrder.count === 2 && listOrder.first.includes('New Log') && listOrder.last.includes('Old Log'), 'T5a: logs listed most-recent-first');
    ok(listOrder.first.includes('Yproj'), 'T5b: linked project name shown on card');
    // Tap the L2 header to expand inline; detail must live INSIDE the L2 card
    await page.evaluate(() => document.querySelector('.hours-log-header[data-log-id="L2"]').click());
    await page.waitForTimeout(200);
    const accordion = await page.evaluate(() => {
      const l2card = document.querySelector('.hours-log-card[data-log-id="L2"]');
      const l1card = document.querySelector('.hours-log-card[data-log-id="L1"]');
      const detail = document.querySelector('.hours-log-detail');
      return {
        detailInsideL2: !!(l2card && l2card.querySelector('.hours-log-detail')),
        onlyOneDetail: document.querySelectorAll('.hours-log-detail').length === 1,
        l1NotExpanded: !!(l1card && !l1card.querySelector('.hours-log-detail')),
        stillListed: document.querySelectorAll('.hours-log-card').length === 2,
        titleHours: document.getElementById('hours-screen-title').textContent === 'Hours'
      };
    });
    ok(accordion.detailInsideL2 && accordion.onlyOneDetail && accordion.l1NotExpanded && accordion.stillListed && accordion.titleHours,
      'T5c: tapping a log expands its detail INSIDE its card; list stays, title stays "Hours"');
    // Add a session (2 hrs @ 100 = $200) via the in-card + Log Session
    await page.click('.hours-log-add-session-btn[data-log-id="L2"]');
    await page.waitForTimeout(200);
    await page.fill('#hours-log-date', '2025-02-05');
    await page.fill('#hours-log-start', '09:00');
    await page.fill('#hours-log-end', '11:00');
    await page.click('#hours-log-save');
    await page.waitForTimeout(300);
    const afterSession = await page.evaluate(() => {
      const sess = hoursData.sessions.filter(s => s.logId === 'L2');
      const l2card = document.querySelector('.hours-log-card[data-log-id="L2"]');
      const cardText = l2card ? l2card.textContent : '';
      return { count: sess.length, logId: sess[0] && sess[0].logId, projectId: sess[0] && sess[0].projectId, showsCost: cardText.includes('200.00'), showsHrs: cardText.includes('2.0 hrs'), stillExpanded: !!(l2card && l2card.querySelector('.hours-log-detail')) };
    });
    ok(afterSession.count === 1 && afterSession.logId === 'L2' && afterSession.projectId === 'pY', 'T5d: +Log Session adds session w/ logId + inherited projectId');
    ok(afterSession.showsCost && afterSession.showsHrs && afterSession.stillExpanded, 'T5e: totals shown inside the card; card stays expanded after adding');
    await page.close();

    // ── T6: Edit log, delete session, delete log ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'h6@test.com');
    await page.evaluate(() => {
      projectsData = [{ id: 'pZ', name: 'Zed', status: 'active' }];
      hoursData = { rate: 0, sessions: [
        { id: 'sd1', projectId: 'pZ', logId: 'LG', date: '2025-03-01', start: '09:00', end: '10:00', breaks: [] }
      ], logs: [{ id: 'LG', title: 'Edit Me', projectId: 'pZ', rate: 25, createdAt: '2025-03-01T00:00:00Z' }] };
      window.confirm = () => true;
      showHoursTool();
      openHoursLog('LG');
    });
    await page.waitForTimeout(200);
    // Edit via the in-card Edit button
    await page.click('.hours-log-edit-btn[data-log-id="LG"]');
    await page.waitForTimeout(200);
    await page.fill('#log-title-input', 'Edited Title');
    await page.fill('#log-rate-input', '35');
    await page.click('#log-modal-save');
    await page.waitForTimeout(300);
    const editedLog = await page.evaluate(() => {
      const l = hoursData.logs.find(x=>x.id==='LG');
      const card = document.querySelector('.hours-log-card[data-log-id="LG"]');
      return { title: l.title, rate: l.rate, stillExpanded: !!(card && card.querySelector('.hours-log-detail')) };
    });
    ok(editedLog.title === 'Edited Title' && editedLog.rate === 35 && editedLog.stillExpanded, 'T6a: Log title + rate edited; card stays expanded');
    // Delete session (appConfirm uses custom modal, not window.confirm) — click Delete then confirm button
    const delSessResult = await page.evaluate(() => {
      const btn = document.querySelector('[data-log-del-session="sd1"]');
      if(!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    });
    await page.waitForTimeout(200);
    // appConfirm renders an overlay with confirm button #ac-ok
    await page.evaluate(() => { const b = document.getElementById('ac-ok'); if(b) b.click(); });
    await page.waitForTimeout(300);
    const afterDelSess = await page.evaluate(() => hoursData.sessions.filter(s => s.id === 'sd1').length);
    ok(afterDelSess === 0, 'T6b: session deleted from log');
    // Delete whole log via in-card Delete Log
    await page.evaluate(() => { const b = document.querySelector('.hours-log-delete-btn[data-log-id="LG"]'); if(b) b.click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b = document.getElementById('ac-ok'); if(b) b.click(); });
    await page.waitForTimeout(300);
    const afterDelLog = await page.evaluate(() => ({ logs: hoursData.logs.length, noCards: document.querySelectorAll('.hours-log-card').length === 0, titleHours: document.getElementById('hours-screen-title').textContent === 'Hours' }));
    ok(afterDelLog.logs === 0 && afterDelLog.noCards && afterDelLog.titleHours, 'T6c: whole Log deleted (with its sessions), card removed from list');
    await page.close();

    // ── T7: Project detail summary unchanged + View in Hours Tracker filters ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'h7@test.com');
    await page.evaluate(() => {
      projectsData = [
        { id: 'pp1', name: 'ProjOne', rate: 40, status: 'active', date: '2025-01-01' },
        { id: 'pp2', name: 'ProjTwo', rate: 40, status: 'active', date: '2025-01-01' }
      ];
      hoursData = { rate: 0, sessions: [
        { id: 'x1', projectId: 'pp1', logId: 'PL1', date: '2025-01-02', start: '09:00', end: '11:00', breaks: [] },
        { id: 'x2', projectId: 'pp2', logId: 'PL2', date: '2025-01-02', start: '09:00', end: '10:00', breaks: [] }
      ], logs: [
        { id: 'PL1', title: 'Sessions from ProjOne', projectId: 'pp1', rate: 40, createdAt: '2025-01-02T00:00:00Z' },
        { id: 'PL2', title: 'Sessions from ProjTwo', projectId: 'pp2', rate: 40, createdAt: '2025-01-02T00:00:00Z' }
      ]};
      openProjectDetail('pp1');
    });
    await page.waitForTimeout(300);
    const projSummary = await page.evaluate(() => {
      const body = document.getElementById('proj-hours-body').textContent;
      // pp1: 2 hrs @ $40 = $80
      return { has2hrs: body.includes('2.0 hrs'), has80: body.includes('80.00'), hasViewLink: !!document.getElementById('proj-view-hours-btn') };
    });
    ok(projSummary.has2hrs && projSummary.has80, 'T7a: Project Hours summary unchanged (2.0 hrs · $80)');
    ok(projSummary.hasViewLink, 'T7b: "View in Hours Tracker" link present');
    await page.click('#proj-view-hours-btn');
    await page.waitForTimeout(300);
    const filtered = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.hours-log-card')];
      return { count: cards.length, titles: cards.map(c => c.textContent), filterNote: document.getElementById('hours-body').textContent.includes('ProjOne') };
    });
    ok(filtered.count === 1 && filtered.titles[0].includes('ProjOne') && !filtered.titles.join().includes('ProjTwo'),
      'T7c: View in Hours Tracker filters to only this project\'s log');
    await page.close();

    // ── T8: Persistence of logs to Supabase ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'h8@test.com');
    await page.evaluate(() => { projectsData = []; showHoursTool(); });
    await page.waitForTimeout(150);
    await page.click('#hours-new-log-btn');
    await page.waitForTimeout(150);
    await page.fill('#log-title-input', 'Persist Log');
    await page.fill('#log-rate-input', '45');
    await page.click('#log-modal-save');
    await page.waitForTimeout(500);
    const dump = await (async () => { const r = await fetch('http://127.0.0.1:'+MOCK_PORT+'/_test/dump'); return r.json(); })();
    const hoursRow = (dump.hours || []).find(h => h.data && Array.isArray(h.data.logs) && h.data.logs.some(l => l.title === 'Persist Log'));
    ok(!!hoursRow, 'T8: new Log persisted to Supabase (hours row)');
    await page.close();

  } catch(err) { console.error('FATAL:', err); fail++; }
  finally {
    await browser.close(); staticServer.close(); mockProc.kill();
    console.log('\nRESULTS: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
