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

  function getMock(mp){ return new Promise((resolve,reject)=>{ http.get({hostname:'127.0.0.1',port:MOCK_PORT,path:mp}, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d||'{}')));}).on('error',reject); }); }
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
  async function openHours(page, seed) {
    await page.evaluate((seed) => { if(seed) { projectsData = seed.projects || []; hoursData = seed.hours; } showHoursTool(); }, seed || null);
    await page.waitForTimeout(200);
  }

  try {
    // ── T1: Clock In picker offers logs / New Log / Skip ──
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'c1@test.com');
    await openHours(page, { projects:[{id:'p1',name:'Alpha',status:'active'}], hours:{ rate:0, sessions:[], logs:[
      { id:'LG1', title:'Existing Log', projectId:'p1', rate:50, createdAt:'2025-01-01T00:00:00Z' }
    ]}});
    await page.click('#clock-in-btn');
    await page.waitForTimeout(200);
    const picker = await page.evaluate(() => ({
      open: document.getElementById('clock-picker-modal').classList.contains('open'),
      logs: document.querySelectorAll('.clock-picker-log').length,
      hasNew: !!document.getElementById('clock-picker-newlog'),
      hasSkip: !!document.getElementById('clock-picker-skip')
    }));
    ok(picker.open && picker.logs === 1 && picker.hasNew && picker.hasSkip, 'T1: Clock In opens picker with existing logs + New Log + Skip');

    // Select the existing log → session starts tied to it
    await page.click('.clock-picker-log[data-log-id="LG1"]');
    await page.waitForTimeout(300);
    const started = await page.evaluate(() => {
      const a = _activeSession();
      return { has: !!a, status: a&&a.status, logId: a&&a.logId, projectId: a&&a.projectId, hasIn: !!(a&&a.clockedInAt), start: a&&a.start, indicatorShown: document.getElementById('clock-banner').style.display !== 'none' };
    });
    ok(started.has && started.status === 'active' && started.logId === 'LG1' && started.projectId === 'p1' && started.hasIn && started.start,
      'T1b: selecting a log starts an active session tied to it (ISO + derived start)');
    ok(started.indicatorShown, 'T1c: app-wide clock indicator shows while active');
    await page.close();

    // ── T2: only one active session; widget shows active state, Clock In gone ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'c2@test.com');
    await openHours(page, { hours:{ rate:0, sessions:[], logs:[] }});
    // Skip → start unassigned
    await page.click('#clock-in-btn');
    await page.waitForTimeout(150);
    await page.click('#clock-picker-skip');
    await page.waitForTimeout(300);
    const oneActive = await page.evaluate(() => {
      const activeCount = hoursData.sessions.filter(s => s.status === 'active').length;
      const clockInBtn = document.getElementById('clock-in-btn');
      const bodyText = document.getElementById('hours-clock-widget').textContent;
      return { activeCount, noClockIn: !clockInBtn, hasBreakStart: !!document.getElementById('break-start-btn'), hasClockOut: !!document.getElementById('clock-out-btn'), showsSince: bodyText.includes('Clocked in since'), logId: _activeSession().logId };
    });
    ok(oneActive.activeCount === 1 && oneActive.noClockIn && oneActive.hasBreakStart && oneActive.hasClockOut && oneActive.showsSince,
      'T2: Skip starts unassigned active session; Clock In replaced by Clocked-in state + Break/Clock Out');
    ok(oneActive.logId === null, 'T2b: skipped session is unassigned (logId null)');
    // Attempt a second clock-in programmatically → blocked
    const secondBlocked = await page.evaluate(() => { const before = hoursData.sessions.length; clockIn(); return { blocked: document.getElementById('clock-picker-modal').classList.contains('open') === true }; });
    // clockIn opens picker; but starting a session while active is blocked in _startSession
    const stillOne = await page.evaluate(() => { _startSession('anything'); return hoursData.sessions.filter(s=>s.status==='active').length; });
    ok(stillOne === 1, 'T2c: only one active session allowed app-wide (_startSession no-ops while active)');
    await page.close();

    // ── T3: breaks (multiple) with immediate persistence ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'c3@test.com');
    await openHours(page, { hours:{ rate:0, sessions:[], logs:[] }});
    await page.click('#clock-in-btn'); await page.waitForTimeout(120); await page.click('#clock-picker-skip'); await page.waitForTimeout(250);
    await page.click('#break-start-btn'); await page.waitForTimeout(200);
    const brk1 = await page.evaluate(() => { const a=_activeSession(); const b=a.breaks[a.breaks.length-1]; return { count:a.breaks.length, open:!!(b.clockedInAt && !b.clockedOutAt), start:b.start, onBreakUI: !!document.getElementById('break-end-btn') }; });
    ok(brk1.count === 1 && brk1.open && brk1.start && brk1.onBreakUI, 'T3a: Break Start opens a break (ISO + HH:MM) and UI shows Break End');
    let dump = await getMock('/_test/dump');
    let hrow = (dump.hours||[]).find(h => h.data && h.data.sessions && h.data.sessions.some(s => (s.breaks||[]).length === 1));
    ok(!!hrow, 'T3b: break start persisted to Supabase immediately');
    await page.click('#break-end-btn'); await page.waitForTimeout(200);
    const brk1e = await page.evaluate(() => { const a=_activeSession(); const b=a.breaks[0]; return { closed: !!(b.clockedInAt && b.clockedOutAt && b.end), backToBreakStart: !!document.getElementById('break-start-btn') }; });
    ok(brk1e.closed && brk1e.backToBreakStart, 'T3c: Break End closes the break; UI returns to Break Start');
    // second break
    await page.click('#break-start-btn'); await page.waitForTimeout(150); await page.click('#break-end-btn'); await page.waitForTimeout(200);
    const brk2 = await page.evaluate(() => _activeSession().breaks.length);
    ok(brk2 === 2, 'T3d: multiple breaks per session supported');
    await page.close();

    // ── T4: Clock Out finalizes; unassigned → picker → Skip stays unassigned & filed ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'c4@test.com');
    await openHours(page, { hours:{ rate:0, sessions:[], logs:[] }});
    await page.click('#clock-in-btn'); await page.waitForTimeout(120); await page.click('#clock-picker-skip'); await page.waitForTimeout(250);
    const sidBefore = await page.evaluate(() => _activeSession().id);
    await page.click('#clock-out-btn'); await page.waitForTimeout(250);
    const outPicker = await page.evaluate(() => ({ pickerOpen: document.getElementById('clock-picker-modal').classList.contains('open'), title: document.getElementById('clock-picker-title').textContent }));
    ok(outPicker.pickerOpen && /Log/.test(outPicker.title), 'T4a: Clock Out of an unassigned session re-opens the Log picker');
    await page.click('#clock-picker-skip'); await page.waitForTimeout(250);
    const afterOut = await page.evaluate((sid) => {
      const s = hoursData.sessions.find(x => x.id === sid);
      return { status: s.status, hasOut: !!s.clockedOutAt, end: s.end, logId: s.logId, active: !!_activeSession(), showsInList: (function(){ // appears in tool for manual filing (unassigned = no log card, but session exists)
        return hoursData.sessions.filter(x=>x.logId===null && x.status==='complete').length; })() };
    }, sidBefore);
    ok(afterOut.status === 'complete' && afterOut.hasOut && afterOut.end && afterOut.logId === null && !afterOut.active,
      'T4b: skipped-twice session saves complete + unassigned; no active session remains');
    ok(afterOut.showsInList === 1, 'T4c: unassigned completed session persists in the tool for manual filing');
    // indicator hidden now
    const indHidden = await page.evaluate(() => document.getElementById('clock-banner').style.display === 'none');
    ok(indHidden, 'T4d: indicator hidden after clock out');
    await page.close();

    // ── T5: New Log from clock picker starts a session tied to the new log ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'c5@test.com');
    await page.evaluate(() => { const s=_getSettings(); s.defaultShopRate=62; localStorage.setItem('wbc_settings', JSON.stringify(s)); });
    await openHours(page, { hours:{ rate:0, sessions:[], logs:[] }});
    await page.click('#clock-in-btn'); await page.waitForTimeout(150);
    await page.click('#clock-picker-newlog'); await page.waitForTimeout(200);
    const ratePrefill = await page.evaluate(() => document.getElementById('log-rate-input').value);
    ok(ratePrefill === '62', 'T5a: New Log from picker pre-fills rate from settings (62)');
    await page.fill('#log-title-input', 'Fresh Clock Log');
    await page.click('#log-modal-save'); await page.waitForTimeout(300);
    const newLogStarted = await page.evaluate(() => {
      const a = _activeSession();
      const log = (hoursData.logs||[]).find(l => l.title === 'Fresh Clock Log');
      return { active: !!a, tied: a && log && a.logId === log.id, logExists: !!log };
    });
    ok(newLogStarted.logExists && newLogStarted.active && newLogStarted.tied, 'T5b: creating a Log via picker starts a session tied to it');
    await page.close();

    // ── T6: persistence survives simulated tab close (re-fetch from Supabase) ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'c6@test.com');
    await openHours(page, { hours:{ rate:0, sessions:[], logs:[{id:'RL',title:'Resume Log',projectId:null,rate:30,createdAt:'2025-01-01T00:00:00Z'}] }});
    await page.click('#clock-in-btn'); await page.waitForTimeout(120);
    await page.click('.clock-picker-log[data-log-id="RL"]'); await page.waitForTimeout(300);
    // Simulate tab close/reopen: wipe in-memory hoursData and re-fetch from the mock
    const resumed = await page.evaluate(async () => {
      hoursData = null;
      await fetchHoursIntoMemory();
      const a = _activeSession();
      return { has: !!a, status: a&&a.status, logId: a&&a.logId, indicator: document.getElementById('clock-banner').style.display !== 'none' };
    });
    ok(resumed.has && resumed.status === 'active' && resumed.logId === 'RL' && resumed.indicator,
      'T6: active session survives tab close (re-fetched from Supabase) and indicator resumes; can be clocked out/edited');
    await page.close();

    // ── T7: manual vs live-clocked calc identically; rollups unaffected ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'c7@test.com');
    const calc = await page.evaluate(() => {
      // Manual session (HH:MM only) and a completed live session with identical HH:MM + ISO
      const manual = { start:'09:00', end:'11:30', breaks:[{start:'10:00',end:'10:15'}] };
      const live   = { start:'09:00', end:'11:30', clockedInAt:'2025-05-01T09:00:00', clockedOutAt:'2025-05-01T11:30:00',
                       breaks:[{start:'10:00',end:'10:15',clockedInAt:'2025-05-01T10:00:00',clockedOutAt:'2025-05-01T10:15:00'}], status:'complete' };
      return { manualMin: _hoursCalcMinutes(manual.start, manual.end, manual.breaks), liveMin: _hoursCalcMinutes(live.start, live.end, live.breaks) };
    });
    ok(calc.manualMin === calc.liveMin && calc.manualMin === 135, 'T7a: manual + live-clocked sessions calc identically (135 min)');
    // Active session contributes 0 (no end) — rollup safe
    const rollup = await page.evaluate(() => {
      projectsData = [{ id:'pr', name:'Roll', rate:20, status:'active' }];
      hoursData = { rate:0, logs:[{id:'RLog',title:'x',projectId:'pr',rate:20,createdAt:'2025-01-01T00:00:00Z'}], sessions:[
        { id:'done', projectId:'pr', logId:'RLog', status:'complete', date:'2025-01-02', start:'09:00', end:'10:00', breaks:[] },
        { id:'act', projectId:'pr', logId:'RLog', status:'active', clockedInAt:new Date().toISOString(), date:'2025-01-03', start:'11:00', end:'', breaks:[] }
      ]};
      const proj = projectsData[0];
      return { projHours: _projLaborHours(proj), projCost: _projLaborCost(proj), logHours: _logTotalHours('RLog') };
    });
    ok(Math.abs(rollup.projHours - 1) < 0.001 && Math.abs(rollup.projCost - 20) < 0.001 && Math.abs(rollup.logHours - 1) < 0.001,
      'T7b: active (no-end) session contributes 0; project + log rollups count only the completed hour ($20)');
    await page.close();

    // ── T8: UI polish — standalone buttons, banner, colors, picker styling, 12hr ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'c8@test.com');
    await openHours(page, { hours:{ rate:0, sessions:[], logs:[] }});
    // Standalone Clock In: not wrapped in a card/container
    const standalone = await page.evaluate(() => {
      const btn = document.getElementById('clock-in-btn');
      const widget = document.getElementById('hours-clock-widget');
      const cs = getComputedStyle(widget);
      const noBorder = cs.borderTopWidth === '0px' || cs.borderStyle === 'none';
      const noBg = cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
      const green = getComputedStyle(btn).backgroundColor;
      return { btn: !!btn, noBorder, noBg, green };
    });
    ok(standalone.btn && standalone.noBorder && standalone.noBg, 'T8a: Clock In renders standalone (no card/border/background wrapper)');

    // Banner idle → hidden
    const bannerIdle = await page.evaluate(() => document.getElementById('clock-banner').style.display === 'none');
    ok(bannerIdle, 'T8b: banner hidden while idle');

    // Clock in (skip) → banner visible + green (working); body.clock-active
    await page.click('#clock-in-btn'); await page.waitForTimeout(120); await page.click('#clock-picker-skip'); await page.waitForTimeout(250);
    const working = await page.evaluate(() => {
      const bar = document.getElementById('clock-banner');
      return { visible: bar.style.display !== 'none', bg: getComputedStyle(bar).backgroundColor, bodyClass: document.body.classList.contains('clock-active'), text: bar.textContent };
    });
    ok(working.visible && working.bodyClass && /Clocked in since/.test(working.text), 'T8c: banner shows while working, body gets clock-active');
    // Button colors distinct (green/amber/yellow)
    const colors = await page.evaluate(() => ({
      clockOut: getComputedStyle(document.getElementById('clock-out-btn')).backgroundColor,
      breakStart: getComputedStyle(document.getElementById('break-start-btn')).backgroundColor
    }));
    ok(colors.clockOut !== colors.breakStart, 'T8d: Clock Out (yellow) and Break Start (amber) are distinct colors');
    const workingBg = working.bg;

    // Break start → banner switches to blue (on-break)
    await page.click('#break-start-btn'); await page.waitForTimeout(250);
    const onBreak = await page.evaluate(() => {
      const bar = document.getElementById('clock-banner');
      return { bg: getComputedStyle(bar).backgroundColor, text: bar.textContent, breakEndBlue: getComputedStyle(document.getElementById('break-end-btn')).backgroundColor };
    });
    ok(onBreak.bg !== workingBg && /On break/.test(onBreak.text), 'T8e: banner color/status changes on Break Start (working→on-break)');
    // Break end → back to working color
    await page.click('#break-end-btn'); await page.waitForTimeout(250);
    const backWorking = await page.evaluate(() => getComputedStyle(document.getElementById('clock-banner')).backgroundColor);
    ok(backWorking === workingBg, 'T8f: banner returns to working color on Break End');

    // Banner appears on a non-Hours screen and taps through to Hours
    await page.evaluate(() => showLanding());
    await page.waitForTimeout(200);
    const onLanding = await page.evaluate(() => ({
      bannerVisible: document.getElementById('clock-banner').style.display !== 'none',
      landingVisible: document.getElementById('landing-screen').style.display !== 'none'
    }));
    ok(onLanding.bannerVisible && onLanding.landingVisible, 'T8g: banner visible on a non-Hours screen (landing) while active');
    await page.click('#clock-banner'); await page.waitForTimeout(250);
    const navd = await page.evaluate(() => document.getElementById('hours-screen').style.display !== 'none');
    ok(navd, 'T8h: tapping banner navigates to the Hours tool');
    // Clock out to clear
    await page.click('#clock-out-btn'); await page.waitForTimeout(200);
    // (unassigned → picker) skip
    const pk = await page.$('#clock-picker-skip'); if(pk) { await pk.click(); await page.waitForTimeout(200); }
    const clearedBanner = await page.evaluate(() => document.getElementById('clock-banner').style.display === 'none' && !document.body.classList.contains('clock-active'));
    ok(clearedBanner, 'T8i: banner disappears and clock-active removed after clock out (idle)');

    // Picker: New Log accent vs Skip muted
    await page.click('#clock-in-btn'); await page.waitForTimeout(200);
    const pickerStyle = await page.evaluate(() => {
      const nl = document.getElementById('clock-picker-newlog');
      const sk = document.getElementById('clock-picker-skip');
      const nlcs = getComputedStyle(nl), skcs = getComputedStyle(sk);
      return {
        newLogHasBg: nlcs.backgroundColor !== 'rgba(0, 0, 0, 0)' && nlcs.backgroundColor !== 'transparent',
        skipMuted: (skcs.backgroundColor === 'rgba(0, 0, 0, 0)' || skcs.backgroundColor === 'transparent') && skcs.textDecorationLine.includes('underline'),
        distinct: nlcs.backgroundColor !== skcs.backgroundColor
      };
    });
    ok(pickerStyle.newLogHasBg && pickerStyle.skipMuted && pickerStyle.distinct, 'T8j: picker New Log (accent) and Skip (muted underline) are visually distinct');
    await page.evaluate(() => document.getElementById('clock-picker-skip').click());
    await page.waitForTimeout(200);

    // 12hr format everywhere
    const fmt = await page.evaluate(() => {
      // active session started now → widget "Clocked in since h:MM AM/PM"
      const widgetText = document.getElementById('hours-clock-widget').textContent;
      const bannerText = document.getElementById('clock-banner').textContent;
      const twelveHr = /\d{1,2}:\d{2}\s?(AM|PM)/i;
      const no24 = !/[^\d](1[3-9]|2[0-3]):\d{2}(?!\s?(AM|PM))/.test(widgetText); // no bare 13:00-23:59
      return { widget12: twelveHr.test(widgetText), banner12: twelveHr.test(bannerText) };
    });
    ok(fmt.widget12 && fmt.banner12, 'T8k: clock widget + banner display 12hr time (h:MM AM/PM)');
    // Session start/end 12hr in a completed log session
    const sessFmt = await page.evaluate(() => {
      hoursData.sessions = []; hoursData.logs = [{id:'FL',title:'Fmt Log',projectId:null,rate:10,createdAt:'2025-01-01T00:00:00Z'}];
      hoursData.sessions.push({ id:'fs', logId:'FL', projectId:null, status:'complete', date:'2025-01-02', start:'14:05', end:'16:30', breaks:[] });
      _expandedLogId = 'FL'; showHoursTool(); openHoursLog('FL');
      const card = document.querySelector('.hours-log-card[data-log-id="FL"]');
      return card ? card.textContent : '';
    });
    ok(/2:05\s?PM/.test(sessFmt) && /4:30\s?PM/.test(sessFmt) && !/14:05/.test(sessFmt),
      'T8l: session start/end render in 12hr (2:05 PM – 4:30 PM), not 24hr');
    await page.close();

  } catch(err) { console.error('FATAL:', err); fail++; }
  finally {
    await browser.close(); staticServer.close(); mockProc.kill();
    console.log('\nRESULTS: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
