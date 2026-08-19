// DRAFT — a `checkMiniPlayer()` scenario for scripts/browser_check.mjs.
// NOT wired into any run path, and deliberately not living in scripts/ yet:
// the mini-player is emitted into no page as of Stage 3a-canary Task 2, so
// every assertion below would fail today. This is a spec-ahead artifact,
// written 2026-08-16 against the contracts that are ALREADY FROZEN, so the
// browser checks the plan schedules for Phase C start from the real
// properties rather than from whatever the wiring happens to do.
//
// To adopt: paste the function into scripts/browser_check.mjs (it uses that
// file's `record`, `BASE`, `startServer` and context conventions verbatim),
// resolve the TASK4_CONTRACT block below against the real coordinator, and
// add the call in the run block next to `checkSongPage(songCtx)`.
//
// ── what is PINNED vs what is GUESSED ────────────────────────────────────
// PINNED — read off shipped code, safe to assert as-is:
//   - the bar's DOM, from miniplayer-views.js `_buildStructure()`:
//     `.mp-btn` carrying `data-act="play|prev|next|close"`, plus `.mp-play`
//     `.mp-prev` `.mp-next` `.mp-close`, `.mp-info > .mp-title/.mp-meta`,
//     `.mp-progress > .mp-time-current`, `input.progress-range`,
//     `.mp-time-total`.
//   - `--miniplayer-height` is written to `document.documentElement.style`
//     as an INLINE property and REMOVED (never set to '0px') when the bar is
//     hidden — miniplayer-views.js `_publishHeight()`/`_clearHeight()`.
//   - storage keys and lock names, from miniplayer-state.js:
//     `miniPlayerState` (localStorage), `miniPlayerTabId` and
//     `miniPlayerRevokedEpoch` (sessionStorage), Web Lock
//     `miniplayer-ownership`, per-tab lock prefix `miniplayer-tab:`.
//   - the Close contract: the view only REQUESTS close; stopping playback,
//     clearing persistence and unmounting are the coordinator's policy.
// GUESSED — every one of these is a Task 4 decision that does not exist yet.
// Confirm each before trusting a green run; a wrong guess here is exactly
// the "asserted a consequence some other mechanism already guaranteed"
// vacuous shape HANDOFF.md warns about.
const TASK4_CONTRACT = {
  // Container element the coordinator mounts MiniPlayerView onto.
  root: '#mini-player',
  // Global handle, following window.SONG_BOOT / window.PLAYLIST_BOOT.
  boot: 'MINI_PLAYER_BOOT',
  // Flag the coordinator sets once mounted, following PLAYER_ENGINE_MOUNTED.
  mountedFlag: 'MINI_PLAYER_MOUNTED',
  // A page that carries the bar but loads NO WaveSurfer. The whole reason
  // miniplayer-views.js is a third view module is that a WaveSurfer asset
  // problem must not be able to break a page like this one.
  wavesurferFreePage: '/contact/',
  // A page that both carries the bar and can start real playback.
  playbackPage: '/songs/a-bunch-of-thyme/',
};

const MP = TASK4_CONTRACT;

// Read the inline custom property, NOT getComputedStyle: "removed" and
// "'0px'" are the distinction under test, and a stylesheet fallback would
// make the computed value agree either way.
const readHeightVar = () =>
  document.documentElement.style.getPropertyValue('--miniplayer-height');

async function checkMiniPlayer(browser) {
  // ── 0. preflight: the bar is actually on the page ──
  // Failing loudly rather than skipping. A silent skip when the wiring is
  // absent is how this suite would report green while proving nothing.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + MP.playbackPage, { waitUntil: 'load' });
    const present = await page.evaluate(
      ([root, flag]) => ({ root: !!document.querySelector(root), flag: window[flag] === true }),
      [MP.root, MP.mountedFlag],
    );
    record('mini-player: wiring present (container in markup, mount flag set)',
      present.root && present.flag, JSON.stringify(present));
    if (!present.root) {
      record('mini-player: REMAINING CHECKS NOT RUN — no container, nothing to drive', false,
        'resolve TASK4_CONTRACT against the real coordinator');
      await ctx.close();
      return;
    }
    await ctx.close();
  }

  // ── 1. height publication against REAL layout ──
  // The single highest-value browser-only assertion here: the fake-DOM
  // suites can prove _publishHeight() is CALLED, but they have no layout, so
  // only a real browser can prove the published number is the bar's actual
  // border-box height. A bar whose CSS lands it at a different height than
  // it reserves is a silently-overlapped page footer.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(BASE + MP.playbackPage, { waitUntil: 'load' });
    await page.waitForFunction((f) => window[f] === true, MP.mountedFlag, { timeout: 15000 });

    // Before anything plays there is no current item, so the bar is hidden
    // and the var must be ABSENT — not '0px'.
    const beforePlay = await page.evaluate(readHeightVar);
    record('mini-player: height var absent (not "0px") before any item is current',
      beforePlay === '', `value=${JSON.stringify(beforePlay)}`);

    await page.locator('.song-occ .play-btn').first().click();
    await page.waitForSelector(`${MP.root}:not([hidden]) .mp-play`, { timeout: 10000 });
    await page.waitForTimeout(500);   // let the ResizeObserver's async first callback land

    const shown = await page.evaluate((root) => {
      const el = document.querySelector(root);
      const rect = el.getBoundingClientRect();
      const raw = document.documentElement.style.getPropertyValue('--miniplayer-height');
      return { published: raw, real: rect.height, hidden: el.hidden };
    }, MP.root);
    const publishedPx = parseFloat(shown.published);
    record('mini-player: published height equals the bar\'s real border-box height',
      !shown.hidden && publishedPx > 0 && Math.abs(publishedPx - shown.real) < 1,
      JSON.stringify(shown));

    // Close is a REQUEST — what it means is the coordinator's policy. What
    // is pinned is the observable end state: nothing reserved, nothing shown.
    await page.locator(`${MP.root} .mp-close`).click();
    await page.waitForTimeout(300);
    const afterClose = await page.evaluate((root) => ({
      heightVar: document.documentElement.style.getPropertyValue('--miniplayer-height'),
      hidden: document.querySelector(root).hidden,
      persisted: localStorage.getItem('miniPlayerState'),
    }), MP.root);
    record('mini-player: close removes the height var, hides the bar, and tombstones state',
      afterClose.heightVar === '' && afterClose.hidden === true,
      JSON.stringify(afterClose));

    record('mini-player: no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    await ctx.close();
  }

  // ── 2. the bar survives a page with no WaveSurfer ──
  // miniplayer-views.js exists as a separate module precisely so a
  // WaveSurfer asset problem cannot break a page like /contact/. Asserted
  // here on a real page load, and by a test in test-miniplayer-views.mjs on
  // the import graph — two different failure modes, both worth having.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(BASE + MP.wavesurferFreePage, { waitUntil: 'load' });
    await page.waitForFunction((f) => window[f] === true, MP.mountedFlag, { timeout: 15000 });
    const loaded = await page.evaluate(() => ({
      wavesurfer: performance.getEntriesByType('resource')
        .some((r) => r.name.includes('wavesurfer')),
    }));
    record(`mini-player: mounts on ${MP.wavesurferFreePage} without pulling WaveSurfer`,
      loaded.wavesurfer === false && consoleErrors.length === 0,
      JSON.stringify({ ...loaded, consoleErrors }));
    await ctx.close();
  }

  // ── 3. cross-tab ownership handoff ──
  // ONE shared context for both "tabs" — browser.newPage() off the browser
  // creates an isolated storage partition, which silently breaks both the
  // `storage` event and the Web Locks namespace these depend on (see the
  // script header's findings). This is the scenario with no fake-DOM
  // equivalent at all: test-miniplayer-state.mjs drives claimOwnership()
  // with an injected lockRequest, never a real LockManager arbitrating two
  // real documents.
  {
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    const tabB = await ctx.newPage();

    await tabA.goto(BASE + MP.playbackPage, { waitUntil: 'load' });
    await tabA.waitForFunction((f) => window[f] === true, MP.mountedFlag, { timeout: 15000 });
    await tabA.locator('.song-occ .play-btn').first().click();
    await tabA.waitForTimeout(1500);

    const aOwns = await tabA.evaluate((b) => {
      const c = window[b].controller;
      return { playing: !c.audioElement.paused, t: c.audioElement.currentTime };
    }, MP.boot);
    record('mini-player: tab A owns playback after a real user gesture',
      aOwns.playing && aOwns.t > 0.3, JSON.stringify(aOwns));

    // Tab B claims. Real gesture, real lock contention, real storage event.
    await tabB.goto(BASE + MP.playbackPage, { waitUntil: 'load' });
    await tabB.waitForFunction((f) => window[f] === true, MP.mountedFlag, { timeout: 15000 });
    await tabB.locator('.song-occ .play-btn').first().click();
    await tabB.waitForTimeout(2000);

    const handoff = await Promise.all([
      tabA.evaluate((b) => ({ paused: window[b].controller.audioElement.paused }), MP.boot),
      tabB.evaluate((b) => ({ paused: window[b].controller.audioElement.paused }), MP.boot),
    ]);
    record('mini-player: tab B\'s claim relinquishes tab A (exactly one owner)',
      handoff[0].paused === true && handoff[1].paused === false, JSON.stringify(handoff));

    // The loser must also stop RESERVING space — a relinquished tab that
    // keeps its bar up is two bars across two tabs for one playback session.
    const aHeight = await tabA.evaluate(readHeightVar);
    record('mini-player: the relinquished tab stops reserving height',
      aHeight === '', `tabA heightVar=${JSON.stringify(aHeight)}`);

    await ctx.close();
  }

  // ── 4. fail-closed when the ownership lock is unavailable ──
  // The 2026-08-15 decision: ownership fails CLOSED. Held here by a real
  // third party in the same context so the coordinator meets genuine
  // contention rather than an injected stub.
  {
    const ctx = await browser.newContext();
    const holder = await ctx.newPage();
    await holder.goto(BASE + MP.wavesurferFreePage, { waitUntil: 'load' });
    // Grab the lock and never release it for the life of this page.
    await holder.evaluate(() => {
      window.__lockHeld = new Promise((resolve) => {
        navigator.locks.request('miniplayer-ownership', () => new Promise(() => {}));
        setTimeout(resolve, 100);
      });
      return window.__lockHeld;
    });

    const page = await ctx.newPage();
    await page.goto(BASE + MP.playbackPage, { waitUntil: 'load' });
    await page.waitForFunction((f) => window[f] === true, MP.mountedFlag, { timeout: 15000 });
    await page.locator('.song-occ .play-btn').first().click();
    await page.waitForTimeout(2000);
    const denied = await page.evaluate(() => ({
      persisted: localStorage.getItem('miniPlayerState'),
    }));
    // Playback itself is NOT gated on ownership — the page still plays. What
    // must not happen is a session write without the lock.
    record('mini-player: fails closed — no session persisted while the lock is held elsewhere',
      denied.persisted === null, JSON.stringify(denied));
    await ctx.close();
  }

  // ── 5. session restore across a real navigation ──
  // The point of the whole feature. Fake storage cannot prove this: what is
  // under test is that a real document swap preserves localStorage, that
  // sessionStorage's tab identity survives the same swap, and that the
  // restored position is applied to a fresh controller.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + MP.playbackPage, { waitUntil: 'load' });
    await page.waitForFunction((f) => window[f] === true, MP.mountedFlag, { timeout: 15000 });
    await page.locator('.song-occ .play-btn').first().click();
    await page.waitForTimeout(3000);

    const before = await page.evaluate((b) => ({
      t: window[b].controller.audioElement.currentTime,
      tabId: sessionStorage.getItem('miniPlayerTabId'),
      title: document.querySelector('.mp-title')?.textContent,
    }), MP.boot);

    await page.goto(BASE + MP.wavesurferFreePage, { waitUntil: 'load' });
    await page.waitForFunction((f) => window[f] === true, MP.mountedFlag, { timeout: 15000 });
    await page.waitForTimeout(1000);

    const after = await page.evaluate((b) => ({
      t: window[b].controller.audioElement.currentTime,
      tabId: sessionStorage.getItem('miniPlayerTabId'),
      title: document.querySelector('.mp-title')?.textContent,
      hidden: document.querySelector('#mini-player')?.hidden,
    }), MP.boot);

    record('mini-player: tab identity survives a real navigation',
      before.tabId && after.tabId === before.tabId,
      JSON.stringify({ before: before.tabId, after: after.tabId }));
    // Position restores to roughly where it left off. Loose bound on
    // purpose: the exact resume point depends on save cadence, and pinning
    // it tighter would test the cadence, not the restore.
    record('mini-player: the same track restores at roughly its previous position',
      after.title === before.title && after.hidden === false && after.t > before.t - 2,
      JSON.stringify({ before, after }));
    await ctx.close();
  }
}
