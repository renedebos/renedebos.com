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

// pages.CONTROLLER_ENGINE_SLUGS (scripts/sitegen/pages.py) now allowlists
// every one of the 30 public shows (Step 5b) -- a plain JS file can't import
// that Python set directly, and hardcoding 30 slugs here would just be
// duplication with no coverage benefit, so instead the full show list is
// fetched at runtime from assets/home-shows.json (see fetchAllShowUrls()
// below), the same real deployed asset the homepage itself uses. That list
// drives the LIGHT check tier (mount/view-count/dormancy/console-errors) on
// all 30 pages.
//
// Running the full real-audio-playback sequence (click play, wait ~3s,
// toggle, seek, Space, wait for canvas) on all 30 pages would be slow and,
// for --prod runs, would mean streaming real production audio 30 times
// instead of 3 for what's fundamentally the same engine code on every page.
// So the HEAVY tier (everything the light tier does, plus real playback)
// only runs on these 4 pages, chosen for genuinely different markup shapes
// (confirmed via a prior Codex review's catalog audit -- no other show
// introduces a different playable-row selector or controller branch, so this
// set is exhaustive for shape coverage, not arbitrary):
const HEAVY_CHECK_SLUGS = [
  'jerry-cafe-java-1999-05-27', // plain: waveform rows, one Full Recording card
  'jerry-cafe-java-1999-03-25', // two canonical Full Recording parts, two hero cards
  'mad-sweetwater-2000-10-17',  // alternate transfer sharing a stream proxy
  'jerry-19-broadway-1999-03-29', // largest page in the catalog: 34 tracks, 5 recording cards
];

// Fetched once, early, in the run section below -- populated before
// runParityPass is called. Module-scoped so pickNonAllowlistedShowPage() (a
// prod-only check) can reuse the same fetch instead of hitting the network
// again.
let ALL_SHOWS = null;

// assets/controller-excluded-slugs.json mirrors sitegen.pages'
// CONTROLLER_ENGINE_EXCLUDED_SLUGS (Step 5b's rollback escape hatch, fixed
// 2026-08-14) -- a plain JSON array of slugs deliberately NOT allowlisted,
// currently always []. Fetched once alongside home-shows.json so the main
// per-page loop can skip these pages (asserting "controller mounted" on a
// deliberately-excluded page would be a false failure) and
// pickNonAllowlistedShowPage() can find a real one instead of always hitting
// its "everyone's allowlisted" null path.
let EXCLUDED_SLUGS = [];

async function fetchAllShowUrls(context) {
  const [showsRes, excludedRes] = await Promise.all([
    context.request.get(BASE + '/assets/home-shows.json'),
    context.request.get(BASE + '/assets/controller-excluded-slugs.json'),
  ]);
  const shows = await showsRes.json();
  ALL_SHOWS = shows;
  EXCLUDED_SLUGS = await excludedRes.json();

  // Residual, currently-latent gap: home-shows.json is built by
  // build_home_shows() (scripts/sitegen/feeds.py), which only includes shows
  // with a truthy `tracks` field ("one row per track-listed show," per its
  // own docstring) -- a subset of PUBLIC_SHOWS, which is what
  // CONTROLLER_ENGINE_SLUGS is actually computed from. Today every public
  // show is track-listed so the two sets coincide, but nothing enforces
  // that, and a future trackless-but-public show would silently narrow what
  // this harness checks without any error. Fully closing that gap means
  // changing home-shows.json's row-inclusion criteria, which the live
  // homepage also depends on -- out of scope here. Instead, catch the most
  // consequential version of "the fetched catalog silently narrowed": losing
  // stress-test coverage on HEAVY_CHECK_SLUGS.
  const fetchedSlugs = new Set(shows.map((s) => s.slug));
  const missingHeavy = HEAVY_CHECK_SLUGS.filter((slug) => !fetchedSlugs.has(slug));
  if (missingHeavy.length > 0) {
    throw new Error(
      `home-shows.json is missing HEAVY_CHECK_SLUGS entr${missingHeavy.length === 1 ? 'y' : 'ies'}: ` +
      `${missingHeavy.join(', ')} -- the fetched catalog silently narrowed, refusing to run a ` +
      `smaller heavy-check set than intended.`);
  }

  return shows;
}

// Cloudflare auto-injects an analytics beacon <script> into every page on
// this site; the site's CSP (`script-src 'self' 'unsafe-inline'`, no
// exception for Cloudflare's own domain) blocks it, producing one console
// error on literally every page load, site-wide -- confirmed unrelated to
// player-consolidation (reproduced via curl/direct testing on pages this
// initiative never touched, e.g. /contact/). Filtered out of the "no console
// errors" checks below so it doesn't drown real signal now that all 30 pages
// are checked (5b) -- NOT a general "ignore CSP errors" policy, just this one
// specific, pre-existing, already-diagnosed, site-wide message.
const KNOWN_UNRELATED_CSP_WARNING = /static\.cloudflareinsights\.com\/beacon\.min\.js/;

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

async function runParityPass(browser, allShows, heavyCheckSlugs) {
  const ctx = await browser.newContext();
  const heavySlugSet = new Set(heavyCheckSlugs);

  // A deliberately-excluded show (CONTROLLER_ENGINE_EXCLUDED_SLUGS) is never
  // allowlisted on purpose -- asserting "controller mounted" on it would be a
  // false failure, and checkNonAllowlistedPagesUnaffected() already covers
  // exactly this page via pickNonAllowlistedShowPage() below.
  const excludedSlugSet = new Set(EXCLUDED_SLUGS);
  const showsToCheck = allShows.filter((s) => !excludedSlugSet.has(s.slug));

  for (const show of showsToCheck) {
    const path = show.url;
    const isHeavy = heavySlugSet.has(show.slug);
    // Error isolation: a single page throwing (locator timeout, navigation
    // failure, anything) must not abort every remaining page's evaluation --
    // this is exactly what happened during this project's first real
    // production run (see plans/player-consolidation/player-consolidation-
    // codex.md's ninth review). Only this per-page loop gets this treatment;
    // the Hero/deep-link/alt-transfer/cross-tab sections below run once each
    // and a crash there should still surface as an uncaught failure.
    let page;
    try {
      page = await ctx.newPage();
      const consoleErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

      await page.goto(BASE + path, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      // ── light checks: run on every one of the 30 pages ──────────────────
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

      const realErrors = consoleErrors.filter((e) => !KNOWN_UNRELATED_CSP_WARNING.test(e));
      record(`${path} no console errors on load`, realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

      // ── heavy checks: real playback, only on HEAVY_CHECK_SLUGS pages ────
      if (isHeavy) {
        // jerry-19-broadway-1999-03-29 (34 tracks) is by far the largest
        // page in the catalog, so it's the meaningful stress case for the
        // eighth review's inactive-row DOM-churn fix -- the other 3 heavy-
        // check pages don't have enough rows to make this worth the extra
        // observer bookkeeping. Attach a MutationObserver to an INACTIVE
        // row's play button (index 2, not the row about to be clicked at
        // index 0) BEFORE playback starts, and let it observe through the
        // playback/toggle/seek/Space sequence below -- that sequence already
        // drives several seconds of timeupdate-triggered re-renders, so no
        // new waits are needed, just an observer running during the window
        // that's already there. A page.evaluate callback can't return a live
        // observer, so results are stashed on window.__mutationLog and read
        // back afterward in a follow-up page.evaluate.
        const isStressTest = show.slug === 'jerry-19-broadway-1999-03-29';
        if (isStressTest) {
          await page.evaluate(() => {
            window.__mutationLog = [];
            const inactiveRow = document.querySelectorAll('.track-list [data-item]')[2];
            const target = inactiveRow.querySelector('.play-btn') || inactiveRow;
            const observer = new MutationObserver((records) => {
              window.__mutationLog.push(...records.map((r) => ({ type: r.type, attributeName: r.attributeName })));
            });
            observer.observe(target, { attributes: true, childList: true, subtree: true });
            window.__mutationObserver = observer;
          });
        }

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

        if (isStressTest) {
          const mutationCount = await page.evaluate(() => {
            window.__mutationObserver.disconnect();
            return window.__mutationLog.length;
          });
          record(`${path} inactive row not rewritten during playback/toggle/seek/Space (DOM-churn stress test)`,
            mutationCount === 0, `mutations=${mutationCount}`);
        }

        if (await page.locator('.ws-track').count() > 0) {
          await firstRow.locator('.play-btn').click();
          await page.waitForTimeout(1000);
          const canvasCount = await firstRow.locator('.ws-wave canvas').count();
          record(`${path} real WaveSurfer canvas renders for the active row`, canvasCount > 0, `canvases=${canvasCount}`);
          await page.evaluate(() => window.PLAYER_BOOT.controller.stop());
        }
      }
      await page.close();
    } catch (e) {
      // Error isolation (Fix A): a page-level crash here must not abort
      // every remaining page -- record a single synthetic failure and move on.
      record(`${path} page-level crash`, false, e.message);
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      continue;
    }
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
  // Immediately followed by the real point of interest: when the browser DOES
  // block it, is the row presented as cued-and-waiting, and does a genuine
  // user-gesture click start it?
  //
  // This block used to assert the opposite -- a "Retry"-labelled button and an
  // error message -- and passed, because it correctly observed the block and
  // then codified the wrong UI for it. That is how the bug reached production:
  // "Play random tape" sends every visitor down exactly this path, and iOS
  // Safari blocks it every time, so a phone always saw "Playback failed".
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
          hasErrorClass: row.classList.contains('player-error'),
          isActive: row.classList.contains('is-active'),
          cue: row.querySelector('.player-cue-msg')
            ? row.querySelector('.player-cue-msg').textContent : null,
        };
      });
      record('blocked-autoplay row is cued for a tap, not reported as a failure',
        /^Play /.test(beforeRetry.ariaLabel)
        && !beforeRetry.hasErrorMsg && !beforeRetry.hasErrorClass
        && beforeRetry.isActive && beforeRetry.cue === 'Tap play to start',
        JSON.stringify(beforeRetry));

      await page.locator('#track-3 .play-btn').click(); // a REAL user gesture
      await page.waitForTimeout(2500);
      const afterRetry = await page.evaluate(() => {
        const c = window.PLAYER_BOOT.controller;
        return { state: c.state, t: c.audioElement.currentTime, paused: c.audioElement.paused };
      });
      record('a real user-gesture click on the cued row successfully starts playback',
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
  // Synthetic-claim half (a claim from an unmigrated /player/-style
  // participant, still bare-string, still real until Phase 3): drives
  // window.claimPlayback -- player.js's ambient global, which stays loaded
  // on /playlist/ regardless of which engine that page itself runs.
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
    record('cross-tab (synthetic): a claim from /playlist/ pauses the controller-engine show page',
      before === true && after === false, `before=${before} after=${after}`);
    await showPage.close();
    await playlistPage.close();
  }

  // Real engine-to-engine half (plans/player-consolidation/ Phase 2): both
  // directions, with REAL playback on both sides, against /playlist/
  // specifically -- the synthetic check above only proves a show page
  // reacts to a claim, not that /playlist/'s own controller instance
  // participates correctly on either side of the exchange once it's the one
  // actually playing.
  {
    const showPage = await ctx.newPage();
    await showPage.goto(BASE + '/shows/jerry-cafe-java-1999-05-27/', { waitUntil: 'load' });
    await showPage.waitForTimeout(500);
    await showPage.locator('.track-list [data-item]').first().locator('.play-btn').click();
    await showPage.waitForTimeout(1500);

    const playlistPage = await ctx.newPage();
    await playlistPage.goto(BASE + '/playlist/', { waitUntil: 'load' });
    await playlistPage.waitForFunction(() => window.PLAYLIST_ENGINE_MOUNTED === true, null, { timeout: 15000 });
    await playlistPage.locator('.pl-preset[data-preset="mixed45"]').click();
    await playlistPage.waitForTimeout(1500);

    const showPlayingBefore = await showPage.evaluate(() => !window.PLAYER_BOOT.controller.audioElement.paused);
    const playlistPlayingAfter = await playlistPage.evaluate(() => window.PLAYLIST_BOOT.controller.state === 'playing');
    record('cross-tab (real, show -> playlist): starting real playback on /playlist/ pauses the show page',
      showPlayingBefore === false, `showPlaying(afterPlaylistStarted)=${showPlayingBefore}`);
    record('cross-tab (real, show -> playlist): /playlist/ itself keeps playing (its own claim must not self-pause)',
      playlistPlayingAfter === true, `playlistState=${playlistPlayingAfter}`);

    await showPage.locator('.track-list [data-item]').first().locator('.play-btn').click();
    await showPage.waitForTimeout(1500);
    const playlistPausedAfter = await playlistPage.evaluate(() => window.PLAYLIST_BOOT.controller.audioElement.paused);
    record('cross-tab (real, playlist -> show): a claim from the show page pauses /playlist/',
      playlistPausedAfter === true, `playlistPaused=${playlistPausedAfter}`);

    await showPage.close();
    await playlistPage.close();
  }

  await ctx.close();
}

// Dedicated /playlist/ checks (plans/player-consolidation/ Phase 2). One
// function, not a HEAVY_CHECK_SLUGS entry -- that tiering exists to avoid
// streaming real audio 30 times for interchangeable show pages, which
// doesn't apply to one architecturally distinct page. Follows this file's
// own conventions: record() pass/fail, isRemote-gated prod-only checks.
async function checkPlaylistPage(context) {
  const url = '/playlist/';
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !KNOWN_UNRELATED_CSP_WARNING.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(BASE + url, { waitUntil: 'load' });

  // 1. Mount. playlist-boot.js is the only engine now (Stage 2c deleted the
  // legacy playlist.js fallback) and mounts unconditionally at parse time.
  await page.waitForFunction(() => window.PLAYLIST_ENGINE_MOUNTED === true, null, { timeout: 15000 });
  const mountInfo = await page.evaluate(() => ({
    hasBoot: !!window.PLAYLIST_BOOT, hasController: !!(window.PLAYLIST_BOOT && window.PLAYLIST_BOOT.controller),
  }));
  record(`${url}: mount (flag set, controller exposed on PLAYLIST_BOOT)`,
    mountInfo.hasBoot && mountInfo.hasController, JSON.stringify(mountInfo));

  // 2. Catalog fetch landed and the generator is usable.
  await page.waitForFunction(() => {
    const b = document.getElementById('pl-generate');
    return !!b && !b.disabled;
  }, null, { timeout: 15000 });

  // 3. Real playback via a preset.
  await page.locator('.pl-preset[data-preset="mixed45"]').click();
  await page.waitForTimeout(2000);
  const timeText = (await page.locator('#pl-now .pl-time-current').textContent().catch(() => null) || '').trim();
  record(`${url}: real playback (preset click -> #pl-now time advances)`,
    timeText !== '' && timeText !== '0:00', `time=${timeText}`);

  // 4. Hash round-trip: reload at the hash the queue just wrote and confirm
  // the same ids in the same order, cued (not autoplaying).
  //
  // Found while running this for real for the first time (2026-08-15, Stage
  // 2c real-browser gate): `page.goto(BASE + url + hash1, ...)` here used to
  // navigate to a URL that is BYTE-IDENTICAL to the one the page is already
  // on (hash1 was just read from that same location.hash) -- per the HTML
  // spec, navigating to a URL differing only by fragment (or not at all) is
  // a same-document navigation: no unload/load, no JS state reset. Verified
  // directly against production: `goto()` to an identical URL leaves an
  // arbitrary `window` marker set beforehand untouched, while `page.reload()`
  // reliably clears it. So the old version never actually reloaded anything
  // -- it re-read the SAME live controller instance (still mid-playback from
  // step 3 above) and always reported `playing: true`, which is why this
  // never caught anything: `browser_check.mjs` had never been run for real
  // before now (no playwright-chromium in this environment until today).
  // `page.reload()` forces a real reload regardless of the URL/fragment
  // matching, so use that instead of reconstructing the URL.
  const hash1 = await page.evaluate(() => location.hash);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.PLAYLIST_ENGINE_MOUNTED === true, null, { timeout: 15000 });
  await page.waitForTimeout(1000);
  const roundTrip = await page.evaluate(() => ({
    hash: location.hash,
    queueIds: window.PLAYLIST_BOOT.controller.queue.map((t) => t.id),
    playing: window.PLAYLIST_BOOT.controller.state === 'playing',
  }));
  record(`${url}: hash round-trip (reload at the same hash restores the same queue, cued not playing)`,
    roundTrip.hash === hash1 && roundTrip.queueIds.length > 0 && roundTrip.playing === false,
    JSON.stringify(roundTrip));

  // 5. Saved playlist: save, reload, load it back, delete it.
  await page.evaluate(() => { window.prompt = () => 'Browser check set'; window.confirm = () => true; });
  await page.locator('#pl-save').click();
  await page.waitForTimeout(300);
  const savedKeyShape = await page.evaluate(() => {
    try {
      const v = JSON.parse(localStorage.getItem('savedPlaylists') || '[]');
      return { isArray: Array.isArray(v), hasEntry: Array.isArray(v) && v.some((p) => p.name === 'Browser check set') };
    } catch (e) { return { isArray: false, hasEntry: false }; }
  });
  record(`${url}: saved playlist persists to the flat savedPlaylists key`,
    savedKeyShape.isArray && savedKeyShape.hasEntry, JSON.stringify(savedKeyShape));

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.PLAYLIST_ENGINE_MOUNTED === true, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.confirm = () => true; });
  const loadBtn = page.locator('.pl-saved-load').first();
  await loadBtn.click();
  await page.waitForTimeout(500);
  const loadedLen = await page.evaluate(() => window.PLAYLIST_BOOT.controller.queue.length);
  record(`${url}: saved playlist loads back into the queue`, loadedLen > 0, `queueLen=${loadedLen}`);

  const deleteBtn = page.locator('.pl-saved-act[data-act="delete"]').first();
  await deleteBtn.click();
  await page.waitForTimeout(300);
  const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('savedPlaylists') || '[]').length);
  record(`${url}: saved playlist deletes`, afterDelete === 0, `remaining=${afterDelete}`);

  // 6. track-select.js's "+" buttons are still wired against the new markup.
  const addBtnCount = await page.locator('#pl-queue .track-add').count();
  record(`${url}: track-select.js's "+" buttons are present on queue rows`, addBtnCount > 0, `count=${addBtnCount}`);

  // 7. Console clean.
  record(`${url}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));

  await page.close();
}

// Song pages (Phase 3 Stage 3a-foundation of plans/dynamic-hugging-
// rossum.md): song-boot.js is unconditional on every song page now. Two
// shapes to cover: /songs/<slug>/ (every row present at load, like a show
// page) and /songs/ (rows inserted lazily per <details> — this is the
// lazy-insertion/queue-extension path that has no equivalent on any other
// page type, so it gets its own real-browser proof here rather than relying
// on scripts/test-song-boot.mjs's fake-DOM coverage alone).
async function checkSongPage(context) {
  // ── /songs/<slug>/: synchronous mount, real playback ──
  {
    const url = '/songs/a-bunch-of-thyme/';
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !KNOWN_UNRELATED_CSP_WARNING.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.PLAYER_ENGINE_MOUNTED === true, null, { timeout: 15000 });
    const mountInfo = await page.evaluate(() => ({
      hasBoot: !!window.SONG_BOOT, hasController: !!(window.SONG_BOOT && window.SONG_BOOT.controller),
      queueLen: window.SONG_BOOT && window.SONG_BOOT.controller.queue.length,
    }));
    // NOT "every occurrence queued" (what this asserted until 2026-08-16,
    // failing the first real production run of the song-page migration).
    // Per the plan's Queue-origin contract, a lazily-rendered song occurrence
    // uses playSingleton() -- mounting a row attaches a PlayerView, it does
    // NOT enqueue anything, so an un-played page correctly has an empty
    // queue. "All performances of this song" is explicitly a deliberate
    // later decision, not a side effect of mounting.
    record(`${url}: mount (flag set, controller exposed on SONG_BOOT, no eager queue -- occurrences are playSingleton())`,
      mountInfo.hasBoot && mountInfo.hasController && mountInfo.queueLen === 0, JSON.stringify(mountInfo));

    const readinessValue = await page.evaluate(() => window.PLAYBACK_HOST_READY.then((v) => v));
    record(`${url}: PLAYBACK_HOST_READY resolves controller/none`,
      readinessValue && readinessValue.mode === 'controller' && readinessValue.initialIntent === 'none',
      JSON.stringify(readinessValue));

    await page.locator('.song-occ .play-btn').first().click();
    await page.waitForTimeout(2000);
    const playback = await page.evaluate(() => {
      const c = window.SONG_BOOT.controller;
      return { t: c.audioElement.currentTime, paused: c.audioElement.paused, state: c.state, queueLen: c.queue.length };
    });
    record(`${url}: real playback (controller.audioElement actually advances), queued as a length-1 singleton`,
      playback.t > 0.3 && !playback.paused && playback.state === 'playing' && playback.queueLen === 1,
      JSON.stringify(playback));

    record(`${url}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await page.close();
  }

  // ── /songs/: lazy insertion + queue extension across two opened groups ──
  {
    const url = '/songs/';
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !KNOWN_UNRELATED_CSP_WARNING.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.PLAYER_ENGINE_MOUNTED === true, null, { timeout: 15000 });
    const zeroRowState = await page.evaluate(() => window.SONG_BOOT.controller.queue.length);
    record(`${url}: mounts with zero rows initially (no <details> opened yet) instead of refusing to claim the page`,
      zeroRowState === 0, `queueLen=${zeroRowState}`);

    // Open two DIFFERENT song entries and confirm both groups' rows mount
    // onto the SAME controller instance -- the behavior
    // scripts/test-song-boot.mjs's mountRows() tests prove against a fake
    // DOM; this is the real-<details> real-fetch proof.
    //
    // "Shared" here means the controller/audio element, NOT the queue (this
    // asserted a growing shared queue until 2026-08-16, which contradicted
    // song-boot.js's own documented queue-origin contract and failed the
    // first real production run). Identity is proven by tagging the
    // controller object before the second group opens and finding the tag
    // still there afterward -- a fresh per-song controller would lose it.
    const details = page.locator('.song-item summary');
    await details.nth(0).click();
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.SONG_BOOT.controller.__sharedInstanceProbe = 'tagged-after-first-open'; });
    const rowsAfterFirst = await page.locator('.song-occ .play-btn').count();
    await details.nth(1).click();
    await page.waitForTimeout(500);
    const rowsAfterSecond = await page.locator('.song-occ .play-btn').count();
    const sameInstance = await page.evaluate(() =>
      window.SONG_BOOT.controller.__sharedInstanceProbe === 'tagged-after-first-open');
    record(`${url}: opening a second song entry mounts its rows onto the SAME controller instance, not a fresh one per song`,
      rowsAfterFirst > 0 && rowsAfterSecond > rowsAfterFirst && sameInstance,
      `rows1=${rowsAfterFirst} rows2=${rowsAfterSecond} sameInstance=${sameInstance}`);

    // Play a row from the SECOND opened group specifically -- proves a
    // lazily-inserted row from a later batch really plays, and that it
    // replaces rather than extends (playSingleton()'s length-1 queue).
    await page.locator('.song-occ .play-btn').last().click();
    await page.waitForTimeout(2000);
    const playback = await page.evaluate(() => {
      const c = window.SONG_BOOT.controller;
      return { t: c.audioElement.currentTime, paused: c.audioElement.paused, queueLen: c.queue.length };
    });
    record(`${url}: real playback from a lazily-inserted row, replacing rather than extending (length-1 queue)`,
      playback.t > 0.3 && !playback.paused && playback.queueLen === 1, JSON.stringify(playback));

    record(`${url}: no console errors`, consoleErrors.length === 0, consoleErrors.join(' | '));
    await page.close();
  }
}

async function runBreakageTests(browser, copyDir, base) {
  // Test A: player-boot.js missing -> full legacy fallback.
  {
    const path = join(copyDir, 'assets', 'player-boot.js');
    renameSync(path, path + '.disabled');
    try {
      const testCtx = await browser.newContext(); // fresh cache partition -- see header note
      const page = await testCtx.newPage();
      // A3 needs to prove NO engine plays anything for a track-row click --
      // including a hypothetical regression that starts a DETACHED Audio()
      // (invisible to findAudioDeep(), which only walks the DOM -- see its
      // header comment). A play()-spy installed before any page script runs
      // catches that case too; findAudioDeep alone would not (Step 5c
      // review finding #1).
      await page.addInitScript(() => {
        window.__playCallCount = 0;
        const origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
          window.__playCallCount++;
          return origPlay.apply(this, args);
        };
      });
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

      const playCallsBeforeA3 = await page.evaluate(() => window.__playCallCount);
      await page.locator('#track-1 .play-btn').click();
      await page.waitForTimeout(2000);
      const waveformPlaying = await page.evaluate(`(() => {
        ${findAudioDeepFn}
        const audios = findAudioDeep(document.body).filter(a => !a.paused);
        return audios.length ? { found: true, t: audios[0].currentTime, paused: audios[0].paused } : { found: false };
      })()`);
      const playCallsAfterA3 = await page.evaluate(() => window.__playCallCount);
      record('breakage A3: with wavesurfer.js removed, waveform track rows have no driving engine (expected — player.js alone is the fallback)',
        waveformPlaying.found === false && playCallsAfterA3 === playCallsBeforeA3,
        `${JSON.stringify(waveformPlaying)} playCalls=${playCallsBeforeA3}->${playCallsAfterA3}`);

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

  // Test C (Phase 3 Stage 3a-foundation): song-boot.js missing -> a song
  // detail page falls back to the retained initCustomPlayers() engine,
  // exactly the same handshake shape as Test A above (player-boot.js
  // missing on a show page), just the song-page counterpart.
  {
    const path = join(copyDir, 'assets', 'song-boot.js');
    renameSync(path, path + '.disabled');
    try {
      const testCtx = await browser.newContext();
      const page = await testCtx.newPage();
      await page.goto(base + '/songs/a-bunch-of-thyme/', { waitUntil: 'load' });
      await page.waitForTimeout(1000);

      const flagState = await page.evaluate(() => ({ flag: window.PLAYER_ENGINE_MOUNTED, hasBoot: !!window.SONG_BOOT }));
      record('breakage C1: missing song-boot.js never sets the mounted flag',
        flagState.flag === undefined && !flagState.hasBoot, JSON.stringify(flagState));

      // page.evaluate() can't hand back a Promise object itself across the
      // context boundary (it doesn't structured-clone) -- await it INSIDE
      // evaluate() and hand back the resolved value instead.
      const readinessValue = await page.evaluate(() => window.PLAYBACK_HOST_READY.then((v) => v));
      record('breakage C2: PLAYBACK_HOST_READY resolves to legacy mode, not left hanging',
        readinessValue && readinessValue.mode === 'legacy', JSON.stringify(readinessValue));

      await page.locator('.song-occ .play-btn').first().click();
      await page.waitForTimeout(2000);
      const occPlaying = await page.evaluate(() => {
        const el = document.querySelector('.song-occ .custom-player');
        return el && el._audio ? { found: true, t: el._audio.currentTime, paused: el._audio.paused } : { found: false };
      });
      record('breakage C3: legacy player.js drives the occurrence row (initCustomPlayers fallback)',
        occPlaying.found && occPlaying.t > 0.3 && !occPlaying.paused, JSON.stringify(occPlaying));

      await testCtx.close();
    } finally {
      renameSync(path + '.disabled', path);
    }
  }

  // Test D (implementation review finding #8, 2026-08-15): playlist-boot.js
  // missing. Unlike Tests A-C, /playlist/ has no fallback engine to hand off
  // to (legacy playlist.js was deleted in Stage 2c) -- the required behavior
  // is narrower but still real: the module tag's onerror= handler
  // (build_playlist()'s `playback_ready_onerror('none')`, pages.py) must
  // resolve window.PLAYBACK_HOST_READY to {mode:'none'} itself, rather than
  // leaving it pending forever with nothing else around to ever settle it.
  // A future mini-player consumer would otherwise hang waiting to learn
  // whether it's safe to construct its own controller. Once that consumer
  // exists, extend this test to the required exactly-one-controller
  // assertion (round 4's disposition, player-consolidation-codex.md).
  {
    const path = join(copyDir, 'assets', 'playlist-boot.js');
    renameSync(path, path + '.disabled');
    try {
      const testCtx = await browser.newContext();
      const page = await testCtx.newPage();
      await page.goto(base + '/playlist/', { waitUntil: 'load' });
      await page.waitForTimeout(1000);

      const flagState = await page.evaluate(() => ({ flag: window.PLAYLIST_ENGINE_MOUNTED, hasBoot: !!window.PLAYLIST_BOOT }));
      record('breakage D1: missing playlist-boot.js never sets the mounted flag',
        flagState.flag === undefined && !flagState.hasBoot, JSON.stringify(flagState));

      // Raced against an in-page timeout so a REGRESSION (readiness left
      // hanging) fails this assertion cleanly instead of hanging the whole
      // script -- page.evaluate() would otherwise wait indefinitely for a
      // promise that never settles.
      const readinessValue = await page.evaluate(() => {
        const timedOut = new Promise((resolve) => setTimeout(() => resolve({ mode: '__timed_out__' }), 5000));
        return Promise.race([window.PLAYBACK_HOST_READY, timedOut]);
      });
      record('breakage D2: PLAYBACK_HOST_READY resolves to {mode:"none"} via the script tag\'s onerror=, not left hanging',
        readinessValue && readinessValue.mode === 'none', JSON.stringify(readinessValue));

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

// ── loudness variant (CLAUDE.md, "The -14 loud variant") ────────────────────
// Added 2026-08-19, after the first full --prod sweep passed 184/185 while
// covering NONE of this: the sweep predates the rollout, so the newest and
// most user-facing change on the site -- Loud as the sticky default across
// every player surface -- was verified only by hand, once, and by nothing
// repeatable.
//
// The load-bearing assertion here is #2. `data-src` in the markup must stay
// the ARCHIVE url on every row, with the variant riding in `data-item`'s
// loudUrl, so a page whose module fails to mount degrades to the master
// rather than to a key that may not exist. That invariant is invisible to
// every other check in this file and would break silently.
async function checkVariantPreference(context) {
  const showUrl = (ALL_SHOWS.find((s) => s.slug === HEAVY_CHECK_SLUGS[0]) || ALL_SHOWS[0]).url;
  const page = await context.newPage();
  await page.goto(BASE + showUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.PLAYER_ENGINE_MOUNTED === true, null, { timeout: 15000 });

  // 1. A fresh profile defaults to loud WITHOUT writing anything: the default
  //    is a coercion of the absent value, not a stored preference. If it ever
  //    starts persisting on load, a later change of default silently would
  //    not reach anyone who had merely visited.
  const initial = await page.evaluate(() => ({
    variant: window.HannanVariant ? window.HannanVariant.get() : null,
    stored: localStorage.getItem('hannanVariant'),
    loud: document.querySelector('.variant-btn[data-variant="loud"]')?.getAttribute('aria-pressed'),
    archive: document.querySelector('.variant-btn[data-variant="archive"]')?.getAttribute('aria-pressed'),
  }));
  record('variant: fresh profile defaults to loud, with nothing persisted',
    initial.variant === 'loud' && initial.stored === null,
    JSON.stringify(initial));
  record('variant: the toggle reflects the active variant on load',
    initial.loud === 'true' && initial.archive === 'false',
    `loud=${initial.loud} archive=${initial.archive}`);

  // 2. THE INVARIANT. Markup carries the archive url; loud rides in data-item.
  const markup = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-src]'));
    const items = Array.from(document.querySelectorAll('.track-list [data-item]'));
    const parse = (el) => { try { return JSON.parse(el.getAttribute('data-item')); } catch (_) { return null; } };
    return {
      rows: rows.length,
      loudInMarkup: rows.filter((r) => (r.getAttribute('data-src') || '').includes('MP3-14/')).length,
      tracks: items.length,
      withLoudUrl: items.map(parse).filter((i) => i && i.loudUrl && i.loudUrl.includes('MP3-14/')).length,
      cards: document.querySelectorAll('.recording-item[data-item]').length,
      cardsWithLoudUrl: Array.from(document.querySelectorAll('.recording-item[data-item]'))
        .map(parse).filter((i) => i && i.loudUrl).length,
    };
  });
  record('variant: data-src stays the ARCHIVE url on every row (degrades to the master)',
    markup.rows > 0 && markup.loudInMarkup === 0,
    `rows=${markup.rows} carrying MP3-14=${markup.loudInMarkup}`);
  record('variant: every track row carries a loudUrl in data-item',
    markup.tracks > 0 && markup.withLoudUrl === markup.tracks,
    `tracks=${markup.tracks} withLoudUrl=${markup.withLoudUrl}`);
  // Whole-show recordings have no -14 render at all and must never claim one.
  record('variant: whole-show recording cards carry no loudUrl (no -14 render exists)',
    markup.cardsWithLoudUrl === 0,
    `cards=${markup.cards} withLoudUrl=${markup.cardsWithLoudUrl}`);

  // 3. What actually goes over the wire under the default.
  const playAndReadSrc = async () => {
    await page.locator('.track-list [data-item]').first().locator('.play-btn').click();
    try {
      await page.waitForFunction(() => {
        const c = window.PLAYER_BOOT && window.PLAYER_BOOT.controller;
        return !!c && c.audioElement.currentTime > 0.3 && !c.audioElement.paused;
      }, null, { timeout: 15000 });
    } catch (_) { /* reported by the record() that follows */ }
    return page.evaluate(() => {
      const c = window.PLAYER_BOOT.controller;
      return { src: c.audioElement.currentSrc, t: c.audioElement.currentTime, paused: c.audioElement.paused };
    });
  };
  const loudPlay = await playAndReadSrc();
  record('variant: default playback actually streams the -14 loud render',
    loudPlay.src.includes('MP3-14/') && loudPlay.t > 0.3 && !loudPlay.paused,
    `t=${loudPlay.t.toFixed(2)} src=${decodeURIComponent(loudPlay.src).slice(-60)}`);
  await page.evaluate(() => window.PLAYER_BOOT.controller.stop());

  // 4. Switching to Archive updates both buttons and persists.
  await page.locator('.variant-btn[data-variant="archive"]').click();
  await page.waitForTimeout(300);
  const afterToggle = await page.evaluate(() => ({
    variant: window.HannanVariant.get(),
    stored: localStorage.getItem('hannanVariant'),
    loud: document.querySelector('.variant-btn[data-variant="loud"]')?.getAttribute('aria-pressed'),
    archive: document.querySelector('.variant-btn[data-variant="archive"]')?.getAttribute('aria-pressed'),
  }));
  record('variant: choosing Archive flips both buttons and persists the choice',
    afterToggle.variant === 'archive' && afterToggle.stored === 'archive'
      && afterToggle.archive === 'true' && afterToggle.loud === 'false',
    JSON.stringify(afterToggle));

  // 5. And that choice is what streams.
  const archivePlay = await playAndReadSrc();
  record('variant: after choosing Archive, playback streams the -20 master',
    archivePlay.src.includes('MP3/') && !archivePlay.src.includes('MP3-14/')
      && archivePlay.t > 0.3 && !archivePlay.paused,
    `t=${archivePlay.t.toFixed(2)} src=${decodeURIComponent(archivePlay.src).slice(-60)}`);
  await page.evaluate(() => window.PLAYER_BOOT.controller.stop());

  // 6. Sticky across a reload -- the whole point of storing it.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.PLAYER_ENGINE_MOUNTED === true, null, { timeout: 15000 });
  const afterReload = await page.evaluate(() => ({
    variant: window.HannanVariant.get(),
    archive: document.querySelector('.variant-btn[data-variant="archive"]')?.getAttribute('aria-pressed'),
  }));
  record('variant: the choice survives a reload',
    afterReload.variant === 'archive' && afterReload.archive === 'true',
    JSON.stringify(afterReload));

  // 7. A corrupt stored value must fall back to the default, never reach a
  //    URL lookup -- stored state is untrusted input (variant-pref.js).
  await page.evaluate(() => localStorage.setItem('hannanVariant', 'loudest'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.PLAYER_ENGINE_MOUNTED === true, null, { timeout: 15000 });
  const coerced = await page.evaluate(() => window.HannanVariant.get());
  record('variant: an unrecognised stored value falls back to the default',
    coerced === 'loud', `got=${coerced}`);

  await page.close();
}

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

// These non-show, non-song pages are deliberately narrow and fixed -- this
// confirms the deploy didn't leak the controller engine onto pages that were
// never switched over, and that real legacy playback still works on the
// pages that matter most for that regression. Song pages moved OFF this list
// in Phase 3 Stage 3a-foundation -- they now run song-boot.js's controller
// engine unconditionally (see checkSongPage() below for their own mount/
// playback/fallback checks), so asserting PLAYER_ENGINE_MOUNTED===false
// there would now be asserting the wrong thing. These 3 are structurally
// permanent regardless of how wide CONTROLLER_ENGINE_SLUGS eventually grows
// -- the non-allowlisted SHOW page is a separate, dynamically-picked entry,
// below.
const NON_ALLOWLISTED_PAGES = [
  '/',
  '/playlist/',
  '/player/',
];

// Picks a real, currently-non-allowlisted show page to sample, instead of a
// hardcoded path -- a hardcoded page would silently become WRONG (allowlisted,
// asserting the opposite of reality, with no self-detection) the moment a
// future step widens CONTROLLER_ENGINE_SLUGS to include it. Reuses ALL_SHOWS
// (the full catalog fetched once from home-shows.json in the run section --
// see fetchAllShowUrls()) as the candidate pool, and EXCLUDED_SLUGS (fetched
// from assets/controller-excluded-slugs.json in the same place) as the
// actual non-allowlisted set -- CONTROLLER_ENGINE_SLUGS is every public show
// minus CONTROLLER_ENGINE_EXCLUDED_SLUGS, so a show is genuinely
// non-allowlisted exactly when its slug is in EXCLUDED_SLUGS. Since that set
// is currently empty this still returns null today -- callers must handle
// that by skipping the show-page sub-check, not by asserting on a made-up
// path -- but the moment a show is actually excluded, this correctly finds
// and verifies it instead of only ever hitting the "everyone's allowlisted"
// skip path.
function pickNonAllowlistedShowPage() {
  const excludedSlugSet = new Set(EXCLUDED_SLUGS);
  const candidate = ALL_SHOWS.find((s) => excludedSlugSet.has(s.slug));
  return candidate ? candidate.url : null;
}

async function checkNonAllowlistedPagesUnaffected(context) {
  const nonAllowlistedShowUrl = pickNonAllowlistedShowPage();
  if (nonAllowlistedShowUrl) {
    console.log(`    (using ${nonAllowlistedShowUrl} as the non-allowlisted show-page sample)`);
  } else {
    console.log('    (every published show is currently allowlisted -- skipping the non-allowlisted show-page sub-checks)');
  }
  const pagesToCheck = nonAllowlistedShowUrl
    ? [...NON_ALLOWLISTED_PAGES, nonAllowlistedShowUrl]
    : NON_ALLOWLISTED_PAGES;

  for (const path of pagesToCheck) {
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
  if (nonAllowlistedShowUrl) {
    const page = await context.newPage();
    await page.goto(BASE + nonAllowlistedShowUrl, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.locator('.recording-item .play-btn').first().click();
    await page.waitForTimeout(2000);
    const heroPlaying = await page.evaluate(() => {
      const el = document.querySelector('.recording-item .custom-player');
      return el && el._audio ? { found: true, t: el._audio.currentTime, paused: el._audio.paused } : { found: false };
    });
    record(`${nonAllowlistedShowUrl} real legacy playback works (Full Recording card)`,
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
    // POLL for the display to advance rather than sleeping a fixed 2.5 s and
    // reading once. Startup latency against production is ~0.8-1.3 s, so a
    // 2.5 s sleep passed with barely a second of margin and produced exactly
    // one spurious FAIL (time=0:00) on the first full --prod sweep, on a
    // context loaded late in the run -- the site was fine, reproduced 4/4
    // clean immediately after. A fixed sleep asserts "fast enough", which is
    // not the property under test; "does it play at all" is.
    let timeText = '';
    try {
      await page.waitForFunction(() => {
        const el = document.querySelector('#pl-now .pl-time-current');
        const t = (el && el.textContent || '').trim();
        return t !== '' && t !== '0:00';
      }, null, { timeout: 15000 });
    } catch (_) { /* leave timeText empty -- the record() below reports it */ }
    timeText = (await page.locator('#pl-now .pl-time-current').textContent().catch(() => null) || '').trim();
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
  // First HEAVY_CHECK_SLUGS entry, not whatever happens to sort first in
  // home-shows.json -- a deliberately-interesting page (waveform rows + a
  // Full Recording card), same target used for the equivalent Chromium
  // heavy checks in runParityPass.
  const targetUrl = ALL_SHOWS.find((s) => s.slug === HEAVY_CHECK_SLUGS[0]).url;
  const browser = await webkit.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  await page.goto(BASE + targetUrl, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const mounted = await page.evaluate(() => ({ flag: window.PLAYER_ENGINE_MOUNTED, hasBoot: !!window.PLAYER_BOOT }));
  record('WebKit: controller mounts', mounted.flag === true && mounted.hasBoot, JSON.stringify(mounted));
  const realErrors = consoleErrors.filter((e) => !KNOWN_UNRELATED_CSP_WARNING.test(e));
  record('WebKit: no console errors on load', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
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
  // Fetch the full show catalog once, early -- works identically whether
  // BASE is the local server or production, no special-casing needed. Uses
  // a throwaway context.request (not a page navigation) purely to issue the
  // HTTP GET; runParityPass opens its own context for the actual pages.
  {
    const preflightCtx = await browser.newContext();
    await fetchAllShowUrls(preflightCtx);
    await preflightCtx.close();
  }

  await runParityPass(browser, ALL_SHOWS, HEAVY_CHECK_SLUGS);

  // /playlist/ (plans/player-consolidation/ Phase 2). Runs unconditionally
  // (both local and --prod), same BASE either way.
  {
    const plCtx = await browser.newContext();
    await checkPlaylistPage(plCtx);
    await plCtx.close();
  }

  // Song pages (Phase 3 Stage 3a-foundation). Runs unconditionally, same as
  // /playlist/ above -- song-boot.js is on every song page regardless of
  // local/--prod.
  {
    const songCtx = await browser.newContext();
    await checkSongPage(songCtx);
    await songCtx.close();
  }

  // Loudness variant. Needs its OWN context: check #1 asserts a FRESH profile
  // defaults to loud with nothing persisted, which any earlier context that
  // touched the toggle would invalidate.
  {
    const variantCtx = await browser.newContext();
    await checkVariantPreference(variantCtx);
    await variantCtx.close();
  }

  if (isRemote) {
    const ctx = await browser.newContext();
    await checkAssetHeaders(ctx);
    await checkNonAllowlistedPagesUnaffected(ctx);
    await ctx.close();
  } else {
    // Isolated copy for the breakage tests -- assets/+shows/+playlist/+songs/
    // (the show-page breakage scenarios' assets, plus /playlist/'s and
    // /songs/'s own markup for Tests C and D below), on a SEPARATE port, so
    // this script never renames a file inside the real working tree.
    //
    // songs/ was MISSING from this list until 2026-08-16, and the symptom is
    // worth recording because it was silent in one direction and fatal in the
    // other: Test C1 navigates to /songs/<slug>/ and asserts two window flags
    // are absent, which a 404 page satisfies perfectly, so it passed
    // vacuously; C2 then dereferenced window.PLAYBACK_HOST_READY on that same
    // 404 page and took the whole run down with an uncaught TypeError. A
    // check that navigates somewhere must be given somewhere to navigate to.
    //
    // /playlist/ has no FALLBACK ENGINE to test (legacy playlist.js is gone
    // as of Stage 2c -- see plans/player-consolidation/) — that Stage-2c-era
    // reasoning is still correct for what it originally addressed. It does
    // NOT mean there's nothing left to test here, though (Phase 3 Stage
    // 3a-foundation implementation review finding #8, 2026-08-15): the
    // readiness contract added since then requires the module tag's onerror=
    // handler to actually resolve window.PLAYBACK_HOST_READY to
    // {mode:'none'} rather than leaving it pending forever, which is a real,
    // independently-testable behavior a missing playlist-boot.js exercises —
    // see Test D.
    const copyDir = mkdtempSync(join(tmpdir(), 'player-consolidation-browser-check-'));
    cpSync(join(ROOT, 'assets'), join(copyDir, 'assets'), { recursive: true });
    cpSync(join(ROOT, 'shows'), join(copyDir, 'shows'), { recursive: true });
    cpSync(join(ROOT, 'playlist'), join(copyDir, 'playlist'), { recursive: true });
    cpSync(join(ROOT, 'songs'), join(copyDir, 'songs'), { recursive: true });
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
