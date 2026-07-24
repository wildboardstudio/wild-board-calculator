// Minimal static server for service-worker acceptance testing. Serves a
// swappable index.html (variant A/B, to simulate "a new deploy changed the
// app shell"), the real sw.js, the vendored supabase/jspdf bundles, and
// dummy static assets so the SW's install-time precache has something real
// to fetch.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] ? parseInt(process.argv[2], 10) : 8902;
const TESTDIR = __dirname;

let variant = 'A';

function htmlFor(v) {
  const marker = v === 'A' ? 'SW_TEST_VARIANT_A' : 'SW_TEST_VARIANT_B';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>SW Test</title>
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/favicon.png">
</head>
<body>
<h1 id="marker">${marker}</h1>
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
</script>
</body></html>`;
}

const DUMMY_ASSETS = ['/favicon.png', '/apple-touch-icon.png', '/manifest.json', '/logo-header.png', '/logo-pdf.png', '/logo-landing.png', '/wbc-beta.png', '/splinter.jpg'];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/_test/set-variant' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        variant = JSON.parse(body).variant === 'B' ? 'B' : 'A';
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, variant }));
    });
    return;
  }

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(htmlFor(variant));
    return;
  }

  if (p === '/sw.js') {
    const content = fs.readFileSync(require('path').join(__dirname, '..', 'sw.js'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(content);
    return;
  }

  if (DUMMY_ASSETS.includes(p)) {
    res.writeHead(200, { 'Content-Type': p.endsWith('.json') ? 'application/json' : 'image/png' });
    res.end(p.endsWith('.json') ? '{}' : 'dummy-asset-bytes-' + p);
    return;
  }

  res.writeHead(404);
  res.end('not found: ' + p);
});

server.listen(PORT, () => {
  console.log('sw-test-server listening on ' + PORT);
});
