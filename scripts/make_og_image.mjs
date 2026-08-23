#!/usr/bin/env node
// Regenerates assets/og.png — the link-preview card every page shares
// (og:image / twitter:image).
//
// MANUAL, like scripts/build_archive_zip.py: it needs headless Chromium, and
// Playwright is deliberately not a project dependency (no package.json here),
// so build.py neither runs nor depends on it. Run it by hand when the wording
// or the site's colours change, and commit the resulting PNG.
//
// It exists because the image it replaces did not have one. That file was
// committed once, in the very first SEO pass, and then said "The Hannan
// Recordings" on every shared link for months after the site had been renamed
// to "The Hannan Tapes" — because changing it meant opening an image editor,
// so nobody did. Text that ships to every social preview should be editable
// the same way the rest of the site's text is.
//
// Usage:
//   NODE_PATH="$(npm root -g)" node scripts/make_og_image.mjs
//   NODE_PATH="$(npm root -g)" node scripts/make_og_image.mjs --out /tmp/preview.png

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-chromium'));
} catch (e) {
  console.error('playwright-chromium not resolvable. Install it (npm install -g playwright-chromium)');
  console.error('and run with NODE_PATH="$(npm root -g)" node scripts/make_og_image.mjs');
  process.exit(1);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? resolve(outArg.slice('--out='.length)) : join(ROOT, 'assets', 'og.png');

// ── the words ──────────────────────────────────────────────────────────────
// The site name, kept identical to page_shell()'s <title> suffix and
// share.js's SITE_NAME. The subtitle is Rene's wording (2026-08-22): the two
// solo performers first, then the band, with its article — "Mad Hannans" is a
// group name, so "Jerry, Mad and Sean Hannan" read as three people.
const TITLE = 'The Hannan Tapes';
const SUBTITLE = 'Live recordings of Jerry, Sean and the Mad Hannans';

// The site's own dark-theme tokens (scripts/site.css, prefers-color-scheme:
// dark) rather than colours picked to match the old file — it was already
// close to these, and pinning it to the real tokens means the card and the
// site cannot drift apart again.
const BG = '#17150f';
const TEXT = '#ece7dc';
const MUTED = '#a49b8b';
const ACCENT = '#7FA37A';

// fonts.css addresses its woff2 files as /assets/fonts/… — absolute paths
// that resolve against a server, and there is no server here. file:// URLs
// do not work either: setContent() gives the page an opaque origin, and
// Chromium blocks file:// subresources from one. So inline each face as a
// data: URI — self-contained, no origin, no temp files, no cleanup, and it
// cannot silently half-work the way a broken path can.
function fontCss() {
  const css = readFileSync(join(ROOT, 'assets', 'fonts.css'), 'utf8');
  return css.replace(/url\((['"]?)\/assets\/fonts\/([^)'"]+)\1\)/g, (_m, _q, file) => {
    const b64 = readFileSync(join(ROOT, 'assets', 'fonts', file)).toString('base64');
    return `url(data:font/woff2;base64,${b64})`;
  });
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss()}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;background:${BG};display:flex;flex-direction:column;
     align-items:center;justify-content:center;gap:26px;font-family:'Karla',system-ui,sans-serif}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:112px;
   line-height:1;color:${TEXT};letter-spacing:-.005em}
p{font-size:34px;color:${MUTED};letter-spacing:.005em}
.rule{width:104px;height:4px;background:${ACCENT};border-radius:2px}
</style></head><body>
  <h1>${TITLE}</h1>
  <div class="rule"></div>
  <p>${SUBTITLE}</p>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });

// fonts.css is unicode-range subsetted, so a face only loads for the
// characters that need it -- which is why both load() and check() have to be
// given the ACTUAL text. Without it, check() consults a default character set
// spanning ranges this card never uses and reports false on a font that
// rendered perfectly.
const fontsOk = await page.evaluate(async ({ title, subtitle }) => {
  await Promise.all([
    document.fonts.load("600 112px 'Cormorant Garamond'", title),
    document.fonts.load("400 34px 'Karla'", subtitle),
  ]);
  await document.fonts.ready;
  return document.fonts.check("600 112px 'Cormorant Garamond'", title)
      && document.fonts.check("400 34px 'Karla'", subtitle);
}, { title: TITLE, subtitle: SUBTITLE });

// document.fonts.ready resolves when the faces are loaded, not necessarily
// when the first paint using them has landed; a beat here is the difference
// between the real serif and a fallback in the PNG.
await page.waitForTimeout(400);

// Assert the real fonts actually rendered rather than a system fallback --
// a silently-wrong typeface is exactly the kind of thing that would ship
// unnoticed in a binary nobody opens.
const usedSerif = fontsOk;
if (!usedSerif) {
  console.error('The site fonts did not load — refusing to write a card in a fallback face.');
  await browser.close();
  process.exit(1);
}

await page.screenshot({ path: OUT });
await browser.close();
const kb = (readFileSync(OUT).length / 1024).toFixed(1);
console.log(`wrote ${OUT} (${kb} KB)`);
console.log(`  title:    ${TITLE}`);
console.log(`  subtitle: ${SUBTITLE}`);
