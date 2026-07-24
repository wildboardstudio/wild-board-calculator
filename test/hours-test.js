const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = 'http://localhost:8900/index.html';
const MOCK = 'http://localhost:8901';
const CHROME_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '\n       ' + detail : ''));
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function mockReset() {
  const r = await fetch(MOCK + '/_test/reset', { method: 'POST' });
  return r.json();
}
async function mockDump() {
  const r = await fetch(MOCK + '/_test/dump');
  return r.json();
}

async function newPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  return { context, page, errors };
}

async function openAuthFromLanding(page) {
  await page.click('#landing-account-btn');
  await page.waitForSelector('#auth-modal.open', { state: 'attached' });
}

async function waitSignedIn(page) {
  await page.waitForFunction(() => document.getElementById('landing-account-btn').textContent === 'My Account', null, { timeout: 5000 });
}

async function signUp(page, email, password) {
  await openAuthFromLanding(page);
  const modeText = await page.$eval('#auth-modal-title', (el) => el.textContent);
  if (modeText.trim() !== 'Create Account') await page.click('#auth-toggle-btn');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await waitSignedIn(page);
  await sleep(500);
}

async function signIn(page, email, password) {
  await openAuthFromLanding(page);
  const modeText = await page.$eval('#auth-modal-title', (el) => el.textContent);
  if (modeText.trim() !== 'Sign In') await page.click('#auth-toggle-btn');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await waitSignedIn(page);
  await sleep(500);
}

async function openHoursTracker(page) {
  await page.click('button[onclick="showHoursTracker()"]');
  await page.waitForSelector('#hours-screen', { state: 'visible', timeout: 5000 });
  await sleep(400);
}

async function logSession(page, { start, end, breaks, note, listIndex }) {
  await page.click('#hours-add-btn');
  await page.waitForSelector('#hours-log-modal.open', { state: 'attached' });
  await sleep(200);

  await page.fill('#hours-log-start', start);
  await page.fill('#hours-log-end', end);

  if (listIndex !== undefined && listIndex > 0) {
    await page.selectOption('#hours-log-list', { index: listIndex });
  }

  if (breaks && breaks.length > 0) {
    for (let i = 0; i < breaks.length; i++) {
      const rows = await page.$$('#hours-breaks-list > div');
      if (i >= rows.length) {
        await page.click('#hours-add-break-btn');
        await sleep(100);
      }
      const allRows = await page.$$('#hours-breaks-list > div');
      const row = allRows[i];
      const bStart = await row.$('.hours-break-start');
      const bEnd = await row.$('.hours-break-end');
      await bStart.fill(breaks[i].start);
      await bEnd.fill(breaks[i].end);
    }
  }

  if (note) {
    await page.fill('#hours-log-note', note);
  }

  await sleep(100);
  await page.click('#hours-log-save');
  await sleep(400);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const EMAIL = 'hours-test@example.com';
  const PWD = 'test-password-123';

  // ============ H1: Guest taps Hours Tracker -> auth modal opens with context message ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);

    await page.click('button[onclick="showHoursTracker()"]');
    await page.waitForSelector('#auth-modal.open', { state: 'attached' });
    const hoursVisible = await page.evaluate(() => document.getElementById('hours-screen').style.display === 'block');
    const ctxMsg = await page.$eval('#auth-context-msg', (el) => el.textContent);
    assert(!hoursVisible, 'hours-screen must not open for guest');
    assert(/hours|labor/i.test(ctxMsg), 'expected hours/labor context message, got: ' + ctxMsg);

    record('H1. Guest taps Hours Tracker -> auth modal with context message', true);
    await context.close();
  } catch (e) {
    record('H1. Guest taps Hours Tracker -> auth modal with context message', false, e.stack || e.message);
  }

  // ============ H2: Signed in -> Hours Tracker screen opens from landing page card ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);

    await openHoursTracker(page);
    const hoursVisible = await page.evaluate(() => document.getElementById('hours-screen').style.display === 'block');
    const landingVisible = await page.evaluate(() => getComputedStyle(document.getElementById('landing-screen')).display !== 'none');
    assert(hoursVisible, 'hours-screen should be visible');
    assert(!landingVisible, 'landing should be hidden');

    record('H2. Signed in -> Hours Tracker opens from landing page card', true);
    await context.close();
  } catch (e) {
    record('H2. Signed in -> Hours Tracker opens from landing page card', false, e.stack || e.message);
  }

  // ============ H3: Log a standalone session with 2 breaks -> correct hours and cost ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);
    await openHoursTracker(page);

    // Set rate to $50/hr
    await page.fill('#hours-rate-input', '50');
    await page.dispatchEvent('#hours-rate-input', 'change');
    await sleep(300);

    // Log session: 08:00-16:00, breaks 10:00-10:15 and 12:00-12:30
    // Total: 8h - 0.25h - 0.5h = 7.25h = 435 min, cost = 7.25 * 50 = $362.50
    await logSession(page, {
      start: '08:00', end: '16:00',
      breaks: [{ start: '10:00', end: '10:15' }, { start: '12:00', end: '12:30' }]
    });

    const sessionList = await page.$('#hours-sessions-list');
    const sessionHtml = await sessionList.innerHTML();
    assert(/7\.3\s*hrs/i.test(sessionHtml), 'expected ~7.3 hrs in session list, got: ' + sessionHtml.slice(0, 200));
    assert(/\$362\.50/.test(sessionHtml), 'expected $362.50 cost');

    const summary = await page.$eval('#hours-summary', (el) => el.textContent);
    assert(/7\.3/.test(summary), 'summary should show ~7.3 hrs');
    assert(/362\.50/.test(summary), 'summary should show $362.50');

    // Verify "Standalone" label
    assert(/Standalone/i.test(sessionHtml), 'session should show Standalone');

    record('H3. Log standalone session with 2 breaks -> correct hours and cost', true);
    await context.close();
  } catch (e) {
    record('H3. Log standalone session with 2 breaks -> correct hours and cost', false, e.stack || e.message);
  }

  // ============ H4: Log a session linked to a saved list -> grouped correctly ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);

    // Create a saved list via the calculator
    await page.click('#start-btn');
    await page.waitForSelector('#app-screen', { state: 'visible' });
    await page.evaluate(() => {
      species = [{
        id: uid(), name: 'White Oak', waste: '',
        thicknesses: [{ id: uid(), tNum: '4', price: '5', waste: 0, boards: [{ id: uid(), lft: '8', lin: '0', w: '6' }] }]
      }];
      if (typeof render === 'function') render();
      if (typeof saveSession === 'function') saveSession();
    });
    await sleep(200);

    await page.click('#save-btn');
    await page.waitForSelector('#name-modal.open', { state: 'attached', timeout: 3000 });
    await page.fill('#name-modal-input', 'Kitchen Table');
    await page.click('#name-modal-save');
    await sleep(800);

    await page.click('#back-btn');
    await page.waitForSelector('#landing-screen', { state: 'visible', timeout: 3000 });
    await sleep(200);

    // Open hours tracker
    await openHoursTracker(page);
    await page.fill('#hours-rate-input', '40');
    await page.dispatchEvent('#hours-rate-input', 'change');
    await sleep(200);

    // Log session linked to the list
    await page.click('#hours-add-btn');
    await page.waitForSelector('#hours-log-modal.open', { state: 'attached' });
    await sleep(200);

    // Check that Kitchen Table appears in dropdown
    const listOptions = await page.$$eval('#hours-log-list option', (opts) => opts.map((o) => o.textContent));
    assert(listOptions.some((o) => /Kitchen Table/i.test(o)), 'Kitchen Table should be in list dropdown, got: ' + listOptions.join(', '));

    await page.fill('#hours-log-start', '09:00');
    await page.fill('#hours-log-end', '12:00');
    // Select Kitchen Table (second option, index 1)
    await page.selectOption('#hours-log-list', { index: 1 });
    await sleep(100);
    await page.click('#hours-log-save');
    await sleep(400);

    const sessionHtml = await page.$eval('#hours-sessions-list', (el) => el.innerHTML);
    assert(/Kitchen Table/i.test(sessionHtml), 'session should show Kitchen Table link');

    record('H4. Log session linked to saved list -> grouped correctly', true);
    await context.close();
  } catch (e) {
    record('H4. Log session linked to saved list -> grouped correctly', false, e.stack || e.message);
  }

  // ============ H5: Change hourly rate -> all labor costs update immediately ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);
    await openHoursTracker(page);

    await page.fill('#hours-rate-input', '25');
    await page.dispatchEvent('#hours-rate-input', 'change');
    await sleep(200);

    // Log a 2-hour session (10:00-12:00, no breaks)
    await logSession(page, { start: '10:00', end: '12:00' });

    let sessionHtml = await page.$eval('#hours-sessions-list', (el) => el.innerHTML);
    assert(/\$50\.00/.test(sessionHtml), 'expected $50 at $25/hr for 2hrs');

    // Change rate to $100
    await page.fill('#hours-rate-input', '100');
    await page.dispatchEvent('#hours-rate-input', 'change');
    await sleep(300);

    sessionHtml = await page.$eval('#hours-sessions-list', (el) => el.innerHTML);
    assert(/\$200\.00/.test(sessionHtml), 'expected $200 at $100/hr for 2hrs');

    const summary = await page.$eval('#hours-summary', (el) => el.textContent);
    assert(/200\.00/.test(summary), 'summary should show $200');

    record('H5. Change hourly rate -> all labor costs update immediately', true);
    await context.close();
  } catch (e) {
    record('H5. Change hourly rate -> all labor costs update immediately', false, e.stack || e.message);
  }

  // ============ H6: Delete a session -> removed from list and totals ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);
    await openHoursTracker(page);

    await page.fill('#hours-rate-input', '50');
    await page.dispatchEvent('#hours-rate-input', 'change');
    await sleep(200);

    // Log two sessions
    await logSession(page, { start: '08:00', end: '12:00' }); // 4 hrs
    await logSession(page, { start: '13:00', end: '17:00' }); // 4 hrs

    let summary = await page.$eval('#hours-summary', (el) => el.textContent);
    assert(/8\.0/.test(summary), 'should show 8 hrs total');

    // Delete the first session (appConfirm custom modal)
    const deleteBtn = await page.$('[data-hours-del]');
    assert(deleteBtn, 'should have a delete button');
    await deleteBtn.click();
    await sleep(300);
    // Click the confirm button in the custom appConfirm modal
    await page.click('#ac-ok');
    await sleep(500);

    summary = await page.$eval('#hours-summary', (el) => el.textContent);
    assert(/4\.0/.test(summary), 'should show 4 hrs after deleting one session');

    record('H6. Delete a session -> removed from list and totals', true);
    await context.close();
  } catch (e) {
    record('H6. Delete a session -> removed from list and totals', false, e.stack || e.message);
  }

  // ============ H7: Filter by list -> shows only sessions for that list ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);

    // Create a saved list
    await page.click('#start-btn');
    await page.waitForSelector('#app-screen', { state: 'visible' });
    await page.evaluate(() => {
      species = [{
        id: uid(), name: 'Maple', waste: '',
        thicknesses: [{ id: uid(), tNum: '4', price: '5', waste: 0, boards: [{ id: uid(), lft: '8', lin: '0', w: '6' }] }]
      }];
      if (typeof render === 'function') render();
      if (typeof saveSession === 'function') saveSession();
    });
    await sleep(200);
    await page.click('#save-btn');
    await page.waitForSelector('#name-modal.open', { state: 'attached', timeout: 3000 });
    await page.fill('#name-modal-input', 'Bookshelf');
    await page.click('#name-modal-save');
    await sleep(800);
    await page.click('#back-btn');
    await page.waitForSelector('#landing-screen', { state: 'visible', timeout: 3000 });
    await sleep(200);

    await openHoursTracker(page);
    await page.fill('#hours-rate-input', '30');
    await page.dispatchEvent('#hours-rate-input', 'change');
    await sleep(200);

    // Log standalone session
    await logSession(page, { start: '08:00', end: '10:00', note: 'standalone work' });

    // Log linked session
    await page.click('#hours-add-btn');
    await page.waitForSelector('#hours-log-modal.open', { state: 'attached' });
    await sleep(200);
    await page.fill('#hours-log-start', '13:00');
    await page.fill('#hours-log-end', '15:00');
    await page.selectOption('#hours-log-list', { index: 1 });
    await page.fill('#hours-log-note', 'bookshelf work');
    await sleep(100);
    await page.click('#hours-log-save');
    await sleep(400);

    // All sessions: should see both
    let html = await page.$eval('#hours-sessions-list', (el) => el.innerHTML);
    assert(/standalone work/i.test(html), 'should see standalone session');
    assert(/bookshelf work/i.test(html), 'should see bookshelf session');

    // Filter: Standalone only
    await page.selectOption('#hours-filter', 'standalone');
    await sleep(200);
    html = await page.$eval('#hours-sessions-list', (el) => el.innerHTML);
    assert(/standalone work/i.test(html), 'standalone filter should show standalone session');
    assert(!/bookshelf work/i.test(html), 'standalone filter should hide bookshelf session');

    // Filter: by list (the list option is added dynamically as the 3rd option)
    const filterOptions = await page.$$eval('#hours-filter option', (opts) => opts.map((o) => ({ value: o.value, text: o.textContent })));
    const listOption = filterOptions.find((o) => o.value !== 'all' && o.value !== 'standalone');
    assert(listOption, 'should have a list-specific filter option');
    await page.selectOption('#hours-filter', listOption.value);
    await sleep(200);
    html = await page.$eval('#hours-sessions-list', (el) => el.innerHTML);
    assert(!/standalone work/i.test(html), 'list filter should hide standalone session');
    assert(/bookshelf work/i.test(html), 'list filter should show bookshelf session');

    record('H7. Filter by list -> shows only sessions for that list', true);
    await context.close();
  } catch (e) {
    record('H7. Filter by list -> shows only sessions for that list', false, e.stack || e.message);
  }

  // ============ H8: Cross-device: log on A -> appears on B after sign-in ============
  try {
    await mockReset();
    const { context: ctxA, page: pageA } = await newPage(browser);
    await signUp(pageA, EMAIL, PWD);
    await openHoursTracker(pageA);

    await page_fill_rate(pageA, '75');
    await logSession(pageA, { start: '08:00', end: '12:00', note: 'device A work' });
    await sleep(500);

    // Device B: new context, sign in
    const { context: ctxB, page: pageB } = await newPage(browser);
    await signIn(pageB, EMAIL, PWD);
    await openHoursTracker(pageB);

    const html = await pageB.$eval('#hours-sessions-list', (el) => el.innerHTML);
    assert(/device A work/i.test(html), 'session from device A should appear on device B');

    const rate = await pageB.$eval('#hours-rate-input', (el) => el.value);
    assert(rate === '75', 'rate should sync to device B, got: ' + rate);

    record('H8. Cross-device: log on A -> appears on B after sign-in', true);
    await ctxA.close();
    await ctxB.close();
  } catch (e) {
    record('H8. Cross-device: log on A -> appears on B after sign-in', false, e.stack || e.message);
  }

  // ============ H9: PDF export -> downloads successfully ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);
    await openHoursTracker(page);

    await page_fill_rate(page, '40');
    await logSession(page, { start: '09:00', end: '17:00', breaks: [{ start: '12:00', end: '13:00' }], note: 'full day' });

    // Intercept download
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.click('#hours-pdf-btn')
    ]);
    const filename = download.suggestedFilename();
    assert(/hours/i.test(filename), 'PDF filename should contain "hours", got: ' + filename);

    record('H9. PDF export -> downloads with correct filename', true);
    await context.close();
  } catch (e) {
    record('H9. PDF export -> downloads with correct filename', false, e.stack || e.message);
  }

  // ============ H10: Back button returns to correct previous screen ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);

    // From landing -> hours -> back -> landing
    await openHoursTracker(page);
    await page.click('#hours-back-btn');
    await sleep(300);
    const landingVisible = await page.evaluate(() => getComputedStyle(document.getElementById('landing-screen')).display !== 'none');
    assert(landingVisible, 'should return to landing screen');

    record('H10. Back button returns to correct previous screen', true);
    await context.close();
  } catch (e) {
    record('H10. Back button returns to correct previous screen', false, e.stack || e.message);
  }

  // ============ H11: Your Lumber name correct everywhere (not "Your Shop") ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);

    const bodyText = await page.evaluate(() => document.body.innerText);
    assert(!/Your\s+Shop/i.test(bodyText), 'should not contain "Your Shop" in visible text');

    const lumberCard = await page.$('button[onclick="showShop()"] .fc-name');
    const lumberText = await lumberCard.textContent();
    assert(/Your Lumber/i.test(lumberText), 'feature card should say "Your Lumber", got: ' + lumberText);

    record('H11. Your Lumber name correct everywhere', true);
    await context.close();
  } catch (e) {
    record('H11. Your Lumber name correct everywhere', false, e.stack || e.message);
  }

  // ============ H12: Delete Account is grey text (not red button) ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, EMAIL, PWD);

    await page.click('#landing-account-btn');
    await page.waitForSelector('#auth-modal.open', { state: 'attached' });

    const deleteBtn = await page.$('#auth-delete-account-btn');
    assert(deleteBtn, 'delete account button should exist');
    const styles = await deleteBtn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, textDecoration: cs.textDecoration, fontSize: cs.fontSize };
    });
    assert(styles.bg === 'rgba(0, 0, 0, 0)' || styles.bg === 'transparent', 'delete btn should have transparent bg, got: ' + styles.bg);
    assert(/underline/.test(styles.textDecoration), 'delete btn should be underlined');

    record('H12. Delete Account is grey underlined text (not red button)', true);
    await context.close();
  } catch (e) {
    record('H12. Delete Account is grey underlined text (not red button)', false, e.stack || e.message);
  }

  // ============ H13: Calculate Lumber button present on landing page ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);

    const startBtn = await page.$('#start-btn');
    const text = await startBtn.textContent();
    assert(/Calculate Lumber/i.test(text), 'start button should say "Calculate Lumber", got: ' + text);

    record('H13. Calculate Lumber button present on landing page', true);
    await context.close();
  } catch (e) {
    record('H13. Calculate Lumber button present on landing page', false, e.stack || e.message);
  }

  // ============ H14: 2x2 feature card grid renders correctly, all 4 cards tappable ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);

    const cards = await page.$$('.feature-card');
    assert(cards.length === 4, 'should have 4 feature cards, got: ' + cards.length);

    const cardNames = [];
    for (const card of cards) {
      const name = await card.$eval('.fc-name', (el) => el.textContent);
      cardNames.push(name);
    }
    assert(cardNames.includes('$/BF Check'), 'missing $/BF Check card');
    assert(cardNames.includes('Quick Calc'), 'missing Quick Calc card');
    assert(cardNames.includes('Hours Tracker'), 'missing Hours Tracker card');
    assert(cardNames.includes('Your Lumber'), 'missing Your Lumber card');

    // Verify grid layout (2 columns)
    const gridStyle = await page.$eval('.feature-grid', (el) => getComputedStyle(el).gridTemplateColumns);
    assert(gridStyle && gridStyle.split(' ').length >= 2, 'grid should have 2 columns');

    record('H14. 2x2 feature card grid renders correctly, all 4 cards', true);
    await context.close();
  } catch (e) {
    record('H14. 2x2 feature card grid renders correctly, all 4 cards', false, e.stack || e.message);
  }

  // ============ H15: Primary CTA visible without scrolling on 390px screen ============
  try {
    await mockReset();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const startBtn = await page.$('#start-btn');
    const box = await startBtn.boundingBox();
    assert(box, 'start button should be visible');
    assert(box.y + box.height <= 844, 'start button should be within viewport (bottom: ' + (box.y + box.height) + ', viewport: 844)');

    // Also check resume-btn area and secondary buttons are above fold
    const accountBtn = await page.$('#landing-account-btn');
    if (accountBtn) {
      const accBox = await accountBtn.boundingBox();
      assert(accBox && accBox.y + accBox.height <= 844, 'account button should be within viewport');
    }

    record('H15. Primary CTA visible without scrolling on 390px screen', true);
    await context.close();
  } catch (e) {
    record('H15. Primary CTA visible without scrolling on 390px screen', false, e.stack || e.message);
  }

  await browser.close();

  console.log('\n========================================');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('Hours Tracker Tests: ' + passed + '/' + results.length + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();

async function page_fill_rate(page, val) {
  await page.fill('#hours-rate-input', val);
  await page.dispatchEvent('#hours-rate-input', 'change');
  await sleep(200);
}
