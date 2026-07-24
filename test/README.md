# Test suite

Headless Playwright acceptance/regression suites for the app (`../index.html`).
Each suite is a standalone Node script that:

1. spawns the mock Supabase server (`mock-supabase.js`) on port **8901**,
2. serves the app on port **8900** from a small static server, reading
   `../index.html` and rewriting three external URLs to local stand-ins
   (Supabase API → `127.0.0.1:8901`, `supabase-js` CDN → `supabase.umd.js`,
   `jspdf` CDN → `jspdf.umd.min.js`),
3. drives Chromium and prints `PASS`/`FAIL` lines plus a `RESULTS` summary.

## Prerequisites

- Node.js
- `npm install` in this directory (installs `playwright`, `@supabase/supabase-js`, `jspdf`)
- A Chromium binary. The scripts point `executablePath` at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (the path in the
  Claude Code web environment). If your Chromium lives elsewhere, update the
  `BROWSER_PATH` / `CHROME` constant at the top of the script, or run
  `npx playwright install chromium` and point at that.

## Running

```sh
cd test
npm install
node settings-ux-test.js      # Settings/Quote Defaults UX (18)
node hours-tool-test.js        # standalone Hours tool (23)
node live-clock-test.js        # live clock + global banner (31)
node project-details-test.js   # Quotes "Project Details" notes (13)
node project-notes-test.js     # Your Projects "Project Details" notes (12)
node product-type-test.js      # Quotes pricing engine incl. Glue Ups dropdown
node projects-test.js          # Your Projects regression
```

Other suites (`acceptance.js`, `quotes-test.js`, `surface-area-test.js`,
`ui-polish-test.js`, `global-header-test.js`, `settings-panel-test.js`,
`quote-form-redesign-test.js`, `quote-polish-test.js`, `complex-pattern-test.js`,
`glue-dropdown-test.js`, `icon-chevron-test.js`, `seamless-test.js`,
`deletion-test.js`, `hours-test.js`, `sw-test.js`) cover earlier feature work and
run the same way.

## Notes

- Ports 8900/8901 must be free.
- `supabase.umd.js` and `jspdf.umd.min.js` are vendored so the suites run
  without reaching a CDN.
- Screenshots and Playwright output land in `screenshots/` and `test-results/`
  (git-ignored).
- `mock-supabase.js` keeps state in memory and exposes `/_test/reset` and
  `/_test/dump`; each suite resets it between cases.
