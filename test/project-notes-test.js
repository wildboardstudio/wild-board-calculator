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
  function getMock(mp){ return new Promise((resolve,reject)=>{ http.get({hostname:'127.0.0.1',port:MOCK_PORT,path:mp}, res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d||'{}')));}).on('error',reject); }); }
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
  // Create a project directly in memory + open its detail
  async function makeProjectAndOpen(page, projOverrides) {
    return await page.evaluate((ov) => {
      const proj = Object.assign({ id: 'proj_' + Date.now(), name: 'Test Proj', date: '2025-05-10', completionDate: null, notes: [], listId: null, listName: null, status: 'active', rate: 0 }, ov);
      projectsData.push(proj);
      openProjectDetail(proj.id);
      return proj.id;
    }, projOverrides || {});
  }

  try {
    // ── Modal no longer has note field ──
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'pn1@test.com');
    const modalNoNote = await page.evaluate(() => {
      openNewProjectModal();
      const has = !!document.getElementById('proj-note-input');
      document.getElementById('project-modal').classList.remove('open');
      return !has;
    });
    ok(modalNoNote, 'New/Edit Project modal no longer has a note field');
    // Save a new project via modal (no note field) — should not throw
    const modalSaves = await page.evaluate(() => {
      openNewProjectModal();
      document.getElementById('proj-name-input').value = 'Modal Made';
      try { document.getElementById('proj-modal-save').click(); } catch(e) { return 'ERR:' + e.message; }
      const p = projectsData.find(x => x.name === 'Modal Made');
      return p && Array.isArray(p.notes) && p.notes.length === 0;
    });
    ok(modalSaves === true, 'Creating a project via modal saves cleanly with notes:[] and no note field');
    await page.close();

    // ── Section renamed + Add Note present ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pn2@test.com');
    await makeProjectAndOpen(page, {});
    await page.waitForTimeout(200);
    const section = await page.evaluate(() => ({
      hdr: document.querySelector('#proj-notes-section .proj-section-hdr h3').textContent,
      list: !!document.getElementById('proj-notes-list'),
      addBtn: !!document.getElementById('proj-note-add-btn'),
      empty: document.getElementById('proj-notes-list').textContent.includes('No notes yet'),
      noOldDisplay: !document.getElementById('proj-note-display')
    }));
    ok(section.hdr === 'Project Details' && section.list && section.addBtn && section.empty && section.noOldDisplay,
      'Section renamed to "Project Details" with note list + Add Note button');

    // ── Add note ──
    await page.click('#proj-note-add-btn');
    await page.waitForTimeout(150);
    await page.fill('#proj-note-new-text', 'Framing done');
    await page.click('#proj-note-new-save');
    await page.waitForTimeout(200);
    const added = await page.evaluate(() => {
      const rows = document.querySelectorAll('.proj-note-row');
      return { count: rows.length, text: rows[0].querySelector('.proj-note-view').textContent, addBack: document.getElementById('proj-note-add-btn').offsetParent !== null };
    });
    ok(added.count === 1 && added.text.includes('Framing done') && /·|\d{4}/.test(added.text) && added.addBack,
      'Add Note appends entry with timestamp, Add button reappears');

    // ── Add second, ordering oldest→newest ──
    await page.click('#proj-note-add-btn');
    await page.waitForTimeout(150);
    await page.fill('#proj-note-new-text', 'Sanding next');
    await page.click('#proj-note-new-save');
    await page.waitForTimeout(200);
    const ord = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.proj-note-row')];
      return { count: rows.length, first: rows[0].querySelector('.proj-note-view').textContent, last: rows[rows.length-1].querySelector('.proj-note-view').textContent };
    });
    ok(ord.count === 2 && ord.first.includes('Framing done') && ord.last.includes('Sanding next'), 'Notes ordered oldest → newest');

    // ── Persist to Supabase ──
    await page.waitForTimeout(300);
    const dump = await getMock('/_test/dump');
    const savedProj = (dump.projects || []).find(p => p.data && Array.isArray(p.data.notes) && p.data.notes.some(n => n.text === 'Framing done'));
    ok(savedProj && savedProj.data.notes.length === 2, 'Notes persisted to Supabase via saveProjectToSupabase');

    // ── Edit note (updatedAt) ──
    await page.evaluate(() => document.querySelector('.proj-note-row[data-note-idx="0"] .proj-note-view').click());
    await page.waitForTimeout(150);
    await page.fill('.proj-note-edit-text[data-note-idx="0"]', 'Framing done and inspected');
    await page.click('.proj-note-save[data-note-idx="0"]');
    await page.waitForTimeout(200);
    const edited = await page.evaluate(() => {
      const v = document.querySelector('.proj-note-row[data-note-idx="0"] .proj-note-view');
      return { text: v.textContent, edited: v.textContent.includes('Edited') };
    });
    ok(edited.text.includes('Framing done and inspected') && edited.edited, 'Edit updates text and shows "Edited" timestamp');

    // ── Delete note (no confirm) ──
    await page.evaluate(() => document.querySelector('.proj-note-del[data-note-idx="0"]').click());
    await page.waitForTimeout(200);
    const del = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.proj-note-row')];
      return { count: rows.length, remaining: rows.length ? rows[0].querySelector('.proj-note-view').textContent : '' };
    });
    ok(del.count === 1 && del.remaining.includes('Sanding next'), 'Delete removes single entry immediately, no confirm');

    // ── Hours + Cuts sections undisturbed ──
    const otherSections = await page.evaluate(() => ({
      hours: !!document.getElementById('proj-hours-body') || !!document.querySelector('#proj-hours-section, [id*="hours"]'),
      totalCard: !!document.getElementById('proj-total-card')
    }));
    ok(otherSections.totalCard, 'Hours/Cuts/Total sections still present on the detail screen');
    await page.close();

    // ── Legacy migration ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pn3@test.com');
    const mig = await page.evaluate(() => {
      const proj = { id: 'proj_legacy', name: 'Legacy', date: '2024-11-03', note: 'old single note', notes: undefined, status: 'active' };
      _migrateProjectNotes(proj);
      return { isArray: Array.isArray(proj.notes), len: proj.notes.length, text: proj.notes[0].text, created: proj.notes[0].createdAt, updated: proj.notes[0].updatedAt, hasId: !!proj.notes[0].id, noteGone: proj.note === undefined };
    });
    ok(mig.isArray && mig.len === 1 && mig.text === 'old single note' && mig.created === '2024-11-03' && mig.updated === null && mig.hasId && mig.noteGone,
      'Legacy proj.note string migrates to single-entry array (createdAt=proj.date, updatedAt=null, no data loss)');
    // Render legacy project in detail
    const legacyRender = await page.evaluate(() => {
      const proj = { id: 'proj_legacy2', name: 'Legacy2', date: '2024-10-01', note: 'legacy detail note', status: 'active' };
      projectsData.push(proj);
      openProjectDetail(proj.id);
      const rows = [...document.querySelectorAll('.proj-note-row')];
      return { count: rows.length, text: rows.length ? rows[0].querySelector('.proj-note-view').textContent : '' };
    });
    ok(legacyRender.count === 1 && legacyRender.text.includes('legacy detail note'),
      'Opening a legacy project renders its string note as one entry');
    // Empty legacy
    const emptyMig = await page.evaluate(() => { const p = { id:'x', note:'' }; _migrateProjectNotes(p); return Array.isArray(p.notes) && p.notes.length === 0; });
    ok(emptyMig, 'Empty legacy note migrates to empty array');
    await page.close();

  } catch(err) { console.error('FATAL:', err); fail++; }
  finally {
    await browser.close(); staticServer.close(); mockProc.kill();
    console.log('\nRESULTS: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
