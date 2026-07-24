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
async function mockFailDeleteStep(step) {
  const r = await fetch(MOCK + '/_test/fail-delete-account-step', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step }) });
  return r.json();
}
async function mockSeedProfile(userId) {
  const r = await fetch(MOCK + '/_test/seed-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) });
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

async function waitSignedIn(page) {
  await page.waitForFunction(() => document.getElementById('landing-account-btn').textContent === 'My Account', null, { timeout: 5000 });
}
async function waitSignedOut(page) {
  await page.waitForFunction(() => document.getElementById('landing-account-btn').textContent !== 'My Account', null, { timeout: 5000 });
}

async function openAuthFromLanding(page) {
  await page.click('#landing-account-btn');
  await page.waitForSelector('#auth-modal.open', { state: 'attached' });
}

async function signUp(page, email, password) {
  await openAuthFromLanding(page);
  const modeText = await page.$eval('#auth-modal-title', (el) => el.textContent);
  if (modeText.trim() !== 'Create Account') await page.click('#auth-toggle-btn');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await page.waitForFunction(() => !document.getElementById('auth-modal').classList.contains('open'), null, { timeout: 5000 });
  await waitSignedIn(page);
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
  await sleep(400);
}

async function getCurrentUserId(page) {
  return page.evaluate(async () => {
    const { data } = await window._supabase.auth.getSession();
    return data.session ? data.session.user.id : null;
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH });

  // ============ TEST D1: Delete Account visible signed-in, not visible for guests ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);

    await openAuthFromLanding(page);
    const guestBodyVisible = await page.evaluate(() => getComputedStyle(document.getElementById('auth-signed-in-body')).display !== 'none');
    assert(!guestBodyVisible, 'signed-in body (and its Delete Account button) must not show for guests');
    await page.click('#auth-cancel-btn');

    await signUp(page, 'delete-visibility@example.com', 'delete-password-1');
    await openAuthFromLanding(page); // reopen now that we're signed in — shows the signed-in view
    const deleteBtnVisible = await page.evaluate(() => {
      const el = document.getElementById('auth-delete-account-btn');
      return !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(document.getElementById('auth-signed-in-body')).display !== 'none';
    });
    assert(deleteBtnVisible, 'expected Delete Account button visible once signed in');

    record('D1: Delete Account visible signed-in, hidden for guests', true);
    await context.close();
  } catch (e) {
    record('D1: Delete Account visible signed-in, hidden for guests', false, e.stack || e.message);
  }

  // ============ TEST D2: Tap Delete Account -> confirmation dialog, states permanence, requires password ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, 'delete-dialog@example.com', 'delete-password-1');
    await openAuthFromLanding(page);
    await page.click('#auth-delete-account-btn');
    await page.waitForSelector('#delete-account-modal.open', { state: 'attached' });

    const dialogText = await page.$eval('#delete-account-modal', (el) => el.textContent);
    assert(/permanent/i.test(dialogText), 'expected the dialog to state permanence, got: ' + dialogText);
    assert(/saved lists/i.test(dialogText) && /lumber|shop|hours|project/i.test(dialogText), 'expected the dialog to mention lists and lumber/shop/hours/projects, got: ' + dialogText);

    // Requires a password: submitting empty shows an inline error, no function call.
    await page.click('#delete-account-confirm-btn');
    await page.waitForSelector('#delete-account-error', { state: 'visible' });
    const emptyErr = await page.$eval('#delete-account-error', (el) => el.textContent);
    assert(/password/i.test(emptyErr), 'expected an empty-password error, got: ' + emptyErr);
    const stillOpen = await page.evaluate(() => document.getElementById('delete-account-modal').classList.contains('open'));
    assert(stillOpen, 'dialog should stay open when password is empty');

    record('D2: Delete Account opens a confirmation dialog stating permanence and requiring a password', true);
    await context.close();
  } catch (e) {
    record('D2: Delete Account opens a confirmation dialog stating permanence and requiring a password', false, e.stack || e.message);
  }

  // ============ TEST D3: Wrong password -> "Incorrect password", no deletion, still signed in ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    await signUp(page, 'delete-wrongpw@example.com', 'the-real-password');
    await openAuthFromLanding(page);
    await page.click('#auth-delete-account-btn');
    await page.waitForSelector('#delete-account-modal.open', { state: 'attached' });

    await page.fill('#delete-account-password', 'totally-wrong-password');
    await page.click('#delete-account-confirm-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('delete-account-error');
      return el && el.style.display !== 'none' && /incorrect password/i.test(el.textContent);
    }, null, { timeout: 5000 });

    // still signed in, dialog stays open for retry, nothing deleted server-side
    const isSignedIn = await page.evaluate(() => getComputedStyle(document.getElementById('auth-signed-in-body')).display !== 'none');
    assert(isSignedIn, 'expected to still be signed in after a wrong password attempt');
    const stillOpenForRetry = await page.evaluate(() => document.getElementById('delete-account-modal').classList.contains('open') && !document.getElementById('delete-account-confirm-btn').disabled);
    assert(stillOpenForRetry, 'expected the delete dialog to remain open, with the button re-enabled, for retry');
    const dump = await mockDump();
    assert(dump.users.some((u) => u.email === 'delete-wrongpw@example.com'), 'expected the user to still exist server-side after a wrong password attempt');

    record('D3: Wrong password shows "Incorrect password", no deletion, still signed in', true);
    await context.close();
  } catch (e) {
    record('D3: Wrong password shows "Incorrect password", no deletion, still signed in', false, e.stack || e.message);
  }

  // ============ TEST D4: Correct password -> full deletion (lists, shop, profile, auth user), sign-out, confirmation, guest landing ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    const EMAIL = 'delete-full@example.com';
    const PASSWORD = 'correct-password-here';
    await signUp(page, EMAIL, PASSWORD);
    const userId = await getCurrentUserId(page);
    await mockSeedProfile(userId);

    // Give the account some real data: a saved list AND a shop item (via
    // "Save & Add to Your Shop", so both a lists row and a shop row exist).
    await clickStart(page);
    await setMinimalListData(page, 'List To Be Deleted');
    await page.click('#save-btn');
    await page.waitForSelector('#name-modal.open', { state: 'attached' });
    await page.fill('#name-modal-input', 'List To Be Deleted');
    await page.click('#name-modal-save-shop');
    await page.waitForSelector('#ac-ok', { timeout: 5000 });
    await page.click('#ac-ok'); // "Yes, I've Checked Out"
    await sleep(200);
    await page.waitForSelector('#ac-ok', { timeout: 5000 });
    await page.click('#ac-ok'); // "Nice" (Added N items)
    await sleep(400);

    const dumpBefore = await mockDump();
    assert(dumpBefore.lists.some((l) => l.user_id === userId), 'expected a list row to exist before deletion');
    assert(dumpBefore.shop.some((s) => s.user_id === userId), 'expected a shop row to exist before deletion');

    await backToLanding(page);
    await openAuthFromLanding(page);
    await page.click('#auth-delete-account-btn');
    await page.waitForSelector('#delete-account-modal.open', { state: 'attached' });
    await page.fill('#delete-account-password', PASSWORD);
    await page.click('#delete-account-confirm-btn');

    // "Account deleted" confirmation
    await page.waitForFunction(() => {
      const overlays = document.querySelectorAll('body > div');
      return Array.from(overlays).some((d) => /account has been deleted/i.test(d.textContent || ''));
    }, null, { timeout: 8000 });

    // Landing page, guest state
    const landingVisible = await page.evaluate(() => getComputedStyle(document.getElementById('landing-screen')).display !== 'none');
    assert(landingVisible, 'expected to land on the landing page after account deletion');
    const saveBtnDimmed = await page.evaluate(() => document.getElementById('save-btn').style.opacity === '0.5');
    assert(saveBtnDimmed, 'expected guest state (save-btn dimmed) after account deletion');
    const projectsEmpty = await page.evaluate(() => Array.isArray(projects) && projects.length === 0);
    assert(projectsEmpty, 'expected in-memory projects to be cleared after account deletion');

    // Server truth: everything gone
    const dumpAfter = await mockDump();
    assert(!dumpAfter.lists.some((l) => l.user_id === userId), 'expected list rows deleted server-side');
    assert(!dumpAfter.shop.some((s) => s.user_id === userId), 'expected shop row deleted server-side');
    assert(!dumpAfter.profiles.some((p) => p.id === userId), 'expected profile row deleted server-side');
    assert(!dumpAfter.users.some((u) => u.email === EMAIL), 'expected the auth user itself deleted server-side');

    record('D4: Correct password deletes everything, signs out, shows confirmation, lands on guest landing', true);
    await context.close();
  } catch (e) {
    record('D4: Correct password deletes everything, signs out, shows confirmation, lands on guest landing', false, e.stack || e.message);
  }

  // ============ TEST D5: Partial failure -> error shown, not falsely told success, can retry ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    const EMAIL = 'delete-partial-fail@example.com';
    const PASSWORD = 'partial-fail-password';
    await signUp(page, EMAIL, PASSWORD);

    await mockFailDeleteStep('shop'); // lists succeeds, shop fails -> function must report failure overall

    await openAuthFromLanding(page);
    await page.click('#auth-delete-account-btn');
    await page.waitForSelector('#delete-account-modal.open', { state: 'attached' });
    await page.fill('#delete-account-password', PASSWORD);
    await page.click('#delete-account-confirm-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('delete-account-error');
      return el && el.style.display !== 'none' && el.textContent.trim().length > 0;
    }, null, { timeout: 8000 });
    const errText = await page.$eval('#delete-account-error', (el) => el.textContent);
    assert(!/incorrect password/i.test(errText), 'this failure is server-side, not a bad password: ' + errText);

    // User must NOT be falsely told success — still signed in, modal still open for retry.
    const stillOpen = await page.evaluate(() => document.getElementById('delete-account-modal').classList.contains('open'));
    assert(stillOpen, 'dialog should remain open so the user can retry');
    const dump = await mockDump();
    assert(dump.users.some((u) => u.email === EMAIL), 'user must still exist after a partial failure (not falsely deleted)');

    // Retry after clearing the injected failure: should now succeed.
    await mockFailDeleteStep(null);
    const retryBtnEnabled = await page.evaluate(() => !document.getElementById('delete-account-confirm-btn').disabled);
    assert(retryBtnEnabled, 'expected the confirm button to be re-enabled for retry');
    await page.click('#delete-account-confirm-btn');
    await page.waitForFunction(() => {
      const overlays = document.querySelectorAll('body > div');
      return Array.from(overlays).some((d) => /account has been deleted/i.test(d.textContent || ''));
    }, null, { timeout: 8000 });
    const dumpAfterRetry = await mockDump();
    assert(!dumpAfterRetry.users.some((u) => u.email === EMAIL), 'expected the retry to succeed and delete the user');

    record('D5: Partial failure shows an error, does not falsely report success, retry succeeds', true);
    await context.close();
  } catch (e) {
    await mockFailDeleteStep(null);
    record('D5: Partial failure shows an error, does not falsely report success, retry succeeds', false, e.stack || e.message);
  }

  // ============ TEST D6: After deletion, no stale account data renders (fresh sign-up sees a clean slate) ============
  try {
    await mockReset();
    const { context, page } = await newPage(browser);
    const EMAIL = 'delete-then-fresh@example.com';
    const PASSWORD = 'delete-then-fresh-pw';
    await signUp(page, EMAIL, PASSWORD);
    await clickStart(page);
    await setMinimalListData(page, 'Soon Deleted List');
    await saveCurrentList(page, 'Soon Deleted List');
    await sleep(300);
    await backToLanding(page);

    await openAuthFromLanding(page);
    await page.click('#auth-delete-account-btn');
    await page.waitForSelector('#delete-account-modal.open', { state: 'attached' });
    await page.fill('#delete-account-password', PASSWORD);
    await page.click('#delete-account-confirm-btn');
    await page.waitForFunction(() => {
      const overlays = document.querySelectorAll('body > div');
      return Array.from(overlays).some((d) => /account has been deleted/i.test(d.textContent || ''));
    }, null, { timeout: 8000 });
    await page.click('#ac-ok').catch(() => {});

    // Sign back up fresh with the SAME email (now available again) and confirm a clean slate.
    await signUp(page, EMAIL, PASSWORD + '-new');
    await backToLanding(page);
    // A brand-new account has zero lists, so showSaved() shows the "nothing
    // saved" prompt rather than the saved-screen — call fetchSavedLists()
    // directly to check server truth for this account instead of depending
    // on that branch of the UI.
    await page.evaluate(() => fetchSavedLists());
    const namesVisible = await page.$$eval('.saved-name', (els) => els.map((e) => e.textContent)).catch(() => []);
    assert(!namesVisible.includes('Soon Deleted List'), 'expected no stale data from the deleted account rendered anywhere, got: ' + JSON.stringify(namesVisible));
    const projectsEmpty = await page.evaluate(() => Array.isArray(projects) && projects.length === 0);
    assert(projectsEmpty, 'expected in-memory projects to be empty for the fresh account, not carried over from the deleted one');

    record('D6: No stale account data renders after deletion (fresh account sees a clean slate)', true);
    await context.close();
  } catch (e) {
    record('D6: No stale account data renders after deletion (fresh account sees a clean slate)', false, e.stack || e.message);
  }

  await browser.close();

  console.log('\n==================== DELETION SUMMARY ====================');
  let passCount = 0;
  for (const r of results) {
    console.log((r.ok ? 'PASS' : 'FAIL') + ' - ' + r.name);
    if (r.ok) passCount++;
  }
  console.log(passCount + '/' + results.length + ' passed');
  process.exit(passCount === results.length ? 0 : 1);
})();
