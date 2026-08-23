#!/usr/bin/env node
// Regenerates the site's two brand images from ONE set of words:
//
//   assets/og.png       1200x630  the link-preview card every page shares
//                                 (og:image / twitter:image)
//   assets/artwork.png   512x512  the MediaSession artwork -- what a phone
//                                 lock screen and a car dashboard show while
//                                 a track is playing
//
// Both are generated together on purpose. artwork.png was found on
// 2026-08-22 still reading "The Hannan Recordings" long after the site was
// renamed, and it survived a grep for the old name because its words are
// PAINTED, not text. Two hand-made binaries carrying the same wording is
// exactly how one of them goes stale without anyone noticing; one script and
// one pair of constants is the fix.
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
//   NODE_PATH="$(npm root -g)" node scripts/make_og_image.mjs --out-dir=/tmp

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
const dirArg = process.argv.find((a) => a.startsWith('--out-dir='));
const OUT_DIR = dirArg ? resolve(dirArg.slice('--out-dir='.length)) : join(ROOT, 'assets');

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

// Two layouts, one set of words. The wide card centres a single line; the
// square stacks the name over two lines and wraps the subtitle, because
// "The Hannan Tapes" set on one line inside 512px is too small to read on a
// lock screen at arm's length.
function pageHtml({ w, h, titleSize, subSize, stacked }) {
  const titleHtml = stacked
    ? TITLE.replace(/^(\S+)\s+(.*)$/, '$1<br>$2')   // "The" / "Hannan Tapes"
    : TITLE;
  // A band's name must not break across lines. The square wraps the subtitle
  // onto two lines and, left alone, split it as "the Mad / Hannans".
  const subHtml = SUBTITLE.replace(/Mad Hannans/g, 'Mad&nbsp;Hannans');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss()}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${w}px;height:${h}px;background:${BG};display:flex;flex-direction:column;
     align-items:center;justify-content:center;gap:${stacked ? 22 : 26}px;
     font-family:'Karla',system-ui,sans-serif;padding:0 ${stacked ? 44 : 80}px;text-align:center}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:${titleSize}px;
   line-height:1.02;color:${ACCENT};letter-spacing:-.005em}
p{font-size:${subSize}px;color:${MUTED};letter-spacing:.005em;line-height:1.35;max-width:${w - (stacked ? 96 : 200)}px}
.rule{width:${stacked ? 72 : 104}px;height:4px;background:${ACCENT};border-radius:2px;flex-shrink:0}
</style></head><body>
  <h1>${titleHtml}</h1>
  <div class="rule"></div>
  <p>${subHtml}</p>
</body></html>`;
}

const TARGETS = [
  { file: 'og.png',      w: 1200, h: 630, titleSize: 112, subSize: 34, stacked: false },
  { file: 'artwork.png', w: 512,  h: 512, titleSize: 62,  subSize: 19, stacked: true  },
];

const browser = await chromium.launch();
for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: 1 });
  await page.setContent(pageHtml(t), { waitUntil: 'load' });

  // fonts.css is unicode-range subsetted, so a face only loads for the
  // characters that need it -- which is why both load() and check() have to
  // be given the ACTUAL text. Without it, check() consults a default
  // character set spanning ranges these images never use and reports false
  // on a font that rendered perfectly.
  const fontsOk = await page.evaluate(async ({ title, subtitle, ts, ss }) => {
    await Promise.all([
      document.fonts.load(`600 ${ts}px 'Cormorant Garamond'`, title),
      document.fonts.load(`400 ${ss}px 'Karla'`, subtitle),
    ]);
    await document.fonts.ready;
    return document.fonts.check(`600 ${ts}px 'Cormorant Garamond'`, title)
        && document.fonts.check(`400 ${ss}px 'Karla'`, subtitle);
  }, { title: TITLE, subtitle: SUBTITLE, ts: t.titleSize, ss: t.subSize });

  // document.fonts.ready resolves when the faces are loaded, not necessarily
  // when the first paint using them has landed; a beat here is the difference
  // between the real serif and a fallback in the PNG.
  await page.waitForTimeout(400);

  // Refuse to write a plausible-looking image in a system fallback face --
  // the failure mode a binary nobody opens is built to hide.
  if (!fontsOk) {
    console.error(`The site fonts did not load — refusing to write ${t.file} in a fallback face.`);
    await browser.close();
    process.exit(1);
  }

  const out = join(OUT_DIR, t.file);
  await page.screenshot({ path: out });
  await page.close();
  console.log(`wrote ${out} (${(readFileSync(out).length / 1024).toFixed(1)} KB, ${t.w}x${t.h})`);
}
await browser.close();
console.log(`  title:    ${TITLE}`);
console.log(`  subtitle: ${SUBTITLE}`);
