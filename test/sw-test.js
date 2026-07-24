const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = 'http://localhost:8902';
const CROSS_ORIGIN = 'http://localhost:8901'; // mock-supabase server, different port = different origin
const CHROME_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '\n       ' + detail : ''));
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function setVariant(v) {
  const r = await fetch(BASE + '/_test/set-variant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variant: v }) });
  return r.json();
}

async function waitForActiveSW(page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(resolve, 3000); // fallback in case controllerchange already fired before we listened
      });
    }
    return !!reg;
  });
}

async function cacheSummary(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) {
      const cache = await caches.open(n);
      const reqs = await cache.keys();
      out[n] = reqs.map(r => r.url);
    }
    return out;
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH });

  // ============ TEST SW-1: cross-origin (Supabase) responses are never cached ============
  try {
    await setVariant('A');
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await waitForActiveSW(page);
    // A couple of navigations so the shell + static caches are populated first.
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(300);

    await page.evaluate(async (crossOrigin) => {
      await fetch(crossOrigin + '/_test/dump');
    }, CROSS_ORIGIN);
    await sleep(300);

    const summary = await cacheSummary(page);
    const allUrls = Object.values(summary).flat();
    const supabaseCached = allUrls.filter(u => u.includes('localhost:8901') || u.includes('/rest/') || u.includes('/_test/'));
    assert(supabaseCached.length === 0, 'expected zero cross-origin/API URLs cached, found: ' + JSON.stringify(supabaseCached));

    record('SW-1: cross-origin (Supabase) responses are never cached', true);
    await context.close();
  } catch (e) {
    record('SW-1: cross-origin (Supabase) responses are never cached', false, e.stack || e.message);
  }

  // ============ TEST SW-2 & SW-3: new deploy busts the shell cache and serves fresh content; old cache evicted ============
  let ctx23, page23;
  try {
    await setVariant('A');
    ctx23 = await browser.newContext({ serviceWorkers: 'allow' });
    page23 = await ctx23.newPage();
    await page23.goto(BASE + '/', { waitUntil: 'networkidle' });
    await waitForActiveSW(page23);
    await page23.reload({ waitUntil: 'networkidle' }); // ensure this navigation goes through the SW's fetch handler
    await sleep(300);

    const markerA = await page23.$eval('#marker', el => el.textContent);
    assert(markerA === 'SW_TEST_VARIANT_A', 'expected variant A on first load, got ' + markerA);

    const summaryBeforeDeploy = await cacheSummary(page23);
    const shellCachesBefore = Object.keys(summaryBeforeDeploy).filter(k => k.startsWith('wildboard-shell-'));
    assert(shellCachesBefore.length === 1, 'expected exactly one shell cache after first load, got ' + JSON.stringify(shellCachesBefore));
    const oldShellCacheName = shellCachesBefore[0];

    // Simulate a new deploy: content changes, service worker script bytes do not.
    await setVariant('B');
    await page23.reload({ waitUntil: 'networkidle' });
    await sleep(300);

    const markerB = await page23.$eval('#marker', el => el.textContent);
    assert(markerB === 'SW_TEST_VARIANT_B', 'expected fresh variant B content after "deploy", got ' + markerB);
    record('SW-2: a new deploy (content change, same SW script) is served fresh via network-first', true);

    const summaryAfterDeploy = await cacheSummary(page23);
    const shellCachesAfter = Object.keys(summaryAfterDeploy).filter(k => k.startsWith('wildboard-shell-'));
    assert(shellCachesAfter.length === 1, 'expected exactly one shell cache after the new deploy, got ' + JSON.stringify(shellCachesAfter));
    assert(shellCachesAfter[0] !== oldShellCacheName, 'expected a new shell cache name for the new content, got the same: ' + oldShellCacheName);
    assert(!(oldShellCacheName in summaryAfterDeploy), 'expected the old shell cache to be evicted, but it is still present: ' + oldShellCacheName);
    record('SW-3: the old shell cache is evicted once a new one is cached (no unbounded cache growth)', true);
  } catch (e) {
    record('SW-2/SW-3: deploy cache-busting', false, e.stack || e.message);
  }

  // ============ TEST SW-4: offline serves the last successfully cached shell instead of failing ============
  try {
    await ctx23.setOffline(true);
    await page23.reload({ waitUntil: 'load' }).catch(() => {});
    await sleep(500);
    const markerOffline = await page23.$eval('#marker', el => el.textContent).catch(() => null);
    assert(markerOffline === 'SW_TEST_VARIANT_B', 'expected the last cached (variant B) shell to be served offline, got ' + markerOffline);
    record('SW-4: offline reload serves the last successfully cached shell instead of failing', true);
    await ctx23.setOffline(false);
    await ctx23.close();
  } catch (e) {
    try { await ctx23.setOffline(false); } catch (e2) {}
    record('SW-4: offline reload serves the last successfully cached shell instead of failing', false, e.stack || e.message);
  }

  // ============ TEST SW-5: static assets get cached under the static cache ============
  try {
    await setVariant('A');
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await waitForActiveSW(page);
    await sleep(500); // let install's precache Promise.allSettled finish

    const summary = await cacheSummary(page);
    const staticCacheKey = Object.keys(summary).find(k => k.startsWith('wildboard-static-v'));
    assert(staticCacheKey, 'expected a wildboard-static-v* cache to exist, got: ' + JSON.stringify(Object.keys(summary)));
    const staticUrls = summary[staticCacheKey];
    assert(staticUrls.some(u => u.endsWith('/favicon.png')), 'expected favicon.png to be precached, got: ' + JSON.stringify(staticUrls));

    record('SW-5: static assets are precached under the static cache', true);
    await context.close();
  } catch (e) {
    record('SW-5: static assets are precached under the static cache', false, e.stack || e.message);
  }

  await browser.close();

  console.log('\n==================== SW SUMMARY ====================');
  let passCount = 0;
  for (const r of results) {
    console.log((r.ok ? 'PASS' : 'FAIL') + ' - ' + r.name);
    if (r.ok) passCount++;
  }
  console.log(passCount + '/' + results.length + ' passed');
  process.exit(passCount === results.length ? 0 : 1);
})();
