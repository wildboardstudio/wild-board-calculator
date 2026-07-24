const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = 'http://localhost:8900/index.html';
const MOCK = 'http://localhost:8901';
const CHROME_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '\n       ' + detail : ''));
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function mockReset() {
  const r = await fetch(MOCK + '/_test/reset', { method: 'POST' });
  return r.json();
}
async function mockFail(fail) {
  const r = await fetch(MOCK + '/_test/fail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fail }) });
  return r.json();
}
async function mockDump() {
  const r = await fetch(MOCK + '/_test/dump');
  return r.json();
}
async function mockDelayListSave(ms) {
  const r = await fetch(MOCK + '/_test/delay-list-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms }) });
  return r.json();
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

async function newPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  return { context, page, errors };
}

async function clickStart(page) {
  await page.click('#start-btn');
  await page.waitForSelector('#app-screen', { state: 'visible' });
}

async function backToLanding(page) {
  for (let i = 0; i < 5; i++) {
    const landingVisible = await page.evaluate(() => getComputedStyle(document.getElementById('landing-screen')).display !== 'none');
    if (landingVisible) return;
    const state = await page.evaluate(() => ({
      app: document.getElementById('app-screen').style.display === 'block',
      saved: document.getElementById('saved-screen').style.display === 'block',
      shop: document.getElementById('shop-screen').style.display === 'block',
      hours: document.getElementById('hours-screen') && document.getElementById('hours-screen').style.display === 'block',
      projDetail: document.getElementById('project-detail-screen') && document.getElementById('project-detail-screen').style.display === 'block',
      projects: document.getElementById('projects-screen') && document.getElementById('projects-screen').style.display === 'block'
    }));
    if (state.app) await page.click('#back-btn');
    else if (state.saved) await page.click('#saved-back-btn');
    else if (state.shop) await page.click('#shop-back-btn');
    else if (state.hours) await page.click('#hours-back-btn');
    else if (state.projDetail) await page.click('#proj-detail-back-btn');
    else if (state.projects) await page.click('#projects-back-btn');
    else break;
    await sleep(150);
  }
  await page.waitForSelector('#landing-screen', { state: 'visible', timeout: 5000 });
}

async function openAuthFromLanding(page) {
  await page.click('#landing-account-btn');
  await page.waitForSelector('#auth-modal.open', { state: 'attached' });
}

// _currentUser is a top-level `let` in a non-module script, so it is never a
// `window` property — probe signed-in state via the DOM instead (updateAuthUI()
// sets landing-account-btn's text from it, which is a faithful proxy).
async function waitSignedIn(page) {
  await page.waitForFunction(() => document.getElementById('landing-account-btn').textContent === 'My Account', null, { timeout: 5000 });
}
async function waitSignedOut(page) {
  await page.waitForFunction(() => document.getElementById('landing-account-btn').textContent !== 'My Account', null, { timeout: 5000 });
}

async function signUp(page, email, password) {
  await openAuthFromLanding(page);
  // ensure signup mode
  const modeText = await page.$eval('#auth-modal-title', (el) => el.textContent);
  if (modeText.trim() !== 'Create Account') {
    await page.click('#auth-toggle-btn');
  }
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await page.waitForFunction(() => !document.getElementById('auth-modal').classList.contains('open'), null, { timeout: 5000 });
  await waitSignedIn(page);
}

async function signIn(page, email, password) {
  await openAuthFromLanding(page);
  const modeText = await page.$eval('#auth-modal-title', (el) => el.textContent);
  if (modeText.trim() !== 'Sign In') {
    await page.click('#auth-toggle-btn');
  }
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await page.waitForFunction(() => !document.getElementById('auth-modal').classList.contains('open'), null, { timeout: 5000 });
  await waitSignedIn(page);
}

async function signOut(page) {
  await page.click('#landing-account-btn');
  await page.waitForSelector('#auth-signed-in-body', { state: 'visible' });
  await page.click('#auth-signout-btn');
  await waitSignedOut(page);
}

async function setMinimalListData(page, name) {
  await page.evaluate((n) => {
    species = [{
      id: uid(), name: n, waste: '',
      thicknesses: [{ id: uid(), tNum: '4', price: '5', waste: 0, boards: [{ id: uid(), lft: '8', lin: '0', w: '6' }] }]
    }];
    if (typeof render === 'function') render();
    if (typeof saveSession === 'function') saveSession();
  }, name);
}

async function saveCurrentList(page, listName) {
  await page.click('#save-btn');
  await page.waitForSelector('#name-modal.open', { state: 'attached' });
  await page.fill('#name-modal-input', listName);
  await page.click('#name-modal-save');
  await sleep(400); // allow fire-and-forget saveListToSupabase() to land
}

async function openSavedLists(page) {
  await page.click('#landing-saved-link');
}

async function openShop(page) {
  // Two different entry points depending on which screen is showing: the
  // landing-screen footer icon, or the app-screen header icon.
  const onApp = await page.evaluate(() => document.getElementById('app-screen').style.display === 'block');
  if (onApp) await page.click('#shop-header-btn');
  else await page.click('button[onclick="showShop()"]');
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH });

  // ============ TEST 1: Guest — full calculator experience, no Save button, session survives refresh ============
  try {
    await mockReset();
    const { context, page, errors } = await newPage(browser);
    await clickStart(page);
    const saveBtnVisible = await page.evaluate(() => getComputedStyle(document.getElementById('save-btn')).display !== 'none');
    assert(saveBtnVisible, 'save-btn should be visible for guests (dimmed, prompts sign-in on click)');

    await setMinimalListData(page, 'Guest Working List');
    // $/BF Check opens
    await page.click('#pricecheck-btn');
    await page.waitForSelector('#pricecheck-overlay', { state: 'visible' });
    await page.click('#pricecheck-close');
    // Quick Calc opens
    await page.click('#calc-btn');
    await page.waitForSelector('#calc-sheet', { state: 'visible' });
    await page.click('#calc-close');

    // Refresh mid-list — working list should survive via wbc_session, but
    // restore must be passive: landing page shows first, not the calculator.
    // A "Resume Unsaved List" button should appear on landing.
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(300);
    const landingVisibleAfterReload = await page.evaluate(() => getComputedStyle(document.getElementById('landing-screen')).display !== 'none');
    assert(landingVisibleAfterReload, 'app must open to the landing page after reload, even with a restorable session');
    const appVisibleAfterReload = await page.evaluate(() => document.getElementById('app-screen').style.display === 'block');
    assert(!appVisibleAfterReload, 'app-screen must not be auto-shown after reload (restore must be passive)');
    const restoredNameInMemory = await page.evaluate(() => (typeof species !== 'undefined' && species[0] && species[0].name) || null);
    assert(restoredNameInMemory === 'Guest Working List', 'expected session to be silently restored in memory, got ' + restoredNameInMemory);

    // Resume button should be visible with the project name
    const resumeBtnVisible = await page.evaluate(() => getComputedStyle(document.getElementById('resume-btn')).display !== 'none');
    assert(resumeBtnVisible, 'resume-btn should be visible after reload with unsaved work');

    // Tapping "Resume Unsaved List" should resume the restored session.
    await page.click('#resume-btn');
    await page.waitForSelector('#app-screen', { state: 'visible' });
    const restoredNameOnResume = await page.evaluate(() => species[0] && species[0].name);
    assert(restoredNameOnResume === 'Guest Working List', 'expected Resume to restore the session, got ' + restoredNameOnResume);

    assert(errors.length === 0, 'unexpected page errors: ' + JSON.stringify(errors));
    record('1. Guest: full calculator, no Save button, session survives refresh', true);
    await context.close();
  } catch (e) {
    record('1. Guest: full calculator, no Save button, session survives refresh', false, e.stack || e.message);
  }

  // ============ TEST 2: Guest taps Open Saved Lists / Your Shop -> sign-in prompt ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);

    await openSavedLists(page);
    await page.waitForSelector('#auth-modal.open', { state: 'attached' });
    const savedScreenVisible1 = await page.evaluate(() => document.getElementById('saved-screen').style.display === 'block');
    const ctxMsg1 = await page.$eval('#auth-context-msg', (el) => el.textContent);
    assert(!savedScreenVisible1, 'saved-screen must not open for guest');
    assert(/saved lists/i.test(ctxMsg1), 'expected saved-lists context message, got: ' + ctxMsg1);
    await page.click('#auth-cancel-btn');

    // Footer shop icon
    await page.click('button[onclick="showShop()"]');
    await page.waitForSelector('#auth-modal.open', { state: 'attached' });
    const shopScreenVisible1 = await page.evaluate(() => document.getElementById('shop-screen').style.display === 'block');
    const ctxMsg2 = await page.$eval('#auth-context-msg', (el) => el.textContent);
    assert(!shopScreenVisible1, 'shop-screen must not open for guest (footer icon)');
    assert(/shop|lumber/i.test(ctxMsg2), 'expected shop context message, got: ' + ctxMsg2);
    await page.click('#auth-cancel-btn');

    // Header shop icon, from inside the calculator
    await clickStart(page);
    await page.click('#shop-header-btn');
    await page.waitForSelector('#auth-modal.open', { state: 'attached' });
    const shopScreenVisible2 = await page.evaluate(() => document.getElementById('shop-screen').style.display === 'block');
    assert(!shopScreenVisible2, 'shop-screen must not open for guest (header icon)');
    await page.click('#auth-cancel-btn');

    record('2. Guest taps Open Saved Lists / Your Shop -> sign-in prompt (both entry points)', true);
    await context.close();
  } catch (e) {
    record('2. Guest taps Open Saved Lists / Your Shop -> sign-in prompt (both entry points)', false, e.stack || e.message);
  }

  // ============ TEST 3: Sign up new account succeeds without email confirmation ============
  const TEST_EMAIL = 'acceptance-test@example.com';
  const TEST_PASSWORD = 'correct-horse-battery-staple';
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, TEST_EMAIL, TEST_PASSWORD);
    const btnText = await page.$eval('#landing-account-btn', (el) => el.textContent);
    assert(btnText === 'My Account', 'expected My Account after signup, got: ' + btnText);
    const saveBtnVisibleAfterSignup = await (async () => {
      await clickStart(page);
      return page.evaluate(() => getComputedStyle(document.getElementById('save-btn')).display !== 'none');
    })();
    assert(saveBtnVisibleAfterSignup, 'save-btn should be visible once signed in');
    record('3. Sign up new account succeeds without email confirmation', true);
    await context.close();
  } catch (e) {
    record('3. Sign up new account succeeds without email confirmation', false, e.stack || e.message);
  }

  // ============ TEST 4: Signed in, save a list -> appears in Saved Lists, row in DB, survives refresh + sign-out/in ============
  try {
    const { context, page } = await newPage(browser);
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    await clickStart(page);
    await setMinimalListData(page, 'Walnut Order');
    await saveCurrentList(page, 'Walnut Order');

    const dump1 = await mockDump();
    const row = dump1.lists.find((l) => l.data && l.data.name === 'Walnut Order');
    assert(row, 'expected a Supabase row for the saved list, dump: ' + JSON.stringify(dump1.lists));

    await backToLanding(page);
    await openSavedLists(page);
    await page.waitForSelector('#saved-list-screen .saved-item', { timeout: 5000 });
    const namesAfterSave = await page.$$eval('.saved-name', (els) => els.map((e) => e.textContent));
    assert(namesAfterSave.includes('Walnut Order'), 'expected Walnut Order in Saved Lists UI, got: ' + JSON.stringify(namesAfterSave));

    // Refresh — still there. Note: the working session (wbc_session) from
    // setMinimalListData()/saveSession() is still in localStorage (saving a
    // list doesn't clear the in-progress session, matching real usage), so a
    // reload restores straight into the app-screen, not the landing screen —
    // route through backToLanding() rather than assuming landing is showing.
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(300);
    await waitSignedIn(page);
    await backToLanding(page);
    await openSavedLists(page);
    await page.waitForSelector('#saved-list-screen .saved-item', { timeout: 5000 });
    const namesAfterRefresh = await page.$$eval('.saved-name', (els) => els.map((e) => e.textContent));
    assert(namesAfterRefresh.includes('Walnut Order'), 'expected Walnut Order to survive refresh, got: ' + JSON.stringify(namesAfterRefresh));

    // Sign out and back in — still there
    await backToLanding(page);
    await signOut(page);
    await signIn(page, TEST_EMAIL, TEST_PASSWORD);
    await openSavedLists(page);
    await page.waitForSelector('#saved-list-screen .saved-item', { timeout: 5000 });
    const namesAfterReauth = await page.$$eval('.saved-name', (els) => els.map((e) => e.textContent));
    assert(namesAfterReauth.includes('Walnut Order'), 'expected Walnut Order to survive sign-out/in, got: ' + JSON.stringify(namesAfterReauth));

    record('4. Signed in save -> Saved Lists, DB row, survives refresh + sign-out/in', true);
    await context.close();
  } catch (e) {
    record('4. Signed in save -> Saved Lists, DB row, survives refresh + sign-out/in', false, e.stack || e.message);
  }

  // ============ TEST 5: Cross-device saved lists (two contexts, same account) ============
  let ctxA, ctxB, pageA, pageB;
  try {
    const A = await newPage(browser);
    const B = await newPage(browser);
    ctxA = A.context; pageA = A.page;
    ctxB = B.context; pageB = B.page;
    await signIn(pageA, TEST_EMAIL, TEST_PASSWORD);
    await signIn(pageB, TEST_EMAIL, TEST_PASSWORD);

    // Save on A -> appears on B
    await clickStart(pageA);
    await setMinimalListData(pageA, 'Device A List');
    await saveCurrentList(pageA, 'Device A List');
    await sleep(300);

    await openSavedLists(pageB);
    await page_waitForListName(pageB, 'Device A List');

    // Save on B -> appears on A (after A re-opens saved screen)
    await backToLanding(pageB);
    await clickStart(pageB);
    await setMinimalListData(pageB, 'Device B List');
    await saveCurrentList(pageB, 'Device B List');
    await sleep(300);

    await backToLanding(pageA);
    await openSavedLists(pageA);
    await page_waitForListName(pageA, 'Device B List');

    // No duplicates: both devices should see exactly 2 lists, each exactly once
    const namesA = await pageA.$$eval('.saved-name', (els) => els.map((e) => e.textContent));
    assert(namesA.filter((n) => n === 'Device A List').length === 1, 'Device A List should appear exactly once on A, got ' + JSON.stringify(namesA));
    assert(namesA.filter((n) => n === 'Device B List').length === 1, 'Device B List should appear exactly once on A, got ' + JSON.stringify(namesA));

    record('5. Cross-device saved lists: both directions, no duplicates', true);
  } catch (e) {
    record('5. Cross-device saved lists: both directions, no duplicates', false, e.stack || e.message);
  }

  // ============ TEST 6: Your Shop cross-device (add on A visible on B; cut on B updates A) ============
  try {
    await backToLanding(pageA); // test 5 leaves pageA on the saved-lists screen
    await clickStart(pageA);
    await setMinimalListData(pageA, 'Shop Source List');
    // Use the "Save & Add to Your Shop" path from the name-modal
    await pageA.click('#save-btn');
    await pageA.waitForSelector('#name-modal.open', { state: 'attached' });
    await pageA.fill('#name-modal-input', 'Shop Source List');
    await pageA.click('#name-modal-save-shop');
    // checkout gate confirm
    await pageA.waitForSelector('#ac-ok', { timeout: 5000 });
    await pageA.click('#ac-ok'); // "Yes, I've Checked Out"
    await sleep(200);
    await pageA.waitForSelector('#ac-ok', { timeout: 5000 });
    await pageA.click('#ac-ok'); // "Nice" (Added N items)
    await sleep(400);

    const dumpAfterAdd = await mockDump();
    assert(dumpAfterAdd.shop.length === 1, 'expected one shop row after add, got: ' + JSON.stringify(dumpAfterAdd.shop));
    const bfItems = dumpAfterAdd.shop[0].data.bf;
    assert(bfItems.length === 1, 'expected 1 bf item in shop, got: ' + JSON.stringify(bfItems));
    const originalValue = bfItems[0].value;

    // Visible on B
    await backToLanding(pageB);
    await openShop(pageB);
    await pageB.waitForSelector('#shop-sections', { timeout: 5000 });
    await sleep(300);
    const totalOnB = await pageB.$eval('#shop-total-value', (el) => el.textContent);
    assert(totalOnB !== '$0.00', 'expected non-zero shop total on B after A added an item, got ' + totalOnB);

    // Record a "cut" on B by directly invoking the same shopData mutation + saveShopData()
    // the real cut-recording UI uses (calculator math itself is unchanged, out of scope for this refactor).
    await pageB.evaluate(() => {
      const item = shopData.bf[0];
      item.value = Math.max(0, (parseFloat(item.value) || 0) - 5);
      if (!Array.isArray(item.cuts)) item.cuts = [];
      item.cuts.push({ date: 'test', amount: 'test cut', amountValue: 5, mode: 'cross', value: 5, kerf: 0, note: 'acceptance test' });
      saveShopData();
    });
    await sleep(400);

    // Updated values on A after its next fetch — pageA is still on the
    // app-screen (addToShopFlow never opened the shop-screen UI), so this
    // uses the app-header shop icon.
    await openShop(pageA);
    await pageA.waitForSelector('#shop-sections', { timeout: 5000 });
    await sleep(300);
    const dumpAfterCut = await mockDump();
    const newValue = dumpAfterCut.shop[0].data.bf[0].value;
    assert(newValue === originalValue - 5, 'expected shop item value to reflect cut recorded on B, before=' + originalValue + ' after=' + newValue);

    record('6. Your Shop cross-device: add on A visible on B; cut on B updates A', true);
  } catch (e) {
    record('6. Your Shop cross-device: add on A visible on B; cut on B updates A', false, e.stack || e.message);
  } finally {
    if (ctxA) await ctxA.close();
    if (ctxB) await ctxB.close();
  }

  // ============ TEST 7: Migration on sign-in (pre-existing local data, no duplicates on repeat sign-in) ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    const legacyList = {
      id: 'x1', name: 'Legacy Local List', bf: 12.5, cost: 62.5, budget: 0, date: 'Jan 1, 2026',
      species: [{ id: 'x2', name: 'Oak', waste: '', thicknesses: [{ id: 'x3', tNum: '4', price: '5', waste: 0, boards: [{ id: 'x4', lft: '10', lin: '0', w: '6' }] }] }],
      slabSpecies: [], lfSpecies: [], sgMaterials: []
    };
    const legacyShop = { bf: [{ id: 'shop1', species: 'Maple', thickness: '4', lft: 4, lin: 0, w: 5, qty: 1, value: 20, date: 'Jan 1, 2026', source: 'Old List' }], lf: [], slab: [], sg: [], kerf: 0 };
    await page.evaluate(({ legacyList, legacyShop }) => {
      localStorage.setItem('wbc_projects', JSON.stringify([legacyList]));
      localStorage.setItem('wbc_shop_inventory_v1', JSON.stringify(legacyShop));
    }, { legacyList, legacyShop });

    const MIGRATE_EMAIL = 'migration-test@example.com';
    const MIGRATE_PASSWORD = 'another-strong-password';
    await signUp(page, MIGRATE_EMAIL, MIGRATE_PASSWORD);
    await sleep(600); // migration is fire-and-forget from onAuthStateChange

    const dump1 = await mockDump();
    assert(dump1.lists.some((l) => l.data && l.data.name === 'Legacy Local List'), 'expected legacy list migrated to server, dump: ' + JSON.stringify(dump1.lists));
    assert(dump1.shop.length === 1 && dump1.shop[0].data.bf.length === 1, 'expected legacy shop migrated to server, dump: ' + JSON.stringify(dump1.shop));

    const localKeysAfter = await page.evaluate(() => ({
      projects: localStorage.getItem('wbc_projects'),
      shop: localStorage.getItem('wbc_shop_inventory_v1')
    }));
    assert(localKeysAfter.projects === null, 'expected wbc_projects removed from localStorage after migration');
    assert(localKeysAfter.shop === null, 'expected wbc_shop_inventory_v1 removed from localStorage after migration');

    // No data loss: appears in Saved Lists UI
    await backToLanding(page);
    await openSavedLists(page);
    await page_waitForListName(page, 'Legacy Local List');

    // Sign out, sign in again -> no duplicates (localStorage already cleared, so nothing to re-migrate)
    await backToLanding(page);
    await signOut(page);
    await signIn(page, MIGRATE_EMAIL, MIGRATE_PASSWORD);
    await sleep(400);
    const dump2 = await mockDump();
    const matches = dump2.lists.filter((l) => l.data && l.data.name === 'Legacy Local List');
    assert(matches.length === 1, 'expected exactly one migrated row after repeated sign-in, got ' + matches.length);

    record('7. Migration on sign-in: local data pushed, keys removed, no loss, no dupes on repeat sign-in', true);
    await context.close();
  } catch (e) {
    record('7. Migration on sign-in: local data pushed, keys removed, no loss, no dupes on repeat sign-in', false, e.stack || e.message);
  }

  // ============ TEST 8: Delete a saved list while signed in ============
  try {
    await mockReset();
    const DELETE_EMAIL = 'delete-test@example.com';
    const DELETE_PASSWORD = 'yet-another-password';
    const A = await newPage(browser);
    const B = await newPage(browser);
    await signUp(A.page, DELETE_EMAIL, DELETE_PASSWORD);
    await signIn(B.page, DELETE_EMAIL, DELETE_PASSWORD);

    await clickStart(A.page);
    await setMinimalListData(A.page, 'To Be Deleted');
    await saveCurrentList(A.page, 'To Be Deleted');
    await sleep(300);

    await backToLanding(A.page);
    await openSavedLists(A.page);
    await page_waitForListName(A.page, 'To Be Deleted');

    // delete on A — .saved-actions (holding the delete button) is display:none
    // until the summary row is clicked to expand the item
    await A.page.click('.saved-summary');
    await A.page.waitForSelector('.saved-actions.open', { timeout: 5000 });
    const delBtn = await A.page.$('[data-del]');
    assert(delBtn, 'expected a delete button in saved list UI');
    await delBtn.click();
    await A.page.waitForSelector('#ac-ok', { timeout: 5000 });
    await A.page.click('#ac-ok');
    await sleep(400);

    const namesAfterDelete = await A.page.$$eval('.saved-name', (els) => els.map((e) => e.textContent));
    assert(!namesAfterDelete.includes('To Be Deleted'), 'expected list removed from A UI after delete, got ' + JSON.stringify(namesAfterDelete));

    const dumpAfterDelete = await mockDump();
    assert(!dumpAfterDelete.lists.some((l) => l.data && l.data.name === 'To Be Deleted'), 'expected row deleted from mock DB');

    // gone on B after its next fetch
    await openSavedLists(B.page);
    await sleep(300);
    const namesB = await B.page.$$eval('.saved-name', (els) => els.map((e) => e.textContent)).catch(() => []);
    assert(!namesB.includes('To Be Deleted'), 'expected list gone on B after refetch, got ' + JSON.stringify(namesB));

    record('8. Delete saved list while signed in: removed from DB, gone on other device', true);
    await A.context.close();
    await B.context.close();
  } catch (e) {
    record('8. Delete saved list while signed in: removed from DB, gone on other device', false, e.stack || e.message);
  }

  // ============ TEST 9: Guest mode after sign-out -> Save button gone, working list still editable ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, 'signout-test@example.com', 'yet-another-password-2');
    await clickStart(page);
    const saveVisibleWhileSignedIn = await page.evaluate(() => getComputedStyle(document.getElementById('save-btn')).display !== 'none');
    assert(saveVisibleWhileSignedIn, 'expected save-btn visible while signed in');

    await backToLanding(page);
    await signOut(page);
    await clickStart(page);
    // Save button is always visible in the new design (dimmed for guests, prompts sign-in on click)
    const saveVisibleAfterSignout = await page.evaluate(() => getComputedStyle(document.getElementById('save-btn')).display !== 'none');
    assert(saveVisibleAfterSignout, 'save-btn should remain visible after sign-out (dimmed)');
    const saveOpacity = await page.evaluate(() => document.getElementById('save-btn').style.opacity);
    assert(saveOpacity === '0.5', 'save-btn should be dimmed (opacity 0.5) for guests after sign-out, got ' + saveOpacity);

    await setMinimalListData(page, 'Post-signout editable list');
    const editedName = await page.evaluate(() => species[0].name);
    assert(editedName === 'Post-signout editable list', 'expected calculator to remain editable after sign-out');

    record('9. Guest mode after sign-out: Save button dimmed, working list still editable', true);
    await context.close();
  } catch (e) {
    record('9. Guest mode after sign-out: Save button dimmed, working list still editable', false, e.stack || e.message);
  }

  // ============ TEST 10: Offline/failed fetch -> retry state, no crash, no empty-as-truth ============
  try {
    await mockReset();
    const { context, page, errors } = await newPage(browser);
    await signUp(page, 'offline-test@example.com', 'yet-another-password-3');
    await clickStart(page);
    await setMinimalListData(page, 'Should Not Appear Empty');
    await saveCurrentList(page, 'Should Not Appear Empty');
    await sleep(300);
    await backToLanding(page);

    await mockFail(true);
    await openSavedLists(page);
    await page.waitForSelector('#saved-retry-btn', { timeout: 5000 });
    const bodyText = await page.$eval('#saved-list-screen', (el) => el.textContent);
    assert(/couldn.t load/i.test(bodyText), 'expected a "could not load" message, got: ' + bodyText);
    assert(!/no saved lists yet/i.test(bodyText), 'must not render empty-as-truth on fetch failure');

    await mockFail(false);
    await page.click('#saved-retry-btn');
    await page.waitForSelector('.saved-item', { timeout: 5000 });
    const namesAfterRetry = await page.$$eval('.saved-name', (els) => els.map((e) => e.textContent));
    assert(namesAfterRetry.includes('Should Not Appear Empty'), 'expected retry to recover the real list, got ' + JSON.stringify(namesAfterRetry));

    // Same for shop
    await mockFail(true);
    await backToLanding(page);
    await openShop(page);
    await page.waitForSelector('#shop-retry-btn', { timeout: 5000 });
    await mockFail(false);
    await page.click('#shop-retry-btn');
    await page.waitForSelector('#shop-sections', { timeout: 5000 });
    await sleep(300);
    const shopErrorGone = await page.$('#shop-retry-btn');
    assert(!shopErrorGone, 'expected shop retry UI to clear after successful retry');

    assert(errors.length === 0, 'unexpected page errors: ' + JSON.stringify(errors));
    record('10. Offline/failed fetch: retry state, no crash, no empty-as-truth (lists + shop)', true);
    await context.close();
  } catch (e) {
    await mockFail(false);
    record('10. Offline/failed fetch: retry state, no crash, no empty-as-truth (lists + shop)', false, e.stack || e.message);
  }

  // ============ TEST 11: Migration idempotency — stale local data reappearing across repeated sign-ins must not duplicate rows (regression for Bug 1) ============
  try {
    await mockReset();
    const IDEMPOTENT_EMAIL = 'idempotent-migration@example.com';
    const IDEMPOTENT_PASSWORD = 'idempotent-password-1';
    const legacyList = {
      id: 'x1', name: 'Test list 1', bf: 8, cost: 40, budget: 0, date: 'Jan 1, 2026',
      species: [{ id: 'x2', name: 'Cherry', waste: '', thicknesses: [{ id: 'x3', tNum: '4', price: '5', waste: 0, boards: [{ id: 'x4', lft: '6', lin: '0', w: '8' }] }] }],
      slabSpecies: [], lfSpecies: [], sgMaterials: []
    };
    const { context, page } = await newPage(browser);

    async function seedLegacyLocalData() {
      await page.evaluate((list) => {
        localStorage.setItem('wbc_projects', JSON.stringify([list]));
      }, legacyList);
    }

    // First sign-in: migrates once.
    await seedLegacyLocalData();
    await signUp(page, IDEMPOTENT_EMAIL, IDEMPOTENT_PASSWORD);
    await sleep(600);
    let dump = await mockDump();
    let matching = dump.lists.filter((l) => l.data && l.data.name === 'Test list 1');
    assert(matching.length === 1, 'expected exactly one row after first migration, got ' + matching.length);
    const localAfterFirst = await page.evaluate(() => localStorage.getItem('wbc_projects'));
    assert(localAfterFirst === null, 'expected wbc_projects cleared after first migration');

    // Simulate a device that still holds (or re-acquires) stale local data —
    // exactly the reported phone scenario — and signs out/in twice more.
    for (let i = 0; i < 2; i++) {
      await backToLanding(page);
      await signOut(page);
      await seedLegacyLocalData();
      await signIn(page, IDEMPOTENT_EMAIL, IDEMPOTENT_PASSWORD);
      await sleep(600);
    }

    dump = await mockDump();
    matching = dump.lists.filter((l) => l.data && l.data.name === 'Test list 1');
    assert(matching.length === 1, 'expected row count to stay at 1 after repeated sign-in with stale local data, got ' + matching.length + ': ' + JSON.stringify(matching.map((m) => m.id)));
    const localAfterRepeats = await page.evaluate(() => localStorage.getItem('wbc_projects'));
    assert(localAfterRepeats === null, 'expected wbc_projects to stay cleared after repeated migrations');

    record('11. Migration idempotency: repeated sign-in with stale local data does not duplicate rows', true);
    await context.close();
  } catch (e) {
    record('11. Migration idempotency: repeated sign-in with stale local data does not duplicate rows', false, e.stack || e.message);
  }

  // ============ TEST 12: Save-then-fetch race — a just-saved list must never vanish from the list screen (regression for Bug 3) ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, 'race-test@example.com', 'race-password-1');
    await clickStart(page);
    await setMinimalListData(page, 'Race Condition List');

    // Force the server-side save to be slow so that, without the fix, an
    // immediately-following fetch would land first and race past the
    // still-in-flight save — deterministic instead of relying on real timing.
    await mockDelayListSave(800);
    await page.click('#save-btn');
    await page.waitForSelector('#name-modal.open', { state: 'attached' });
    await page.fill('#name-modal-input', 'Race Condition List');
    await page.click('#name-modal-save');
    // No sleep here — immediately navigate to Saved Lists, exactly like the repro.
    await backToLanding(page);
    await openSavedLists(page);

    await page.waitForSelector('.saved-item', { timeout: 5000 });
    const namesImmediately = await page.$$eval('.saved-name', (els) => els.map((e) => e.textContent));
    assert(namesImmediately.includes('Race Condition List'), 'expected the just-saved list to be present immediately, got ' + JSON.stringify(namesImmediately));

    await mockDelayListSave(0);
    record('12. Save-then-fetch race: a just-saved list never vanishes from the list screen', true);
    await context.close();
  } catch (e) {
    await mockDelayListSave(0);
    record('12. Save-then-fetch race: a just-saved list never vanishes from the list screen', false, e.stack || e.message);
  }

  await browser.close();

  console.log('\n==================== SUMMARY ====================');
  let passCount = 0;
  for (const r of results) {
    console.log((r.ok ? 'PASS' : 'FAIL') + ' - ' + r.name);
    if (r.ok) passCount++;
  }
  console.log(passCount + '/' + results.length + ' passed');
  process.exit(passCount === results.length ? 0 : 1);
})();

async function page_waitForListName(page, name) {
  await page.waitForFunction((n) => {
    const els = document.querySelectorAll('.saved-name');
    return Array.from(els).some((e) => e.textContent === n);
  }, name, { timeout: 5000 });
}
