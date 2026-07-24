const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MOCK_PORT = 8901;
const STATIC_PORT = 8900;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const APP_URL = `http://localhost:${STATIC_PORT}/index.html`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function _subst(html) {
  return html
    .replace(/https:\/\/hmywfzcjsatzpuciqmge\.supabase\.co/g, 'http://127.0.0.1:' + MOCK_PORT)
    .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/g, 'http://127.0.0.1:' + STATIC_PORT + '/supabase.umd.js')
    .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/2\.5\.1\/jspdf\.umd\.min\.js/g, 'http://127.0.0.1:' + STATIC_PORT + '/jspdf.umd.min.js');
}
let mockProc;

async function mockReset() {
  const r = await fetch(`${MOCK_URL}/_test/reset`);
  if(!r.ok) throw new Error('mock reset failed');
}
async function mockDump() {
  const r = await fetch(`${MOCK_URL}/_test/dump`);
  return r.json();
}

let browser, staticServer;
const results = [];

async function openAuthFromLanding(page) {
  await page.waitForSelector('#landing-screen', {state:'visible', timeout:5000});
  const projCard = await page.$('.feature-card[aria-label="Your Projects"]');
  if(!projCard) throw new Error('Your Projects card not found');
  await projCard.click();
  await page.waitForSelector('#auth-modal.open', {timeout:5000});
}

async function signUp(page, email, pw) {
  await openAuthFromLanding(page);
  const toggle = await page.$('#auth-toggle-btn');
  const toggleText = await toggle.textContent();
  if(toggleText.includes('Sign up') || toggleText.includes("Don't have")) await toggle.click();
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', pw);
  const cf = await page.$('#auth-password-confirm');
  if(cf) await page.fill('#auth-password-confirm', pw);
  await page.click('#auth-submit-btn');
  await page.waitForFunction(() => typeof _currentUser !== 'undefined' && _currentUser && _currentUser.email, {timeout:5000});
  const wb = await page.$('#auth-welcome-btn');
  if(wb) await wb.click();
  await page.waitForFunction(() => {
    const m = document.getElementById('auth-modal');
    return !m.classList.contains('open');
  }, {timeout:5000}).catch(()=>{});
  await page.waitForTimeout(500);
}

async function signIn(page, email, pw) {
  await openAuthFromLanding(page);
  const toggle = await page.$('#auth-toggle-btn');
  const toggleText = await toggle.textContent();
  if(toggleText.includes('Already have')) await toggle.click();
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', pw);
  await page.click('#auth-submit-btn');
  await page.waitForFunction(() => {
    const m = document.getElementById('auth-modal');
    return !m.classList.contains('open');
  }, {timeout:5000});
  await page.waitForTimeout(500);
}

async function openProjectsScreen(page) {
  const projCard = await page.$('.feature-card[aria-label="Your Projects"]');
  if(projCard) {
    await projCard.click();
    await page.waitForSelector('#projects-screen', {state:'visible', timeout:5000});
    await page.waitForTimeout(500);
    return;
  }
  throw new Error('Could not open projects screen');
}

async function createProject(page, name, opts = {}) {
  await page.click('#projects-add-btn');
  await page.waitForSelector('#project-modal.open', {timeout:3000});
  await page.fill('#proj-name-input', name);
  if(opts.listValue) {
    await page.selectOption('#proj-list-select', opts.listValue);
  }
  if(opts.rate) {
    await page.fill('#proj-rate-input', String(opts.rate));
  }
  if(opts.note && await page.$('#proj-note-input')) {
    await page.fill('#proj-note-input', opts.note);
  }
  await page.click('#proj-modal-save');
  await page.waitForFunction(() => {
    const m = document.getElementById('project-modal');
    return !m.classList.contains('open');
  }, {timeout:3000});
  await page.waitForTimeout(300);
}

async function logSessionInProject(page, start, end, breaks, note) {
  await page.click('#proj-log-session-btn');
  await page.waitForSelector('#hours-log-modal.open', {timeout:3000});
  await page.fill('#hours-log-start', start);
  await page.fill('#hours-log-end', end);
  if(breaks && breaks.length > 0) {
    for(let i = 0; i < breaks.length; i++) {
      if(i > 0) await page.click('#hours-add-break-btn');
      const rows = await page.$$('#hours-breaks-list > div');
      const row = rows[rows.length - 1];
      const startInput = await row.$('.hours-break-start');
      const endInput = await row.$('.hours-break-end');
      await startInput.fill(breaks[i].start);
      await endInput.fill(breaks[i].end);
    }
  }
  if(note) await page.fill('#hours-log-note', note);
  await page.click('#hours-log-save');
  await page.waitForFunction(() => {
    const m = document.getElementById('hours-log-modal');
    return !m.classList.contains('open');
  }, {timeout:3000});
  await page.waitForTimeout(300);
}

async function backToLanding(page) {
  if(await page.$('#project-detail-screen[style*="block"]')) {
    await page.click('#proj-detail-back-btn');
    await page.waitForTimeout(200);
  }
  if(await page.$('#projects-screen[style*="block"]')) {
    await page.click('#projects-back-btn');
    await page.waitForTimeout(200);
  }
  if(await page.$('#hours-screen[style*="block"]')) {
    const backBtn = await page.$('#hours-back-btn');
    if(backBtn) { await backBtn.click(); await page.waitForTimeout(200); }
  }
  if(await page.$('#shop-screen[style*="block"]')) {
    const backBtn = await page.$('#shop-back-btn');
    if(backBtn) { await backBtn.click(); await page.waitForTimeout(200); }
  }
  if(await page.$('#saved-screen[style*="block"]')) {
    const backBtn = await page.$('.saved-screen-header .btn');
    if(backBtn) { await backBtn.click(); await page.waitForTimeout(200); }
  }
}

async function run(name, fn) {
  let page;
  try {
    const ctx = await browser.newContext({viewport:{width:390,height:844}});
    page = await ctx.newPage();
    await page.goto(APP_URL, {waitUntil:'domcontentloaded', timeout:10000});
    await page.waitForSelector('#landing-screen', {state:'visible', timeout:5000});
    await fn(page);
    results.push({name, pass:true});
    console.log('PASS — ' + name);
  } catch(e) {
    results.push({name, pass:false, error:e.message||String(e)});
    console.log('FAIL — ' + name);
    console.log('       ' + (e.message||String(e)).split('\n')[0]);
    if(e.stack) console.log(e.stack.split('\n').slice(0,3).join('\n'));
  } finally {
    if(page) await page.context().close().catch(()=>{});
  }
}

(async () => {
  mockProc = spawn('node', [path.join(__dirname, 'mock-supabase.js'), String(MOCK_PORT)], { stdio: ['pipe','pipe','pipe'] });
  await new Promise((resolve, reject) => { mockProc.stdout.on('data', d => { if(d.toString().includes('listening')) resolve(); }); setTimeout(()=>reject(new Error('mock startup timeout')), 5000); });
  browser = await chromium.launch({executablePath:CHROME, headless:true, args:['--no-sandbox','--disable-gpu']});
  staticServer = http.createServer((req, res) => {
    const p = req.url === '/' ? '/index.html' : req.url;
    const isIndex = p === '/index.html';
    const realIndex = path.join(__dirname, '..', 'index.html');
    const fp = isIndex ? realIndex : path.join(__dirname, p);
    const ext = path.extname(p);
    const ct = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.jpg':'image/jpeg','.png':'image/png'}[ext]||'application/octet-stream';
    if(isIndex) {
      fs.readFile(realIndex, 'utf8', (err, data) => {
        if(err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200,{'Content-Type':'text/html','Access-Control-Allow-Origin':'*'}); res.end(_subst(data));
      });
      return;
    }
    fs.readFile(path.join(__dirname, p), (err, data) => {
      if(err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200,{'Content-Type':ct,'Access-Control-Allow-Origin':'*'}); res.end(data);
    });
  });
  await new Promise(r => staticServer.listen(STATIC_PORT, r));

  // P1: Guest taps Your Projects → auth modal with context message
  await mockReset();
  await run('P1. Guest taps Your Projects -> auth modal with context message', async (page) => {
    const card = await page.$('.feature-card[aria-label="Your Projects"]');
    if(!card) throw new Error('Your Projects card not found');
    await card.click();
    await page.waitForSelector('#auth-modal.open', {timeout:5000});
    const ctx = await page.$eval('#auth-context-msg', el => el.textContent);
    if(!ctx.toLowerCase().includes('project')) throw new Error('Context message does not mention projects: ' + ctx);
  });

  // P2: Signed in → Your Projects screen opens, shows empty state
  await mockReset();
  await run('P2. Signed in -> Your Projects screen opens, shows empty state', async (page) => {
    await signUp(page, 'p2@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    const text = await page.$eval('#projects-list', el => el.innerText);
    if(!text.toLowerCase().includes('no projects')) throw new Error('Empty state not shown: ' + text);
  });

  // P3: Create a new project (name only, no list) → appears in list
  await mockReset();
  await run('P3. Create a new project (name only) -> appears in list', async (page) => {
    await signUp(page, 'p3@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'Kitchen Table');
    // Should be on project detail screen now
    const title = await page.$eval('#proj-detail-title', el => el.textContent);
    if(!title.includes('Kitchen Table')) throw new Error('Project detail title wrong: ' + title);
    // Go back to list
    await page.click('#proj-detail-back-btn');
    await page.waitForTimeout(300);
    const listText = await page.$eval('#projects-list', el => el.innerText);
    if(!listText.includes('Kitchen Table')) throw new Error('Project not in list: ' + listText);
  });

  // P4: Create a project with linked list → lumber cost shows correctly
  await mockReset();
  await run('P4. Create project with linked list -> lumber cost shows correctly', async (page) => {
    await signUp(page, 'p4@test.com', 'pass123');
    // Create a saved list with known cost by injecting via evaluate
    await page.evaluate(() => {
      const list = {
        id: 'list_test_1',
        name: 'Test List',
        species: [{
          id: 'sp1', name: 'White Oak', price: 10,
          items: [{
            id: 'it1', type: 'bf', thickness: '4', w: 6, lft: 1, lin: 0, qty: 1
          }]
        }]
      };
      projects.push(list);
    });
    await backToLanding(page);
    await openProjectsScreen(page);
    await page.click('#projects-add-btn');
    await page.waitForSelector('#project-modal.open', {timeout:3000});
    await page.fill('#proj-name-input', 'Linked Project');
    // Select the list
    await page.selectOption('#proj-list-select', 'list_test_1');
    await page.fill('#proj-rate-input', '0');
    await page.click('#proj-modal-save');
    await page.waitForFunction(() => !document.getElementById('project-modal').classList.contains('open'), {timeout:3000});
    await page.waitForTimeout(300);
    // Check lumber section shows cost
    const lumberText = await page.$eval('#proj-lumber-body', el => el.innerText);
    // 4/4 * 6" * 12"/144 * $10 = 1*6*12/144*10 = 720/144*1 = 5.00
    if(!lumberText.includes('$5.00')) throw new Error('Lumber cost wrong: ' + lumberText);
  });

  // P5: Open project → log a session with 2 breaks → hours and cost update
  await mockReset();
  await run('P5. Log session with 2 breaks -> hours and cost update in project total', async (page) => {
    await signUp(page, 'p5@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'Hours Test', {rate: 50});
    // Log session: 08:00-16:00, breaks 12:00-12:30, 15:00-15:15
    await logSessionInProject(page, '08:00', '16:00',
      [{start:'12:00', end:'12:30'}, {start:'15:00', end:'15:15'}], 'Test session');
    // Total: 480 - 30 - 15 = 435 min = 7.25 hrs * $50 = $362.50
    const totalText = await page.$eval('#proj-total-card', el => el.innerText);
    if(!totalText.includes('$362.50')) throw new Error('Labor cost wrong in total: ' + totalText);
  });

  // P6: Record a cut in Your Lumber → assign to project → cut appears in project
  await mockReset();
  await run('P6. Record cut in Your Lumber -> assign to project -> appears in project cuts', async (page) => {
    await signUp(page, 'p6@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'Cut Test');
    // Get project id
    const projId = await page.evaluate(() => projectsData[0].id);
    // Go to Your Lumber and add an item
    await page.click('#proj-detail-back-btn');
    await page.waitForTimeout(200);
    await page.click('#projects-back-btn');
    await page.waitForTimeout(200);
    // Navigate to Your Lumber
    const lumberCard = await page.$('.feature-card[aria-label="Your Lumber"]');
    await lumberCard.click();
    await page.waitForSelector('#shop-screen', {state:'visible', timeout:5000});
    await page.waitForTimeout(500);
    // Add a board foot item via evaluate
    await page.evaluate(() => {
      shopData = {
        kerf: 0, bf: [{
          id: 'shop_bf_1', species: 'White Oak', label: 'White Oak', type: 'bf',
          price: 10, thickness: '4', w: 6, lft: 2, lin: 0, qty: 1,
          value: 10, cuts: []
        }], lf: [], slab: [], sg: []
      };
      renderShop();
    });
    await page.waitForTimeout(500);
    // Expand all sections via JS (they're collapsed by default)
    await page.evaluate(() => {
      shopSectionState = {lumber:true, slab:true, sg:true};
      renderShop();
    });
    await page.waitForTimeout(500);
    // Find and click the Cut It button
    const cutBtnFound = await page.evaluate(() => {
      const btns = document.querySelectorAll('.shop-action-btn');
      for(const b of btns) {
        if(b.textContent.trim() === 'Cut It') { b.click(); return true; }
      }
      return false;
    });
    if(!cutBtnFound) throw new Error('No Cut It button found');
    await page.waitForSelector('#shop-cut-modal.open', {timeout:3000});
    // Fill cut amount
    await page.fill('#shop-cut-amt-in', '6');
    // Select project from dropdown
    await page.selectOption('#shop-cut-project', projId);
    await page.click('#shop-cut-confirm');
    await page.waitForFunction(() => !document.getElementById('shop-cut-modal').classList.contains('open'), {timeout:3000});
    await page.waitForTimeout(300);
    // Verify cut was attributed
    const shopState = await page.evaluate(() => {
      const item = shopData.bf[0];
      const cut = item.cuts[item.cuts.length - 1];
      return { projectId: cut.projectId, value: cut.value };
    });
    if(shopState.projectId !== projId) throw new Error('Cut not attributed to project');
    if(shopState.value <= 0) throw new Error('Cut value is 0');
    // Go back and check project
    await page.click('#shop-back-btn');
    await page.waitForTimeout(300);
    await openProjectsScreen(page);
    const card = await page.$('.proj-card');
    await card.click();
    await page.waitForSelector('#project-detail-screen', {state:'visible', timeout:3000});
    await page.waitForTimeout(300);
    const cutsText = await page.$eval('#proj-cuts-body', el => el.innerText);
    if(!cutsText.includes('White Oak')) throw new Error('Cut not showing in project: ' + cutsText);
  });

  // P7: Project total = lumber + labor + cuts
  await mockReset();
  await run('P7. Project total = lumber + labor + cuts (verified with known values)', async (page) => {
    await signUp(page, 'p7@test.com', 'pass123');
    // Inject saved list with known cost
    await page.evaluate(() => {
      projects.push({
        id: 'list_p7', name: 'P7 List',
        species: [{
          id: 'sp1', name: 'Oak', price: 10,
          items: [{ id: 'it1', type: 'bf', thickness: '4', w: 6, lft: 1, lin: 0, qty: 1 }]
        }]
      });
    });
    // Inject shop data with attributed cut
    await page.evaluate(() => {
      shopData = {
        kerf: 0, bf: [{
          id: 'bf1', species: 'Oak', type: 'bf', price: 10,
          thickness: '4', w: 6, lft: 2, lin: 0, qty: 1, value: 10,
          cuts: [{ date: 'Jul 14, 2026', amount: 'Crosscut: 6"', amountValue: 6,
                   mode: 'cross', value: 2.50, kerf: 0, note: '',
                   before: {}, projectId: null, projectName: null }]
        }], lf: [], slab: [], sg: []
      };
    });
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'Total Test', {rate: 25, listValue: 'list_p7'});
    // Get project id
    const projId = await page.evaluate(() => projectsData[0].id);
    // Attribute the cut to this project
    await page.evaluate((pid) => {
      shopData.bf[0].cuts[0].projectId = pid;
      shopData.bf[0].cuts[0].projectName = 'Total Test';
    }, projId);
    // Log session: 09:00-10:00, no breaks = 1hr * $25 = $25
    await logSessionInProject(page, '09:00', '10:00', [], '');
    // Force re-render
    await page.evaluate(() => renderProjectDetail());
    await page.waitForTimeout(200);
    const totalText = await page.$eval('#proj-total-card', el => el.innerText);
    // Lumber: $5.00 (4/4 * 6 * 12 / 144 * 10), Labor: $25.00, Cuts: $2.50, Total: $32.50
    if(!totalText.includes('$5.00')) throw new Error('Lumber wrong: ' + totalText);
    if(!totalText.includes('$25.00')) throw new Error('Labor wrong: ' + totalText);
    if(!totalText.includes('$2.50')) throw new Error('Cuts wrong: ' + totalText);
    if(!totalText.includes('$32.50')) throw new Error('Total wrong: ' + totalText);
  });

  // P8: Edit project name → updates everywhere
  await mockReset();
  await run('P8. Edit project name -> updates everywhere', async (page) => {
    await signUp(page, 'p8@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'Old Name');
    // Edit via options menu
    await page.click('#proj-detail-options-btn');
    await page.waitForTimeout(200);
    await page.click('#proj-opt-edit');
    await page.waitForSelector('#project-modal.open', {timeout:3000});
    await page.fill('#proj-name-input', 'New Name');
    await page.click('#proj-modal-save');
    await page.waitForFunction(() => !document.getElementById('project-modal').classList.contains('open'), {timeout:3000});
    await page.waitForTimeout(200);
    const title = await page.$eval('#proj-detail-title', el => el.textContent);
    if(!title.includes('New Name')) throw new Error('Detail title not updated: ' + title);
    // Go back to list
    await page.click('#proj-detail-back-btn');
    await page.waitForTimeout(300);
    const listText = await page.$eval('#projects-list', el => el.innerText);
    if(!listText.includes('New Name')) throw new Error('List not updated: ' + listText);
    if(listText.includes('Old Name')) throw new Error('Old name still in list');
  });

  // P9: Mark project complete → shows Complete badge
  await mockReset();
  await run('P9. Mark project complete -> shows Complete badge', async (page) => {
    await signUp(page, 'p9@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'Status Test');
    // Should be Active initially — the status toggle button says "Mark Complete" when project is active
    let statusText = await page.$eval('#proj-opt-status', el => el.textContent);
    if(!statusText.includes('Mark Complete')) throw new Error('Not active initially: ' + statusText);
    // Mark complete
    await page.click('#proj-detail-options-btn');
    await page.waitForTimeout(200);
    await page.click('#proj-opt-status');
    await page.waitForTimeout(300);
    statusText = await page.$eval('#proj-opt-status', el => el.textContent);
    if(!statusText.includes('Mark Active')) throw new Error('Not marked complete: ' + statusText);
    // Verify badge in list
    await page.click('#proj-detail-back-btn');
    await page.waitForTimeout(300);
    const listHTML = await page.$eval('#projects-list', el => el.innerHTML);
    if(!listHTML.includes('Complete')) throw new Error('Complete badge not in list');
  });

  // P10: Delete project → removed from list
  await mockReset();
  await run('P10. Delete project -> removed from list', async (page) => {
    await signUp(page, 'p10@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'To Delete');
    await page.click('#proj-detail-options-btn');
    await page.waitForTimeout(200);
    await page.click('#proj-opt-delete');
    // appConfirm dialog
    await page.waitForSelector('#ac-ok', {timeout:3000});
    await page.click('#ac-ok');
    await page.waitForTimeout(500);
    // Should be back on projects list
    const listText = await page.$eval('#projects-list', el => el.innerText);
    if(listText.includes('To Delete')) throw new Error('Project still in list after deletion');
  });

  // P11: Log Session modal has no "Link to list" dropdown
  await mockReset();
  await run('P11. Log Session modal has no Link to list dropdown (auto-assigns to project)', async (page) => {
    await signUp(page, 'p11@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'No List Dropdown');
    await page.click('#proj-log-session-btn');
    await page.waitForSelector('#hours-log-modal.open', {timeout:3000});
    const listDiv = await page.$('#hours-log-list');
    const display = await listDiv.evaluate(el => el.parentElement.style.display);
    if(display !== 'none') throw new Error('Link to list dropdown is visible: display=' + display);
    await page.click('#hours-log-cancel');
  });

  // P12: PDF export (per-project) → correct totals
  await mockReset();
  await run('P12. PDF export (per-project) -> downloads with correct filename', async (page) => {
    await signUp(page, 'p12@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'PDF Test', {rate: 30});
    await logSessionInProject(page, '09:00', '11:00', [], '');
    // Check that exportProjectPDF is callable
    const hasFn = await page.evaluate(() => typeof exportProjectPDF === 'function');
    if(!hasFn) throw new Error('exportProjectPDF function not found');
    // Trigger download and check filename
    const [download] = await Promise.all([
      page.waitForEvent('download', {timeout:5000}),
      page.evaluate(() => {
        exportProjectPDF(projectsData[0].id);
      })
    ]);
    const filename = download.suggestedFilename();
    if(!filename.includes('pdf-test')) throw new Error('PDF filename wrong: ' + filename);
  });

  // P13: Cross-device: create project on A → appears on B after sign-in
  await mockReset();
  await run('P13. Cross-device: create project on A -> appears on B after sign-in', async (page) => {
    await signUp(page, 'p13@test.com', 'pass123');
    await backToLanding(page);
    await openProjectsScreen(page);
    await createProject(page, 'Cross Device');
    await page.click('#proj-detail-back-btn');
    await page.waitForTimeout(200);
    // Verify project is in mock
    const dump = await mockDump();
    const found = dump.projects.find(p => p.data && p.data.name === 'Cross Device');
    if(!found) throw new Error('Project not found in mock server');
    // Open new "device"
    const ctx2 = await browser.newContext({viewport:{width:390,height:844}});
    const page2 = await ctx2.newPage();
    await page2.goto(APP_URL, {waitUntil:'domcontentloaded', timeout:10000});
    await page2.waitForSelector('#landing-screen', {state:'visible', timeout:5000});
    await signIn(page2, 'p13@test.com', 'pass123');
    await backToLanding(page2);
    await openProjectsScreen(page2);
    const listText = await page2.$eval('#projects-list', el => el.innerText);
    if(!listText.includes('Cross Device')) throw new Error('Project not found on device B: ' + listText);
    await ctx2.close();
  });

  // P14: Your Lumber name correct everywhere (not "Your Shop")
  await mockReset();
  await run('P14. Your Lumber name correct everywhere (not "Your Shop")', async (page) => {
    const text = await page.evaluate(() => document.body.innerText);
    if(text.includes('Your Shop')) throw new Error('Found "Your Shop" in visible text');
    if(!text.includes('Your Lumber')) throw new Error('Missing "Your Lumber" in visible text');
  });

  // P15: Delete Account is grey text (not red button)
  await mockReset();
  await run('P15. Delete Account is grey underlined text (not red button)', async (page) => {
    await signUp(page, 'p15@test.com', 'pass123');
    await backToLanding(page);
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', {timeout:3000});
    const btn = await page.$('#auth-delete-account-btn');
    if(!btn) throw new Error('Delete Account button not found');
    const styles = await btn.evaluate(el => ({
      bg: getComputedStyle(el).background,
      td: getComputedStyle(el).textDecoration,
      fs: getComputedStyle(el).fontSize,
      border: getComputedStyle(el).border
    }));
    if(styles.bg.includes('rgb(255') || styles.bg.includes('red')) throw new Error('Delete Account has red background');
    if(!styles.td.includes('underline')) throw new Error('Delete Account not underlined');
    const size = parseInt(styles.fs);
    if(size > 14) throw new Error('Delete Account font too large: ' + styles.fs);
  });

  // P16: Calculate Lumber button present
  await mockReset();
  await run('P16. Calculate Lumber button present', async (page) => {
    const btn = await page.$('#start-btn');
    if(!btn) throw new Error('Calculate Lumber button not found');
    const text = await btn.textContent();
    if(!text.includes('Calculate Lumber')) throw new Error('Button text wrong: ' + text);
  });

  // P17: × close button on auth modal (not "Close" button)
  await mockReset();
  await run('P17. x close button on auth modal (not "Close" button)', async (page) => {
    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', {timeout:3000});
    const closeBtn = await page.$('#auth-close-btn');
    if(!closeBtn) throw new Error('Close button not found');
    const text = await closeBtn.textContent();
    if(text.trim() === 'Close') throw new Error('Close button says "Close" instead of ×');
    if(!text.includes('×')) throw new Error('Close button missing × character: ' + text);
  });

  // P18: 2×2 feature card grid renders correctly, all 4 cards tappable
  await mockReset();
  await run('P18. 2x2 feature card grid renders correctly, all 4 cards', async (page) => {
    const cards = await page.$$('.feature-card');
    if(cards.length !== 4) throw new Error('Expected 4 feature cards, got ' + cards.length);
    const labels = [];
    for(const c of cards) {
      const label = await c.getAttribute('aria-label');
      labels.push(label);
    }
    const expected = ['$/BF Check', 'Quick Calc', 'Your Projects', 'Your Lumber'];
    for(const exp of expected) {
      if(!labels.includes(exp)) throw new Error('Missing card: ' + exp);
    }
  });

  // P19: Primary CTA visible without scrolling on 390px screen
  await mockReset();
  await run('P19. Primary CTA visible without scrolling on 390px screen', async (page) => {
    const box = await page.$eval('#start-btn', el => {
      const r = el.getBoundingClientRect();
      return {top: r.top, bottom: r.bottom};
    });
    if(box.bottom > 844) throw new Error('Calculate Lumber button below fold: bottom=' + box.bottom);
  });

  // P20 will be run separately as the existing regression tests

  await browser.close();
  staticServer.close();
  if(mockProc) mockProc.kill();

  console.log('\n========================================');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`Projects Tests: ${passed}/${results.length} passed, ${failed} FAILED`);
  console.log('========================================\n');
  if(failed > 0) process.exit(1);
})();
