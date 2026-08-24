#!/usr/bin/env node
// Regenerates every brand image the site ships, from ONE set of constants:
//
//   assets/og.png          1200x630  the link-preview card every page shares
//                                    (og:image / twitter:image)
//   assets/artwork.png      512x512  the MediaSession artwork -- what a phone
//                                    lock screen and a car dashboard show
//                                    while a track is playing
//   apple-touch-icon.png    180x180  iOS home screen / Safari
//   favicon-32.png            32x32  browser tab
//   favicon-16.png            16x16  small tab / bookmark rows
//   favicon.ico                      the by-convention root request
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
// AFTER REGENERATING, RUN scripts/build.py. Both cards are addressed with a
// ?v=<content hash> so a redrawn image actually reaches phones and scrapers
// that cached the last one -- see OG_IMAGE in sitegen/core.py for the incident
// that produced that. og:image re-versions itself on every build; the
// lock-screen artwork's URL is typed into player-controller.js, and build.py
// refuses to build until it matches, printing the line to paste. Skipping the
// rebuild is the failure this exists to prevent: new file on the server, old
// picture everywhere it counts.
//
// Usage:
//   NODE_PATH="$(npm root -g)" node scripts/make_brand_images.mjs
//   NODE_PATH="$(npm root -g)" node scripts/make_brand_images.mjs --out-dir=/tmp

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
  console.error('and run with NODE_PATH="$(npm root -g)" node scripts/make_brand_images.mjs');
  process.exit(1);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dirArg = process.argv.find((a) => a.startsWith('--out-dir='));
const OUT_DIR = dirArg ? resolve(dirArg.slice('--out-dir='.length)) : join(ROOT, 'assets');
const ICON_DIR = dirArg ? OUT_DIR : ROOT;

// ── the words ──────────────────────────────────────────────────────────────
// The site name, kept identical to page_shell()'s <title> suffix and
// share.js's SITE_NAME. The subtitle is Rene's wording (2026-08-22): the two
// solo performers first, then the band, with its article — "Mad Hannans" is a
// group name, so "Jerry, Mad and Sean Hannan" read as three people.
const TITLE = 'The Hannan Tapes';
// The icon mark. Two letters is all that survives a 16px favicon, and it has
// to be the site's initials rather than a picture: the walking figure from
// Jerry's "Cheers, Beers, Bucket of Fears" EP exists on a CD sleeve and
// nowhere digital (searched 2026-08-22 -- no image files at all under DAT
// Tapes on the Drive, nothing on jerryhannan.com, nothing on the web).
const MONOGRAM = 'HT';
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

// The icon is the same identity at a size where nothing but two letters
// survives. Dark letters on a SOLID GREEN ground, deliberately, and not the
// dark ground the cards use: at 16px a green glyph on near-black loses its
// counters, while a filled tile keeps its shape and stands out in a tab strip
// where almost every other favicon is pale. Karla bold rather than Cormorant
// for the same reason -- a high-contrast serif's thin strokes disappear.
// Compared at 180/32/16 before choosing; swap FG/BG here for the inverse.
function iconHtml(size) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss()}
*{margin:0;padding:0}
body{width:${size}px;height:${size}px;background:${ACCENT};display:flex;
     align-items:center;justify-content:center}
span{font-family:'Karla',system-ui,sans-serif;font-weight:700;color:${BG};
     font-size:${Math.round(size * 0.46)}px;line-height:1;letter-spacing:.01em}
</style></head><body><span>${MONOGRAM}</span></body></html>`;
}

const TARGETS = [
  { file: 'og.png',      w: 1200, h: 630, titleSize: 112, subSize: 34, stacked: false },
  { file: 'artwork.png', w: 512,  h: 512, titleSize: 62,  subSize: 19, stacked: true  },
];

// Written to the ROOT, not assets/: apple-touch-icon.png and favicon.ico are
// both requested by convention at the site root when a page offers no link,
// which is exactly the fallback that was missing when Safari showed a cached
// CNN icon for this site.
const ICONS = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png',       size: 32  },
  { file: 'favicon-16.png',       size: 16  },
];

// A .ico wrapping a PNG -- legal since Vista and understood everywhere that
// still asks for /favicon.ico. Hand-built because this project has no image
// library at all (no Pillow, no ImageMagick), and the container is 22 bytes.
function icoWrapping(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type 1 = icon
  header.writeUInt16LE(1, 4);            // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);   // 0 means 256
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);                // palette size
  entry.writeUInt8(0, 3);                // reserved
  entry.writeUInt16LE(1, 4);             // colour planes
  entry.writeUInt16LE(32, 6);            // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);           // offset: 6 + 16
  return Buffer.concat([header, entry, png]);
}

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
for (const ic of ICONS) {
  const page = await browser.newPage({ viewport: { width: ic.size, height: ic.size }, deviceScaleFactor: 1 });
  await page.setContent(iconHtml(ic.size), { waitUntil: 'load' });
  const ok = await page.evaluate(async ({ mark, px }) => {
    await document.fonts.load(`700 ${px}px 'Karla'`, mark);
    await document.fonts.ready;
    return document.fonts.check(`700 ${px}px 'Karla'`, mark);
  }, { mark: MONOGRAM, px: Math.round(ic.size * 0.46) });
  await page.waitForTimeout(300);
  if (!ok) {
    console.error(`Karla did not load — refusing to write ${ic.file} in a fallback face.`);
    await browser.close();
    process.exit(1);
  }
  const out = join(ICON_DIR, ic.file);
  await page.screenshot({ path: out });
  await page.close();
  console.log(`wrote ${out} (${(readFileSync(out).length / 1024).toFixed(1)} KB, ${ic.size}x${ic.size})`);
}

const ico = join(ICON_DIR, 'favicon.ico');
writeFileSync(ico, icoWrapping(readFileSync(join(ICON_DIR, 'favicon-32.png')), 32));
console.log(`wrote ${ico} (${(readFileSync(ico).length / 1024).toFixed(1)} KB, ICO wrapping the 32px PNG)`);

await browser.close();
console.log(`  title:    ${TITLE}`);
console.log(`  subtitle: ${SUBTITLE}`);
console.log(`  monogram: ${MONOGRAM}`);
