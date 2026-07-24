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

  async function goToNewQuote(page) {
    await page.evaluate(() => openQuoteEdit());
    await page.waitForSelector('#quote-edit-screen', { timeout: 3000 });
    await page.waitForTimeout(200);
  }

  try {
    // ─── T1: Customer Info card ───
    console.log('\n--- T1: Customer Info card ---');
    await resetMock();
    let page = await freshPage();
    await signUp(page, 't1@test.com', 'pass123');
    await goToNewQuote(page);

    const custHdr = await page.evaluate(() => {
      const hdrs = [...document.querySelectorAll('.quote-section-hdr')];
      return hdrs.map(h => h.textContent.trim());
    });
    ok(custHdr.includes('Customer Info'), 'T1a: Customer Info card exists');

    const phoneFullWidth = await page.evaluate(() => {
      const phone = document.getElementById('qe-phone');
      if(!phone) return false;
      const parent = phone.closest('.quote-field');
      const grandparent = parent?.parentElement;
      return !grandparent?.style?.display?.includes('flex') || grandparent?.classList?.contains('quote-section-body');
    });
    ok(phoneFullWidth, 'T1b: Phone is full width (not side-by-side)');

    const emailFullWidth = await page.evaluate(() => {
      const email = document.getElementById('qe-email');
      if(!email) return false;
      const parent = email.closest('.quote-field');
      const grandparent = parent?.parentElement;
      return !grandparent?.style?.display?.includes('flex') || grandparent?.classList?.contains('quote-section-body');
    });
    ok(emailFullWidth, 'T1c: Email is full width (not side-by-side)');
    await page.close();

    // ─── T2: Project Info card ───
    console.log('\n--- T2: Project Info card ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't2@test.com', 'pass123');
    await goToNewQuote(page);

    const projFields = await page.evaluate(() => {
      const num = !!document.getElementById('qe-number');
      const desc = !!document.getElementById('qe-desc');
      const issueDate = !!document.getElementById('qe-issue-date');
      const estComp = !!document.getElementById('qe-est-completion');
      const linkProj = !!document.getElementById('qe-link-project');
      const hdrs = [...document.querySelectorAll('.quote-section-hdr')].map(h => h.textContent.trim());
      return { num, desc, issueDate, estComp, linkProj, hasProjectInfo: hdrs.includes('Project Info') };
    });
    ok(projFields.hasProjectInfo && projFields.num && projFields.desc && projFields.issueDate && projFields.estComp && projFields.linkProj,
      'T2: Project Info card has Quote Number, Description, Issue Date, Est Completion, Link to Project');
    await page.close();

    // ─── T3: Notes is its own card ───
    console.log('\n--- T3: Notes card ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't3@test.com', 'pass123');
    await goToNewQuote(page);

    const notesCard = await page.evaluate(() => {
      const hdrs = [...document.querySelectorAll('.quote-section-hdr')];
      const notesHdr = hdrs.find(h => h.textContent.trim() === 'Notes');
      if(!notesHdr) return { exists: false };
      const section = notesHdr.closest('.quote-section');
      const hasEditBtn = !!section?.querySelector('#qe-notes-edit-btn');
      const hasDisplay = !!section?.querySelector('#qe-notes-display');
      return { exists: true, hasEditBtn, hasDisplay };
    });
    ok(notesCard.exists && notesCard.hasEditBtn && notesCard.hasDisplay, 'T3: Notes is its own card with Edit/Save behavior');
    await page.close();

    // ─── T4: Quote number uses company name initials ───
    console.log('\n--- T4: Quote number — company name ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't4@test.com', 'pass123');
    // Set display name (company name) in settings
    await page.evaluate(() => {
      const s = _getSettings();
      s.displayName = 'Wild Board Studio';
      localStorage.setItem('wbc_settings', JSON.stringify(s));
    });
    await goToNewQuote(page);
    await page.fill('#qe-cust-name', 'John Doe');
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    const qn4 = await page.inputValue('#qe-number');
    ok(qn4.startsWith('WBS-'), 'T4: Quote number uses company name initials WBS (got: ' + qn4 + ')');
    await page.close();

    // ─── T5: Quote number uses first+last name initials ───
    console.log('\n--- T5: Quote number — personal name ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't5@test.com', 'pass123');
    // Set username but no display name / company name
    await page.evaluate(() => {
      const s = _getSettings();
      s.displayName = '';
      s._companyName = '';
      s._profileUsername = 'Henry Smith';
      localStorage.setItem('wbc_settings', JSON.stringify(s));
    });
    await goToNewQuote(page);
    await page.fill('#qe-cust-name', 'Jane Client');
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    const qn5 = await page.inputValue('#qe-number');
    ok(qn5.startsWith('HS-'), 'T5: Quote number uses name initials HS (got: ' + qn5 + ')');
    await page.close();

    // ─── T6: Quote number fallback WBS ───
    console.log('\n--- T6: Quote number — fallback ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't6@test.com', 'pass123');
    await page.evaluate(() => {
      const s = _getSettings();
      s.displayName = '';
      s._companyName = '';
      s._profileUsername = '';
      localStorage.setItem('wbc_settings', JSON.stringify(s));
    });
    await goToNewQuote(page);
    await page.fill('#qe-cust-name', 'Test Client');
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    const qn6 = await page.inputValue('#qe-number');
    ok(qn6.startsWith('WBS-'), 'T6: Quote number falls back to WBS (got: ' + qn6 + ')');
    await page.close();

    // ─── T7: Quote number zero-padded to 4 digits ───
    console.log('\n--- T7: Quote number — 4 digits ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't7@test.com', 'pass123');
    await goToNewQuote(page);
    await page.fill('#qe-cust-name', 'Client');
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    const qn7 = await page.inputValue('#qe-number');
    const suffix7 = qn7.split('-')[1] || '';
    ok(suffix7.length === 4, 'T7: Quote number zero-padded to 4 digits (got: ' + qn7 + ')');
    await page.close();

    // ─── T8: Issue Date blank on new quote ───
    console.log('\n--- T8: Issue Date blank ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't8@test.com', 'pass123');
    await goToNewQuote(page);
    const issueDate8 = await page.inputValue('#qe-issue-date');
    ok(issueDate8 === '', 'T8: Issue Date is blank on new quote creation');
    await page.close();

    // ─── T9: Issue Date auto-fills on Open Email ───
    console.log('\n--- T9: Issue Date auto-fill on Open Email ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't9@test.com', 'pass123');
    await goToNewQuote(page);
    await page.fill('#qe-cust-name', 'Client Nine');
    await page.fill('#qe-email', 'nine@test.com');
    await page.fill('#qe-cust-name', 'Client Nine');
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    // Save the quote first
    const saveBtnSel = '#quote-edit-screen .btn-primary';
    await page.evaluate((sel) => {
      const btns = [...document.querySelectorAll(sel)];
      const saveBtn = btns.find(b => b.textContent.trim() === 'Save Quote');
      if(saveBtn) saveBtn.click();
    }, saveBtnSel);
    await page.waitForTimeout(500);
    // Now in detail view, click Send Quote
    const sendResult = await page.evaluate(() => {
      const sendBtn = document.getElementById('qd-send-btn');
      if(!sendBtn) return 'no-send-btn';
      sendBtn.click();
      return 'clicked';
    });
    if(sendResult === 'clicked') {
      await page.waitForTimeout(300);
      // Intercept window.open so we don't actually open mailto
      await page.evaluate(() => { window.open = () => null; });
      const emailBtn = await page.$('#quote-send-email');
      if(emailBtn) {
        await emailBtn.click();
        await page.waitForTimeout(300);
        // Check the quote's issueDate was set
        const hasIssueDate = await page.evaluate(() => {
          const q = quotesData[0];
          return q && q.issueDate && q.issueDate.length === 10;
        });
        ok(hasIssueDate, 'T9: Issue Date auto-fills when Open Email is tapped');
      } else {
        ok(false, 'T9: Issue Date auto-fills when Open Email is tapped (no email btn)');
      }
    } else {
      ok(false, 'T9: Issue Date auto-fills when Open Email is tapped (no send btn)');
    }
    await page.close();

    // ─── T10: Labor card header ───
    console.log('\n--- T10: Labor card header ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't10@test.com', 'pass123');
    await goToNewQuote(page);
    const laborHdr = await page.evaluate(() => {
      const hdrs = [...document.querySelectorAll('.quote-section-hdr')];
      return hdrs.map(h => h.textContent.trim());
    });
    ok(laborHdr.includes('Labor'), 'T10: Labor card header reads "Labor" (not "Labour")');
    await page.close();

    // ─── T11: Labor shows Shop Rate + Employee Rate ───
    console.log('\n--- T11: Labor rates ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't11@test.com', 'pass123');
    await goToNewQuote(page);
    const rates = await page.evaluate(() => {
      const sr = document.getElementById('qe-shop-rate');
      const er = document.getElementById('qe-emp-rate');
      const srParent = sr?.closest('.quote-field');
      const erParent = er?.closest('.quote-field');
      const srCompact = srParent?.style?.width?.includes('140') || srParent?.style?.flex === 'none';
      const erCompact = erParent?.style?.width?.includes('140') || erParent?.style?.flex === 'none';
      return { sr: !!sr, er: !!er, srCompact, erCompact };
    });
    ok(rates.sr && rates.er && rates.srCompact && rates.erCompact, 'T11: Shop Rate + Employee Rate as compact fields');
    await page.close();

    // ─── T12: Cutting Board default tasks ───
    console.log('\n--- T12: Cutting Board tasks ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't12@test.com', 'pass123');
    await goToNewQuote(page);
    const tasks12 = await page.evaluate(() => {
      return [...document.querySelectorAll('#qe-tasks .qe-task-desc')].map(i => i.value);
    });
    ok(tasks12.length === 5 &&
       tasks12[0] === 'Milling' && tasks12[1] === 'Glue-up' && tasks12[2] === 'Flattening' &&
       tasks12[3] === 'Sanding' && tasks12[4] === 'Finishing',
      'T12: Cutting Board pre-populated with 5 default tasks');
    await page.close();

    // ─── T13: Table Top default tasks ───
    console.log('\n--- T13: Table Top tasks ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't13@test.com', 'pass123');
    await goToNewQuote(page);
    // Switch to Table Top
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('[data-ptype="table_top"]');
    await page.waitForTimeout(300);
    const tasks13 = await page.evaluate(() => {
      return [...document.querySelectorAll('#qe-tasks .qe-task-desc')].map(i => i.value);
    });
    ok(tasks13.length === 5 && tasks13[0] === 'Milling', 'T13: Table Top has same 5 default tasks');
    await page.close();

    // ─── T14: Sign default tasks ───
    console.log('\n--- T14: Sign tasks ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't14@test.com', 'pass123');
    await goToNewQuote(page);
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('[data-ptype="sign"]');
    await page.waitForTimeout(300);
    const tasks14 = await page.evaluate(() => {
      return [...document.querySelectorAll('#qe-tasks .qe-task-desc')].map(i => i.value);
    });
    ok(tasks14.length === 5 && tasks14[0] === 'Milling', 'T14: Sign has same 5 default tasks');
    await page.close();

    // ─── T15: Custom — blank tasks ───
    console.log('\n--- T15: Custom blank tasks ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't15@test.com', 'pass123');
    await goToNewQuote(page);
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('[data-ptype="custom"]');
    await page.waitForTimeout(300);
    const tasks15 = await page.evaluate(() => {
      return [...document.querySelectorAll('#qe-tasks .qe-task-desc')].map(i => i.value);
    });
    ok(tasks15.length === 0, 'T15: Custom starts with no tasks');
    await page.close();

    // ─── T16: Task row structure ───
    console.log('\n--- T16: Task row structure ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't16@test.com', 'pass123');
    await goToNewQuote(page);
    const taskRow = await page.evaluate(() => {
      const row = document.querySelector('#qe-tasks .quote-task-row');
      if(!row) return null;
      return {
        hasName: !!row.querySelector('.qe-task-desc'),
        hasHours: !!row.querySelector('.qe-task-hrs'),
        hasBilled: !!row.querySelector('.qe-task-billed'),
        hasDel: !!row.querySelector('.qe-task-del')
      };
    });
    ok(taskRow && taskRow.hasName && taskRow.hasHours && taskRow.hasBilled && taskRow.hasDel,
      'T16: Task row has editable name, hours, billed amount, remove button');
    await page.close();

    // ─── T17: Add Task button ───
    console.log('\n--- T17: Add Task button ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't17@test.com', 'pass123');
    await goToNewQuote(page);
    const countBefore = await page.evaluate(() => document.querySelectorAll('#qe-tasks .quote-task-row').length);
    await page.click('#qe-add-task');
    await page.waitForTimeout(300);
    const countAfter = await page.evaluate(() => document.querySelectorAll('#qe-tasks .quote-task-row').length);
    ok(countAfter === countBefore + 1, 'T17: + Add Task button adds blank row');
    await page.close();

    // ─── T18: Labor footer totals ───
    console.log('\n--- T18: Labor footer ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't18@test.com', 'pass123');
    await goToNewQuote(page);
    await page.fill('#qe-shop-rate', '50');
    // Set hours on first task (Milling)
    const firstHrs = await page.$('#qe-tasks .qe-task-hrs');
    await firstHrs.fill('2');
    await page.waitForTimeout(300);
    const summary18 = await page.evaluate(() => {
      const el = document.getElementById('qe-labor-summary');
      return el ? el.textContent : '';
    });
    ok(summary18.includes('2.0') && summary18.includes('100.00'), 'T18: Labor footer shows correct total hours and billed amount');
    await page.close();

    // ─── T19: Checkbox alignment ───
    console.log('\n--- T19: Checkbox alignment ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't19@test.com', 'pass123');
    await goToNewQuote(page);
    const checkboxAlignment = await page.evaluate(() => {
      const checks = [...document.querySelectorAll('.qe-co-feat-check')];
      if(checks.length === 0) return { aligned: false };
      const lefts = checks.map(c => {
        const rect = c.getBoundingClientRect();
        return Math.round(rect.left);
      });
      const allSame = lefts.every(l => Math.abs(l - lefts[0]) < 3);
      return { aligned: allSame, count: checks.length, lefts };
    });
    ok(checkboxAlignment.aligned && checkboxAlignment.count > 0,
      'T19: Optional Features checkboxes aligned on same vertical axis');
    await page.close();

    // ─── T20: No "Labour" anywhere ───
    console.log('\n--- T20: No Labour spelling ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't20@test.com', 'pass123');
    await goToNewQuote(page);
    const hasLabour = await page.evaluate(() => {
      return document.body.innerHTML.includes('Labour');
    });
    ok(!hasLabour, 'T20: "Labour" does not appear anywhere in the app');
    await page.close();

    // ─── T21: Save/restore tasks ───
    console.log('\n--- T21: Save and restore tasks ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't21@test.com', 'pass123');
    await goToNewQuote(page);
    await page.fill('#qe-cust-name', 'Save Test');
    await page.fill('#qe-email', 'save@test.com');
    await page.fill('#qe-shop-rate', '65');
    await page.fill('#qe-emp-rate', '25');
    // Fill hours on first task
    const t21hrs = await page.$('#qe-tasks .qe-task-hrs');
    await t21hrs.fill('3');
    await page.evaluate(() => document.getElementById('qe-cust-name').dispatchEvent(new Event('blur')));
    await page.waitForTimeout(200);
    // Save
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#quote-edit-screen .btn-primary')];
      const saveBtn = btns.find(b => b.textContent.trim() === 'Save Quote');
      if(saveBtn) saveBtn.click();
    });
    await page.waitForTimeout(500);
    // Click Edit to go back to form
    const editBtn = await page.$('#qd-edit-btn');
    if(editBtn) await editBtn.click();
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => {
      const tasks = [...document.querySelectorAll('#qe-tasks .quote-task-row')];
      const firstDesc = tasks[0]?.querySelector('.qe-task-desc')?.value;
      const firstHrs = parseFloat(tasks[0]?.querySelector('.qe-task-hrs')?.value) || 0;
      const shopRate = parseFloat(document.getElementById('qe-shop-rate')?.value) || 0;
      const empRate = parseFloat(document.getElementById('qe-emp-rate')?.value) || 0;
      return { taskCount: tasks.length, firstDesc, firstHrs, shopRate, empRate };
    });
    ok(restored.taskCount === 5 && restored.firstDesc === 'Milling' && restored.firstHrs === 3 &&
       restored.shopRate === 65 && restored.empRate === 25,
      'T21: Saved quotes restore task names, hours, shop rate, employee rate');
    await page.close();

    // ─── T22: Previous 55 tests regression ───
    console.log('\n--- T22: Regression checks ---');
    await resetMock();
    page = await freshPage();
    await signUp(page, 't22@test.com', 'pass123');
    await goToNewQuote(page);

    // Check key elements from prior specs still work
    const regression = await page.evaluate(() => {
      const basePricingHdr = [...document.querySelectorAll('.quote-section-hdr')].some(h => h.textContent.trim() === 'Base Pricing');
      const productPills = document.querySelectorAll('[data-ptype]').length;
      const saInfo = !!document.getElementById('qe-sa-info');
      const expThird = !!document.getElementById('qe-exp-third');
      const notesDisplay = !!document.getElementById('qe-notes-display');
      const genProj = !!document.querySelector('option[value="__generate__"]');
      const genProjBold = document.querySelector('option[value="__generate__"]')?.style?.fontWeight === 'bold';
      return { basePricingHdr, productPills, saInfo, expThird, notesDisplay, genProj, genProjBold };
    });
    ok(regression.basePricingHdr, 'T22a: Base Pricing card still exists');
    ok(regression.productPills === 4, 'T22b: 4 product type pills');
    ok(regression.saInfo, 'T22c: SA info still works');
    ok(regression.expThird, 'T22d: Expenses card still exists');
    ok(regression.notesDisplay, 'T22e: Notes display still works');
    ok(regression.genProj && regression.genProjBold, 'T22f: Generate New Project still bold');
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
