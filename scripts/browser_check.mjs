#!/usr/bin/env node
// Manual, on-demand real-browser verification for the player-consolidation
// initiative (plans/player-consolidation/). NOT part of build.py or any
// CI/deploy gate -- an occasional verification aid, same status as the
// test-player-*.mjs suites (dev-only, no build.py write() line, run by hand).
//
// Needs playwright-chromium, and optionally playwright-webkit for the WebKit
// pass -- neither is a project dependency (this project has no
// package.json/node_modules by design). Install once, however you prefer:
//   npm install -g playwright-chromium
// and make sure it's resolvable (e.g. NODE_PATH="$(npm root -g)"), or install
// it locally in a throwaway node_modules next to this file. WebKit is
// optional; pass --skip-webkit if playwright-webkit isn't available.
//
// Usage:
//   python3 scripts/build.py            # make sure shows/ is current
//   NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs
//
// What this proves that the deterministic suites (test-player-*.mjs) cannot:
// real script-loading order in an actual browser, real WaveSurfer
// construction/rendering, real <audio> playback against the live production
// stream (no mocking -- streamUrl points at the real worker), real cross-tab
// BroadcastChannel delivery, and real fallback behavior when an asset is
// genuinely missing. The breakage tests copy assets/+shows/ into a temp
// directory and manipulate the COPY -- this script never touches the repo's
// working tree.
//
// Findings from building this (2026-08-14), preserved because they're easy
// to rediscover the hard way otherwise:
//   - browser.newPage() alone creates an ISOLATED context per call (its own
//     storage/cache partition, like a separate profile). That silently
//     breaks BroadcastChannel between what look like two tabs, and serves
//     stale cached responses across what looks like a fresh page load after
//     a file changed on disk. Use one explicit, shared browser.newContext()
//     per independent scenario (share it across "tabs" that should behave
//     like real tabs; use a FRESH one whenever a file on disk changed and
//     the next load must not see a cached response).
//   - WaveSurfer.js v7 renders into a Shadow DOM by default. Playwright
//     locators (page.locator(...)) pierce it automatically; raw
//     document.querySelectorAll() inside page.evaluate() does not -- see
//     findAudioDeep() below for anything that isn't a locator.
//   - A fresh headless session has zero Media Engagement Index, so Chromium
//     blocks the play() call ?autoplay=1 deep links trigger. This is real,
//     policy-dependent browser behavior, not a bug: confirmed identical
//     against the legacy wavesurfer.js engine on an unflagged page, and
//     confirmed the controller's error-state + "Retry"-labeled button
//     correctly recovers playback on a real subsequent user-gesture click
//     (see the dedicated test below). Treat autoplay-on-arrival as
//     environment-dependent in any report of this script's results --
//     "queues/highlights correctly, and recovers cleanly if the browser
//     declines to autoplay" is the honest claim, not "autoplay passed."

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium, webkit;
try {
  ({ chromium } = require('playwright-chromium'));
} catch (e) {
  console.error('playwright-chromium not resolvable. Install it (npm install -g playwright-chromium)');
  console.error('and run with NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs');
  process.exit(1);
}
const skipWebkit = process.argv.includes('--skip-webkit');
// --prod / --base=<url> retarget the whole script at a real deployed site
// instead of the local `python3 -m http.server` copy. Deliberately read
// from process.argv, not an env var -- this has to be typed explicitly
// every run, so a lingering env var can't silently redirect a later local
// dev run at production.
const isProd = process.argv.includes('--prod');
const baseFlag = process.argv.find((a) => a.startsWith('--base='));
const baseArg = baseFlag ? baseFlag.slice('--base='.length) : undefined;
// Gate on "not a local server" (either flag), not literally on --prod, so
// --base=<url> alone also skips the local server and gets the prod-only
// checks below.
const isRemote = isProd || baseArg !== undefined;
if (!skipWebkit) {
  try { ({ webkit } = require('playwright-webkit')); }
  catch (e) { console.log('(playwright-webkit not found -- skipping the WebKit pass; pass --skip-webkit to silence this)'); }
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8123;
const BASE = baseArg ?? (isProd ? 'https://renedebos.com' : `http://127.0.0.1:${PORT}`);
const ALLOWLIST = [
  // Keep in sync with pages.CONTROLLER_ENGINE_SLUGS (scripts/sitegen/pages.py)
  // -- a plain JS file can't import that Python set directly, so this is a
  // deliberate, small, manually-synced duplication rather than machinery to
  // avoid it.
  '/shows/jerry-cafe-java-1999-05-27/',
  '/shows/jerry-cafe-java-1999-03-25/',
  '/shows/mad-sweetwater-2000-10-17/',
];

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
}

// WaveSurfer's Shadow DOM (see header note) -- inlined as a string so it can
// run inside page.evaluate(`...`) calls that can't close over local scope.
const findAudioDeepFn = `function findAudioDeep(root) {
  const found = [];
  const walk = (node) => {
    if (node.shadowRoot) walk(node.shadowRoot);
    if (node.tagName === 'AUDIO') found.push(node);
    for (const c of (node.children || [])) walk(c);
  };
  walk(root);
  return found;
}`;

function startServer(dir, port) {
  const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: dir, stdio: 'ignore' });
  return new Promise((resolve) => setTimeout(() => resolve(proc), 800));
}

async function runParityPass(browser) {
  const ctx = await browser.newContext();

  for (const path of ALLOWLIST) {
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(500);

    const mounted = await page.evaluate(() => ({
      flag: window.PLAYER_ENGINE_MOUNTED, hasBoot: !!window.PLAYER_BOOT,
      viewCount: window.PLAYER_BOOT ? window.PLAYER_BOOT.views.length : 0,
      expectedViewCount: document.querySelectorAll('.track-list [data-item]').length
        + document.querySelectorAll('.recording-item[data-item]').length,
    }));
    record(`${path} controller mounted`, mounted.flag === true && mounted.hasBoot,
      `flag=${mounted.flag} views=${mounted.viewCount}`);
    // (a) viewCount was captured and printed but never actually compared
    // against the real row+card count, so a boot that mounted an incomplete
    // view set would still PASS (eighth review, finding #3).
    record(`${path} mounted every row and hero card, not a partial set`,
      mounted.viewCount === mounted.expectedViewCount,
      `views=${mounted.viewCount} expected=${mounted.expectedViewCount}`);

    const legacyRan = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.custom-player')).some((el) => !!el._audio));
    record(`${path} legacy player.js stayed dormant`, legacyRan === false);

    // (b) the check above only sees player.js's own `_audio` marker on
    // `.custom-player` elements -- it has no way to tell whether
    // wavesurfer.js (gated by the identical PLAYER_ENGINE_MOUNTED check, but
    // with no marker of its own) also stayed dormant. wavesurfer.js eagerly
    // creates a real WaveSurfer instance -- with its own real <audio> element
    // -- for every .ws-track row on page load if it ever runs (plan.md:
    // "Today every row eagerly gets its own WaveSurfer instance on page
    // load"). The controller engine's own shared <audio> element is never
    // appended to the document (grepped: no appendChild/document.body.append
    // for it anywhere) and player-views.js only builds a WaveSurfer for a row
    // once it becomes ACTIVE, which can't happen before any interaction. So
    // on a controller-engine page, immediately after load and BEFORE any
    // click, findAudioDeep() finding zero real <audio> elements proves
    // wavesurfer.js never ran -- checked here, before the play-button click
    // further down, so it observes the true pre-interaction state.
    if (await page.locator('.ws-track').count() > 0) {
      const preClickAudioCount = await page.evaluate(`(() => {
        ${findAudioDeepFn}
        return findAudioDeep(document.body).length;
      })()`);
      record(`${path} legacy wavesurfer.js stayed dormant (no eager WaveSurfer before interaction)`,
        preClickAudioCount === 0, `audioElements=${preClickAudioCount}`);
    }

    record(`${path} no console errors on load`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    const firstRow = page.locator('.track-list [data-item]').first();
    await firstRow.locator('.play-btn').click();
    await page.waitForTimeout(3000);
    const playback = await page.evaluate(() => {
      const c = window.PLAYER_BOOT.controller;
      return { state: c.state, currentTime: c.audioElement.currentTime, paused: c.audioElement.paused };
    });
    record(`${path} real playback actually advances`, playback.currentTime > 0.3 && !playback.paused,
      `state=${playback.state} t=${playback.currentTime.toFixed(2)} paused=${playback.paused}`);

    await page.evaluate(() => window.PLAYER_BOOT.controller.toggle());
    await page.waitForTimeout(300);
    record(`${path} toggle() pauses`, await page.evaluate(() => window.PLAYER_BOOT.controller.audioElement.paused));

    await page.evaluate(() => window.PLAYER_BOOT.controller.toggle());
    await page.waitForTimeout(500);
    await page.evaluate(() => window.PLAYER_BOOT.controller.seek(30));
    await page.waitForTimeout(300);
    const seekedTime = await page.evaluate(() => window.PLAYER_BOOT.controller.audioElement.currentTime);
    record(`${path} seek() actually moves playback position`, seekedTime > 25, `t=${seekedTime.toFixed(2)}`);

    const beforeSpace = await page.evaluate(() => window.PLAYER_BOOT.controller.audioElement.paused);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    const afterSpace = await page.evaluate(() => window.PLAYER_BOOT.controller.audioElement.paused);
    record(`${path} Space bar toggles playback`, afterSpace !== beforeSpace, `before=${beforeSpace} after=${afterSpace}`);
    await page.evaluate(() => window.PLAYER_BOOT.controller.stop());

    if (await page.locator('.ws-track').count() > 0) {
      await firstRow.locator('.play-btn').click();
      await page.waitForTimeout(1000);
      const canvasCount = await firstRow.locator('.ws-wave canvas').count();
      record(`${path} real WaveSurfer canvas renders for the active row`, canvasCount > 0, `canvases=${canvasCount}`);
      await page.evaluate(() => window.PLAYER_BOOT.controller.stop());
    }
    await page.close();
  }

  // Hero -> track -> next round trip (the queue-origin contract).
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/shows/jerry-cafe-java-1999-05-27/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.locator('.recording-item[data-item] .play-btn').first().click();
    await page.waitForTimeout(2000);
    const heroState = await page.evaluate(() => {
      const c = window.PLAYER_BOOT.controller;
      return { queueLen: c.queue.length, kind: c.currentItem && c.currentItem.kind, t: c.audioElement.currentTime };
    });
    record('hero: playSingleton collapses queue to 1 and real audio plays',
      heroState.queueLen === 1 && heroState.kind === 'recording' && heroState.t > 0.3, JSON.stringify(heroState));

    await page.locator('.track-list [data-item]').nth(1).locator('.play-btn').click();
    await page.waitForTimeout(1500);
    const afterRowClick = await page.evaluate(() => {
      const c = window.PLAYER_BOOT.controller;
      return { queueLen: c.queue.length, idx: c.currentIndex, t: c.audioElement.currentTime };
    });
    record('hero -> track: row click restores the full show queue and plays',
      afterRowClick.queueLen > 1 && afterRowClick.idx === 1 && afterRowClick.t > 0.3, JSON.stringify(afterRowClick));

    await page.evaluate(() => window.PLAYER_BOOT.controller.next());
    await page.waitForTimeout(1500);
    record('track -> next: advances within the restored queue',
      await page.evaluate(() => window.PLAYER_BOOT.controller.currentIndex) === 2);
    await page.evaluate(() => window.PLAYER_BOOT.controller.stop());
    await page.close();
  }

  // Deep link: queue/highlight correctness is asserted; actual autoplay
  // START is policy-dependent (see header note) and NOT asserted here.
  // Immediately followed by the real point of interest: does a genuine
  // user-gesture click recover it via the Retry path?
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/shows/jerry-cafe-java-1999-05-27/?autoplay=1#track-3', { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    const deepLink = await page.evaluate(() => {
      const c = window.PLAYER_BOOT.controller;
      const row = document.getElementById('track-3');
      return { idx: c.currentIndex, target: row.classList.contains('target'), state: c.state };
    });
    record('deep link ?autoplay=1#track-3 queues the right track and highlights it',
      deepLink.idx === 2 && deepLink.target, JSON.stringify(deepLink));
    if (deepLink.state === 'error') {
      console.log('    (autoplay was blocked by browser policy this run -- expected on a fresh session; testing recovery)');
      const beforeRetry = await page.evaluate(() => {
        const row = document.getElementById('track-3');
        return {
          ariaLabel: row.querySelector('.play-btn').getAttribute('aria-label'),
          hasErrorMsg: !!row.querySelector('.player-error-msg'),
        };
      });
      record('blocked-autoplay row shows a Retry-labeled button and a visible error message',
        /^Retry /.test(beforeRetry.ariaLabel) && beforeRetry.hasErrorMsg, JSON.stringify(beforeRetry));

      await page.locator('#track-3 .play-btn').click(); // a REAL user gesture
      await page.waitForTimeout(2500);
      const afterRetry = await page.evaluate(() => {
        const c = window.PLAYER_BOOT.controller;
        return { state: c.state, t: c.audioElement.currentTime, paused: c.audioElement.paused };
      });
      record('a real user-gesture click on Retry successfully starts playback',
        afterRetry.state === 'playing' && afterRetry.t > 0.3 && !afterRetry.paused, JSON.stringify(afterRetry));
    } else {
      record('autoplay was permitted this run (site had prior engagement) and started directly', true,
        `state=${deepLink.state}`);
    }
    await page.evaluate(() => window.PLAYER_BOOT.controller.stop());
    await page.close();
  }

  // Alternate transfers: two hero cards independently active.
  {
    const page = await ctx.newPage();
    await page.goto(BASE + '/shows/mad-sweetwater-2000-10-17/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const altDetails = page.locator('.alt-details');
    if (await altDetails.count() > 0) await altDetails.locator('summary').click();
    const cards = page.locator('.recording-item[data-item]');
    const cardCount = await cards.count();
    await cards.nth(0).locator('.play-btn').click();
    await page.waitForTimeout(2000);
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.recording-item[data-item]')).map((el) => ({
        id: JSON.parse(el.dataset.item).id, playing: el.classList.contains('playing'),
      })));
    record('mad-sweetwater-2000-10-17: only the clicked recording card shows active (stream-key collision case)',
      cardCount >= 2 && ids.filter((x) => x.playing).length === 1, JSON.stringify(ids));
    await page.evaluate(() => window.PLAYER_BOOT.controller.stop());
    await page.close();
  }

  // Cross-tab claim/pause: show page vs /playlist/, same shared context.
  {
    const showPage = await ctx.newPage();
    await showPage.goto(BASE + '/shows/jerry-cafe-java-1999-05-27/', { waitUntil: 'load' });
    await showPage.waitForTimeout(500);
    await showPage.locator('.track-list [data-item]').first().locator('.play-btn').click();
    await showPage.waitForTimeout(1500);
    const before = await showPage.evaluate(() => !window.PLAYER_BOOT.controller.audioElement.paused);

    const playlistPage = await ctx.newPage();
    await playlistPage.goto(BASE + '/playlist/', { waitUntil: 'load' });
    await playlistPage.waitForTimeout(500);
    await playlistPage.evaluate(() => window.claimPlayback && window.claimPlayback('browser-check'));
    await showPage.waitForTimeout(1000);
    const after = await showPage.evaluate(() => !window.PLAYER_BOOT.controller.audioElement.paused);
    record('cross-tab: a claim from /playlist/ pauses the controller-engine show page',
      before === true && after === false, `before=${before} after=${after}`);
    await showPage.close();
    await playlistPage.close();
  }

  await ctx.close();
}

async function runBreakageTests(browser, copyDir, base) {
  // Test A: player-boot.js missing -> full legacy fallback.
  {
    const path = join(copyDir, 'assets', 'player-boot.js');
    renameSync(path, path + '.disabled');
    try {
      const testCtx = await browser.newContext(); // fresh cache partition -- see header note
      const page = await testCtx.newPage();
      await page.goto(base + '/shows/jerry-cafe-java-1999-05-27/', { waitUntil: 'load' });
      await page.waitForTimeout(1000);

      const flagState = await page.evaluate(() => ({ flag: window.PLAYER_ENGINE_MOUNTED, hasBoot: !!window.PLAYER_BOOT }));
      record('breakage A1: missing player-boot.js never sets the mounted flag',
        flagState.flag === undefined && !flagState.hasBoot, JSON.stringify(flagState));

      await page.locator('.recording-item .play-btn').first().click();
      await page.waitForTimeout(2000);
      const heroPlaying = await page.evaluate(() => {
        const el = document.querySelector('.recording-item .custom-player');
        return el && el._audio ? { found: true, t: el._audio.currentTime, paused: el._audio.paused } : { found: false };
      });
      record('breakage A2: legacy player.js drives the Full Recording card',
        heroPlaying.found && heroPlaying.t > 0.3 && !heroPlaying.paused, JSON.stringify(heroPlaying));

      await page.locator('#track-1 .play-btn').click();
      await page.waitForTimeout(2000);
      const waveformPlaying = await page.evaluate(`(() => {
        ${findAudioDeepFn}
        const audios = findAudioDeep(document.body).filter(a => !a.paused);
        return audios.length ? { found: true, t: audios[0].currentTime, paused: audios[0].paused } : { found: false };
      })()`);
      record('breakage A3: legacy wavesurfer.js still drives waveform track rows (full pair fallback)',
        waveformPlaying.found && waveformPlaying.t > 0.3 && !waveformPlaying.paused, JSON.stringify(waveformPlaying));

      await testCtx.close();
    } finally {
      renameSync(path + '.disabled', path);
    }
  }

  // Test B: wavesurfer.esm.js missing -> partial fallback (the seventh
  // review's correction). Full Recording keeps working; waveform rows die
  // in BOTH engines, because they share this one vendored dependency.
  {
    const path = join(copyDir, 'assets', 'wavesurfer.esm.js');
    renameSync(path, path + '.disabled');
    try {
      const testCtx = await browser.newContext();
      const page = await testCtx.newPage();
      await page.goto(base + '/shows/jerry-cafe-java-1999-05-27/', { waitUntil: 'load' });
      await page.waitForTimeout(1000);

      const flagState = await page.evaluate(() => ({ flag: window.PLAYER_ENGINE_MOUNTED, hasBoot: !!window.PLAYER_BOOT }));
      record('breakage B1: missing wavesurfer.esm.js also blocks the controller mount (shared dependency)',
        flagState.flag === undefined && !flagState.hasBoot, JSON.stringify(flagState));

      await page.locator('.recording-item .play-btn').first().click();
      await page.waitForTimeout(2000);
      const heroPlaying = await page.evaluate(() => {
        const el = document.querySelector('.recording-item .custom-player');
        return el && el._audio ? { found: true, t: el._audio.currentTime, paused: el._audio.paused } : { found: false };
      });
      record('breakage B2: Full Recording card still works via classic player.js',
        heroPlaying.found && heroPlaying.t > 0.3 && !heroPlaying.paused, JSON.stringify(heroPlaying));

      await page.locator('#track-1 .play-btn').click();
      await page.waitForTimeout(2000);
      const waveformState = await page.evaluate(`(() => {
        ${findAudioDeepFn}
        const audios = findAudioDeep(document.body);
        const row = document.getElementById('track-1');
        return { audioElExists: audios.length > 0, rowHasLegacyMarker: !!row._audio, rowPlaying: row.classList.contains('playing') };
      })()`);
      record('breakage B3: waveform track rows are correctly dead (no working play path in either engine)',
        !waveformState.audioElExists && !waveformState.rowHasLegacyMarker && !waveformState.rowPlaying,
        JSON.stringify(waveformState));

      await testCtx.close();
    } finally {
      renameSync(path + '.disabled', path);
    }
  }
}

// ── prod-only checks (--prod / --base=<url>) ────────────────────────────
// Everything below only runs against a real deployed site (see isRemote in
// the run section) -- it can't run against the local `python3 -m
// http.server` copy the way runBreakageTests does.

// Assets that must serve as real, correctly-typed module scripts in
// production -- a 404 or a wrong Content-Type can fail silently in some
// browsers, and neither would be caught by the local-server pass (a plain
// `python3 -m http.server` doesn't set the same headers Cloudflare does).
const PROD_ASSET_PATHS = [
  '/assets/player-boot.js',
  '/assets/player-controller.js',
  '/assets/player-views.js',
  '/assets/wavesurfer.esm.js',
];
const JS_CONTENT_TYPE_RE = /^(text|application)\/javascript/i;
// Expected Cache-Control for unhashed /assets/*.js, per repo-root `_headers`:
// that file has no explicit rule block for /assets/*.js (its "Caching."
// comment explicitly says NOT to add a long max-age there, since these ship
// under stable, unhashed names -- a cached copy would shadow the next
// deploy with no way to purge it client-side), so Cloudflare's documented
// default asset-server policy applies: "public, max-age=0, must-revalidate".
const EXPECTED_JS_CACHE_CONTROL_RE = /^public,\s*max-age=0,\s*must-revalidate$/i;

async function checkAssetHeaders(context) {
  for (const path of PROD_ASSET_PATHS) {
    const res = await context.request.get(BASE + path);
    record(`${path} responds 200`, res.status() === 200, `status=${res.status()}`);
    const headers = res.headers();
    const contentType = headers['content-type'] || '';
    record(`${path} Content-Type is a JS module type`, JS_CONTENT_TYPE_RE.test(contentType),
      `content-type=${contentType}`);
    const cacheControl = headers['cache-control'] || '';
    record(`${path} Cache-Control matches _headers' documented default for unhashed JS`,
      EXPECTED_JS_CACHE_CONTROL_RE.test(cacheControl), `cache-control=${cacheControl}`);
  }
}

// The 3-page canary (ALLOWLIST) is deliberately narrow -- this confirms the
// deploy didn't leak the controller engine onto pages that were never
// switched over, and that real legacy playback still works on the pages
// that matter most for that regression (a show page, and both continuous-
// playback pages).
const NON_ALLOWLISTED_PAGES = [
  '/',
  '/playlist/',
  '/player/',
  '/shows/jerry-cafe-java-1999-04-08/', // a non-allowlisted show page
  '/songs/a-bunch-of-thyme/',           // a song page, exercises initCustomPlayers
];

async function checkNonAllowlistedPagesUnaffected(context) {
  for (const path of NON_ALLOWLISTED_PAGES) {
    const page = await context.newPage();
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const flag = await page.evaluate(() => window.PLAYER_ENGINE_MOUNTED);
    record(`${path} controller engine NOT mounted (non-allowlisted page)`, !flag, `flag=${flag}`);
    await page.close();
  }

  // Show page: same assertion runBreakageTests' A2 uses for the Full
  // Recording card -- confirms real legacy player.js playback, not just
  // that the mounted flag is absent.
  {
    const page = await context.newPage();
    await page.goto(BASE + '/shows/jerry-cafe-java-1999-04-08/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.locator('.recording-item .play-btn').first().click();
    await page.waitForTimeout(2000);
    const heroPlaying = await page.evaluate(() => {
      const el = document.querySelector('.recording-item .custom-player');
      return el && el._audio ? { found: true, t: el._audio.currentTime, paused: el._audio.paused } : { found: false };
    });
    record('/shows/jerry-cafe-java-1999-04-08/ real legacy playback works (Full Recording card)',
      heroPlaying.found && heroPlaying.t > 0.3 && !heroPlaying.paused, JSON.stringify(heroPlaying));
    await page.close();
  }

  // /playlist/: playlist.js's own <audio> is a detached `new Audio()` --
  // never appended to the DOM (see the file's own comments), so
  // findAudioDeep genuinely can't see it the way it sees a real wavesurfer
  // <audio>. The DOM-visible equivalent of "currentTime advances" here is
  // the now-playing panel's live time display, driven by the same
  // 'timeupdate' listener that would drive a visible <audio> element's
  // currentTime -- so this is the same assertion, adapted to how this
  // engine actually surfaces playback state.
  {
    const page = await context.newPage();
    await page.goto(BASE + '/playlist/', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const b = document.getElementById('pl-generate');
      return !!b && !b.disabled;
    }, null, { timeout: 15000 }); // catalog fetch has to land before a preset can build a queue
    await page.locator('.pl-preset[data-preset="mixed45"]').click(); // real user gesture
    await page.waitForTimeout(2500);
    const timeText = (await page.locator('#pl-now .pl-time-current').textContent().catch(() => null) || '').trim();
    record('/playlist/ real legacy playback works (preset click -> real <audio> advances)',
      timeText !== '' && timeText !== '0:00', `time=${timeText}`);
    await page.close();
  }

  // /player/: cue a real track via the same #p=<id> hash sendToPlayer() uses
  // for a hand-off from /playlist/, then a real click on the play button
  // (same "genuine user-gesture click" pattern as the deep-link Retry test
  // in runParityPass) starts playback.
  {
    const tracksRes = await context.request.get(BASE + '/assets/tracks.json');
    const tracks = await tracksRes.json();
    const trackId = tracks[0].id;
    const page = await context.newPage();
    await page.goto(BASE + '/player/#p=' + trackId, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.locator('#cp-now [data-act="play"]').click(); // real user gesture
    await page.waitForTimeout(2500);
    const timeText = (await page.locator('#cp-now .pl-time-current').textContent().catch(() => null) || '').trim();
    record('/player/ real legacy playback works (queued track -> real <audio> advances)',
      timeText !== '' && timeText !== '0:00', `time=${timeText}`);
    await page.close();
  }
}

async function runWebkitSmoke() {
  if (!webkit) return;
  const browser = await webkit.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  await page.goto(BASE + ALLOWLIST[0], { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const mounted = await page.evaluate(() => ({ flag: window.PLAYER_ENGINE_MOUNTED, hasBoot: !!window.PLAYER_BOOT }));
  record('WebKit: controller mounts', mounted.flag === true && mounted.hasBoot, JSON.stringify(mounted));
  record('WebKit: no console errors on load', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await page.locator('.track-list [data-item]').first().locator('.play-btn').click();
  await page.waitForTimeout(2500);
  const playback = await page.evaluate(() => {
    const c = window.PLAYER_BOOT.controller;
    return { t: c.audioElement.currentTime, paused: c.audioElement.paused };
  });
  record('WebKit: real playback starts from a real click gesture', playback.t > 0.3 && !playback.paused, JSON.stringify(playback));
  const canvasCount = await page.locator('.track-list [data-item]').first().locator('.ws-wave canvas').count();
  record('WebKit: WaveSurfer canvas renders', canvasCount > 0, `canvases=${canvasCount}`);
  await browser.close();
}

// ── run ──────────────────────────────────────────────────────────────────
if (!isRemote && !require('node:fs').existsSync(join(ROOT, 'shows'))) {
  console.error('No shows/ directory found -- run `python3 scripts/build.py` first.');
  process.exit(1);
}

if (isRemote) {
  // Cheap pre-flight, before launching Playwright at all -- fail fast with a
  // clear message instead of letting a bad BASE hang every subsequent
  // navigation until Playwright's own timeout.
  let preflightOk = false;
  try {
    const res = await fetch(BASE + '/');
    preflightOk = res.status === 200;
    if (!preflightOk) console.error(`Pre-flight check failed: GET ${BASE}/ returned ${res.status} (expected 200).`);
  } catch (e) {
    console.error(`Pre-flight check failed: GET ${BASE}/ -- ${e.message}`);
  }
  if (!preflightOk) process.exit(1);
}

const mainServer = isRemote ? null : await startServer(ROOT, PORT);
const browser = await chromium.launch();
try {
  await runParityPass(browser);

  if (isRemote) {
    const ctx = await browser.newContext();
    await checkAssetHeaders(ctx);
    await checkNonAllowlistedPagesUnaffected(ctx);
    await ctx.close();
  } else {
    // Isolated copy for the breakage tests -- assets/+shows/ only (everything
    // the generated pages actually reference), on a SEPARATE port, so this
    // script never renames a file inside the real working tree.
    const copyDir = mkdtempSync(join(tmpdir(), 'player-consolidation-browser-check-'));
    cpSync(join(ROOT, 'assets'), join(copyDir, 'assets'), { recursive: true });
    cpSync(join(ROOT, 'shows'), join(copyDir, 'shows'), { recursive: true });
    const copyPort = PORT + 1;
    const copyServer = await startServer(copyDir, copyPort);
    try {
      await runBreakageTests(browser, copyDir, `http://127.0.0.1:${copyPort}`);
    } finally {
      copyServer.kill();
      rmSync(copyDir, { recursive: true, force: true });
    }
  }

  await runWebkitSmoke();
} finally {
  await browser.close();
  if (mainServer) mainServer.kill();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
