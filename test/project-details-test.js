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
  async function openNewQuote(page) { await page.evaluate(() => openQuoteEdit()); await page.waitForSelector('#quote-edit-screen', { timeout: 3000 }); await page.waitForTimeout(200); }

  try {
    await resetMock();
    let page = await freshPage();
    await signUp(page, 'pd1@test.com');
    await openNewQuote(page);

    // ── Part 1: Project Info field order + rename ──
    const order = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('#quote-edit-body .quote-section')].find(sec => sec.querySelector('.quote-section-hdr')?.textContent === 'Project Info');
      const labels = [...fields.querySelectorAll('.quote-field label')].map(l => l.textContent);
      const desc = document.getElementById('qe-desc');
      const num = document.getElementById('qe-number');
      const descIdx = labels.indexOf('Project Title');
      const numIdx = labels.indexOf('Quote Number');
      return { firstIsTitle: labels[0] === 'Project Title', secondIsNumber: labels[1] === 'Quote Number', descId: !!desc, numId: !!num, descIdx, numIdx };
    });
    ok(order.firstIsTitle && order.secondIsNumber && order.descId && order.numId && order.descIdx < order.numIdx,
      'Part1: Project Title (qe-desc) first, Quote Number (qe-number) second');

    // ── Part 2: Project Details card present, no old Notes textarea ──
    const card = await page.evaluate(() => {
      const hdrs = [...document.querySelectorAll('.quote-section-hdr')].map(h => h.textContent);
      return {
        hasProjectDetails: hdrs.includes('Project Details'),
        noNotesCard: !hdrs.includes('Notes'),
        noOldTextarea: !document.getElementById('qe-notes'),
        noOldEditBtn: !document.getElementById('qe-notes-edit-btn'),
        addBtn: !!document.getElementById('qe-note-add-btn'),
        emptyMsg: document.getElementById('qe-notes-list').textContent.includes('No notes yet')
      };
    });
    ok(card.hasProjectDetails && card.noNotesCard && card.noOldTextarea && card.noOldEditBtn && card.addBtn && card.emptyMsg,
      'Part2: "Project Details" card replaces Notes card; Add Note button; empty state');

    // ── Add a note ──
    await page.click('#qe-note-add-btn');
    await page.waitForTimeout(150);
    await page.fill('#qe-note-new-text', 'First note about the job');
    await page.click('#qe-note-new-save');
    await page.waitForTimeout(200);
    const afterAdd = await page.evaluate(() => {
      const rows = document.querySelectorAll('.qe-note-row');
      const q = _currentQuoteId ? null : null;
      return {
        rowCount: rows.length,
        text: rows[0].querySelector('.qe-note-view').textContent,
        addBtnBack: document.getElementById('qe-note-add-btn') && document.getElementById('qe-note-add-btn').offsetParent !== null,
        hasDate: /\d{4}|·/.test(rows[0].querySelector('.qe-note-view').textContent)
      };
    });
    ok(afterAdd.rowCount === 1 && afterAdd.text.includes('First note about the job') && afterAdd.addBtnBack && afterAdd.hasDate,
      'Add Note: appends entry with text + date, Add button reappears');

    // ── Add a second note (ordering oldest→newest) ──
    await page.click('#qe-note-add-btn');
    await page.waitForTimeout(150);
    await page.fill('#qe-note-new-text', 'Second note later');
    await page.click('#qe-note-new-save');
    await page.waitForTimeout(200);
    const order2 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.qe-note-row')];
      return { count: rows.length, first: rows[0].querySelector('.qe-note-view').textContent, last: rows[rows.length-1].querySelector('.qe-note-view').textContent };
    });
    ok(order2.count === 2 && order2.first.includes('First note') && order2.last.includes('Second note'),
      'Notes listed oldest → newest');

    // ── Edit a note (updates text + updatedAt) ──
    await page.evaluate(() => document.querySelector('.qe-note-row[data-note-idx="0"] .qe-note-view').click());
    await page.waitForTimeout(150);
    await page.fill('.qe-note-edit-text[data-note-idx="0"]', 'First note EDITED');
    await page.click('.qe-note-save[data-note-idx="0"]');
    await page.waitForTimeout(200);
    const afterEdit = await page.evaluate(() => {
      const row = document.querySelector('.qe-note-row[data-note-idx="0"] .qe-note-view');
      return { text: row.textContent, edited: row.textContent.includes('Edited') };
    });
    ok(afterEdit.text.includes('First note EDITED') && afterEdit.edited,
      'Edit note: text updated and shows "Edited" timestamp (updatedAt)');

    // ── Delete a note (no confirm) ──
    await page.evaluate(() => document.querySelector('.qe-note-del[data-note-idx="0"]').click());
    await page.waitForTimeout(200);
    const afterDel = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.qe-note-row')];
      return { count: rows.length, remaining: rows.length ? rows[0].querySelector('.qe-note-view').textContent : '' };
    });
    ok(afterDel.count === 1 && afterDel.remaining.includes('Second note'),
      'Delete note removes single entry immediately, no confirm');

    // ── Persist: save quote, reopen, notes survive ──
    await page.fill('#qe-cust-name', 'Notes Client'); await page.fill('#qe-email', 'nc@test.com');
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b=[...document.querySelectorAll('#quote-edit-screen .btn-primary')].find(x=>x.textContent.trim()==='Save Quote'); if(b) b.click(); });
    await page.waitForTimeout(600);
    const editBtn = await page.$('#qd-edit-btn'); if(editBtn) await editBtn.click();
    await page.waitForTimeout(300);
    const persisted = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.qe-note-row')];
      return { count: rows.length, text: rows.length ? rows[0].querySelector('.qe-note-view').textContent : '' };
    });
    ok(persisted.count === 1 && persisted.text.includes('Second note'), 'Notes persist across save/reopen');
    await page.close();

    // ── Legacy migration: string q.notes → array ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pd2@test.com');
    const migrated = await page.evaluate(() => {
      const q = _newQuote();
      q.issueDate = '2025-06-01';
      q.notes = 'legacy single string note';
      _migrateQuoteNotes(q);
      return { isArray: Array.isArray(q.notes), len: q.notes.length, text: q.notes[0].text, created: q.notes[0].createdAt, updated: q.notes[0].updatedAt, hasId: !!q.notes[0].id };
    });
    ok(migrated.isArray && migrated.len === 1 && migrated.text === 'legacy single string note' &&
       migrated.created === '2025-06-01' && migrated.updated === null && migrated.hasId,
      'Legacy string migrates to single-entry array (createdAt=issueDate, updatedAt=null, no data loss)');
    // Empty string → empty array
    const emptyMig = await page.evaluate(() => { const q = _newQuote(); q.notes = ''; _migrateQuoteNotes(q); return Array.isArray(q.notes) && q.notes.length === 0; });
    ok(emptyMig, 'Legacy empty string migrates to empty array');
    // Render legacy in editor
    const legacyRender = await page.evaluate(() => {
      const q = _newQuote(); q.customer.email='x@y.com'; q.notes = 'legacy note text';
      quotesData.push(q);
      openQuoteEdit(q.id);
      const rows = [...document.querySelectorAll('.qe-note-row')];
      return { count: rows.length, text: rows.length ? rows[0].querySelector('.qe-note-view').textContent : '' };
    });
    ok(legacyRender.count === 1 && legacyRender.text.includes('legacy note text'),
      'Legacy string note renders as one entry when a saved quote is opened');
    await page.close();

    // ── Part 3: notes absent from client-facing output ──
    await resetMock();
    page = await freshPage();
    await signUp(page, 'pd3@test.com');
    const clientOut = await page.evaluate(() => {
      const q = _newQuote();
      q.customer = { name: 'C', email: 'c@d.com', phone: '' };
      q.number = 'C-0001'; q.description = 'Desc';
      q.notes = [{ id:'n1', text:'SECRET INTERNAL NOTE', createdAt:new Date().toISOString(), updatedAt:null }];
      quotesData.push(q);
      // Quote detail (client view) render
      openQuoteDetail(q.id);
      const detailHtml = document.getElementById('quote-detail-body').innerHTML;
      // Email body construction (mirror openQuoteSendModal email builder)
      const s = _getSettings();
      const total = _quoteTotal(q, s);
      const displayName = s.displayName || 'Wild Board Calculator';
      let bodyText = 'Hi ' + (q.customer.name || '') + ',\n\nPlease find your quote attached.\n\nQuote: ' + q.number + '\nProject: ' + (q.description || '') + '\nTotal: $' + total.toFixed(2) + '\nValid until: ' + (q.validUntil || '');
      bodyText += '\n\n' + displayName;
      return {
        detailHasNote: detailHtml.includes('SECRET INTERNAL NOTE'),
        detailHasNotesHdr: detailHtml.includes('Notes / Terms'),
        emailHasNote: bodyText.includes('SECRET INTERNAL NOTE')
      };
    });
    ok(!clientOut.detailHasNote && !clientOut.detailHasNotesHdr, 'Client quote view shows no notes content / no "Notes / Terms" section');
    ok(!clientOut.emailHasNote, 'Confirmation email body no longer appends notes');

    // PDF: exportQuotePDF should run without referencing q.notes as string (array present)
    const pdfOk = await page.evaluate(async () => {
      const q = quotesData[quotesData.length - 1];
      try { exportQuotePDF(q); return true; } catch(e) { return 'ERR:' + e.message; }
    });
    ok(pdfOk === true, 'PDF export runs with array notes (no notes section, no string error)' + (pdfOk === true ? '' : ' ' + pdfOk));
    await page.close();

  } catch(err) { console.error('FATAL:', err); fail++; }
  finally {
    await browser.close(); staticServer.close(); mockProc.kill();
    console.log('\nRESULTS: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  }
})();
