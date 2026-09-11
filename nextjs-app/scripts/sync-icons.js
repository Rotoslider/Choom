/**
 * Copies Choom's canonical icon set from docs/ into app/.
 *
 *   node scripts/sync-icons.js      (or: pnpm icons:sync)
 *
 * docs/ is the GitHub Pages site, and its "C" mark is the canonical one — it is
 * what OpenRouter renders next to Choom in its Activity dashboard, because the
 * HTTP-Referer we send points at that site (see lib/utils.ts). Keeping app/ in
 * step with it means the browser tab, the bookmark and the OpenRouter listing
 * are all the same artwork.
 *
 * Why static files and not the old dynamic app/icon.tsx metadata route:
 *
 *   - That route left /favicon.ico returning a 404, and /favicon.ico is the URL
 *     Firefox falls back to for tab and BOOKMARK icons. Chrome was happy with
 *     the <link rel="icon"> alone; Firefox bookmarks came out blank.
 *   - The dev server sends generated metadata routes with `cache-control:
 *     no-cache, no-store`. Static files get `no-cache, must-revalidate`, which
 *     Firefox will actually keep in its places DB.
 *   - There was no apple-touch-icon at all, so "add to home screen" on iOS got
 *     a screenshot of the page instead of the mark.
 *
 * Next's file conventions pick these up by name: favicon.ico, icon.png and
 * apple-icon.png in app/ become <link rel="icon"> / <link rel="apple-touch-icon">
 * automatically. Do not rename them.
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', 'app');
const DOCS_DIR = path.resolve(__dirname, '..', '..', 'docs');

const ICONS = [
  // 16/32/48 in one container — what browsers and bookmark bars ask for.
  { from: 'favicon.ico', to: 'favicon.ico' },
  // High-DPI tabs and Firefox's bookmark grid.
  { from: 'choom-icon-512.png', to: 'icon.png' },
  // iOS "add to home screen".
  { from: 'apple-touch-icon.png', to: 'apple-icon.png' },
];

let changed = 0;
for (const { from, to } of ICONS) {
  const src = path.join(DOCS_DIR, from);
  const dest = path.join(APP_DIR, to);

  if (!fs.existsSync(src)) {
    console.error(`missing source: ${path.relative(process.cwd(), src)}`);
    process.exitCode = 1;
    continue;
  }

  const next = fs.readFileSync(src);
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(next)) {
    console.log(`unchanged  app/${to}`);
    continue;
  }

  fs.writeFileSync(dest, next);
  console.log(`updated    app/${to}  <-  docs/${from}`);
  changed++;
}

if (!changed && !process.exitCode) console.log('\nEverything already in sync.');
