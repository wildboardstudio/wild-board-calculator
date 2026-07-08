// Service worker for Wild Board Calculator.
//
// Cache-busting strategy (why this file changed):
//  - The app shell (index.html / navigation requests) is always
//    network-first, with the HTTP cache explicitly bypassed too
//    (`cache: 'no-store'`) — a fresh network response is what gets served,
//    full stop. It is ALSO cached, keyed by a hash of its own fetched
//    content, purely so an offline user gets the last successfully-fetched
//    version instead of nothing. Because the cache name is derived from the
//    content itself, every deploy that changes index.html — which is
//    effectively every deploy, since this is a single-file app — gets a new
//    cache entry automatically. There is no version string to remember to
//    bump by hand.
//  - Static assets (icons, manifest) rarely change and are cache-first
//    under a small, separately-versioned cache. Bump STATIC_CACHE_VERSION
//    below on the rare occasion one of these files is replaced with
//    different content under the same filename.
//  - Cross-origin requests (Supabase, CDNs, analytics) and same-origin
//    /api/ or /rest/ paths are NEVER cached — always network, always live
//    data. Caching a Supabase response here was the root cause of devices
//    showing saved lists/shop data the server no longer had.
//  - activate wipes every cache except the current static one on every
//    activation, so any prior scheme's leftovers (including caches from
//    before this fix existed) get cleared out the first time this version
//    actually takes over a client.
//
// IMPORTANT — this file only helps if browsers actually notice it changed.
// Service workers are byte-diffed against the previously fetched sw.js, and
// browsers will happily serve a long-cached copy of THIS file and never
// notice an update if it's cached the normal way. See vercel.json in this
// repo, which forces Cache-Control: no-cache on /sw.js specifically so
// every deploy is actually picked up. If you deploy this project somewhere
// other than Vercel, replicate that header rule for /sw.js on whatever's
// serving it, or updates to this file (and therefore this whole
// cache-busting mechanism) can silently stop reaching users.

const SHELL_CACHE_PREFIX = 'wildboard-shell-';
const STATIC_CACHE_VERSION = 1;
const STATIC_CACHE_NAME = 'wildboard-static-v' + STATIC_CACHE_VERSION;

const STATIC_ASSETS = [
  '/favicon.png',
  '/apple-touch-icon.png',
  '/manifest.json',
  '/logo-header.png',
  '/logo-pdf.png',
  '/logo-landing.png',
  '/wbc-beta.png',
  '/splinter.jpg'
];

// djb2 — fast, tiny, good enough for cache-busting. Not cryptographic, and
// doesn't need to be.
function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

async function deleteAllCachesExcept(keepNames) {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter(k => !keepNames.includes(k)).map(k => caches.delete(k))
  );
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE_NAME);
    // Fetch+cache each asset individually — cache.addAll() fails the whole
    // install if a single URL 404s, which would mean this service worker
    // (and every fix that ships in it) never activates at all.
    await Promise.allSettled(
      STATIC_ASSETS.map(async url => {
        try {
          const resp = await fetch(url, { cache: 'no-store' });
          if (resp.ok) await cache.put(url, resp);
        } catch (e) { /* one missing/unreachable asset must not sink the install */ }
      })
    );
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await deleteAllCachesExcept([STATIC_CACHE_NAME]);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Cross-origin requests (Supabase, CDNs, analytics) — always network,
  // never cache. Don't intercept at all; let the browser handle it as if
  // this service worker didn't exist.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Same-origin API-style paths — always network, never cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // App shell — network-first, HTTP cache bypassed. Content-hashed cache
  // name means every content change is automatically a new cache entry;
  // the cache is only ever read from when the network fetch fails.
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        const text = await response.clone().text();
        const cacheName = SHELL_CACHE_PREFIX + hashText(text);
        const cache = await caches.open(cacheName);
        await cache.put(event.request, response.clone());
        await deleteAllCachesExcept([cacheName, STATIC_CACHE_NAME]);
        return response;
      } catch (e) {
        const keys = await caches.keys();
        for (const k of keys.filter(k => k.startsWith(SHELL_CACHE_PREFIX))) {
          const cached = await (await caches.open(k)).match(event.request);
          if (cached) return cached;
        }
        throw e;
      }
    })());
    return;
  }

  // Same-origin static assets — cache first, network fallback.
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (event.request.method === 'GET' && response.status === 200) {
      cache.put(event.request, response.clone());
    }
    return response;
  })());
});
