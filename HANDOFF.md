# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-14 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

Working tree has uncommitted changes, **nothing committed, nothing pushed,
nothing deployed**. Merged `origin/main` earlier this session (one conflict,
in `HANDOFF.md` itself — resolved in favour of this branch's handoff).

**Phase 1 Step 4 is done, including its browser pass.** Three show pages run
the new player engine in the *built* output; the live site is still entirely
on the legacy engines, because none of this has been pushed.

## ✅ Done this session — Phase 1 Step 4, start to finish

Plan: `plans/player-consolidation/player-consolidation-plan.md` (Step 4's
entry has the full record — architecture, all corrections, and the browser
pass results). Steps 1–3 were an earlier session's.

### The implementation

**Engine selection: legacy defers, controller claims.** An allowlisted show
page emits `window.PLAYER_ENGINE = 'controller'` inline before `player.js`.
Both legacy engines hold their playback init until `DOMContentLoaded` and
check `window.PLAYER_ENGINE_MOUNTED`; `player-boot.js` is a module, so it runs
first, mounts inside `try`/`catch`, and sets that flag only on success. A 404,
a parse error, or any boot exception falls back to today's working player at
*runtime*, not just at deploy time — confirmed for real this session (below).

- **`scripts/player-boot.js`** mounts one `PlaybackController`,
  `CompactPlayerView` per `.track-list [data-item]` row, `HeroPlayerView` per
  `.recording-item[data-item]`, wires peaks/Space/deep-links/resize, and
  refuses to claim a page where it mounted nothing.
- **`wavesurfer.js` is gated too**, not just `player.js` — every show-page
  track row is `.ws-track`, invisible to `player.js`'s `.custom-player`-only
  `initCustomPlayers`, so gating just `player.js` would leave waveform rows
  dead on any boot failure.
- **Allowlist** `pages.CONTROLLER_ENGINE_SLUGS`: `jerry-cafe-java-1999-05-27`,
  `jerry-cafe-java-1999-03-25` (two hero cards), `mad-sweetwater-2000-10-17`
  (alternate transfer sharing a stream proxy).
- **`verify_markup.py`** checks the whole engine handshake (flag/boot travel
  together, only on allowlisted slugs, ordering vs. `player.js`), every
  `.track-row`/`.recording-item` element has a valid `data-item` (not just
  validating whichever attributes happen to be present), and every `/assets/`
  script a page loads — plus everything those scripts import, including
  dynamic `import()` — is actually written by `build.py`.

### The seventh Codex review, and its fixes

A review ran during a usage-interrupted pause in this session (focused on the
built Step 4 code, not just the plan). All six findings confirmed on
independent verification and fixed, each with a regression test proven to
fail without the fix:

1. **High — a destroyed controller could be reactivated** by a leaked
   document/window listener `player-boot.js` never removed. Fixed: a
   `_destroyed` guard on every mutating `PlaybackController` method, plus one
   shared `AbortController` in `player-boot.js` so `handle.destroy()`
   actually removes what it installed. Both halves proven independently
   necessary (reverting either alone left a different subset of tests
   failing).
2. **Medium — a missing `data-item` would pass silently.** Fixed:
   `verify_markup.py` now enumerates elements, not just attributes it finds.
3. **Medium — "falls back to the complete legacy engine pair" overclaimed
   one case.** `wavesurfer.js` and `player-views.js` share one vendored
   dependency (`wavesurfer.esm.js`); if THAT fails, both waveform engines die
   together. Not new fragility — always true, on every page, before this
   phase existed — just a claim that needed the exception carved out.
   Corrected everywhere it appeared.
4. **Medium — two real test-coverage gaps**, both closed: `setPeaks()` now
   has a test asserting it actually draws/upgrades, not just stores the
   value; `player.js`'s real source (not a reimplementation) is now loaded
   and executed in two tests proving its gate both suppresses and allows
   legacy init correctly.
5. **Low — the asset-import checker missed dynamic `import()`.** Fixed,
   confirmed against the real, previously-invisible `client-zip.js` case.
6. **Low — imprecise timing-guarantee wording.** Corrected in code comments
   and the plan.

Test suite grew from 51 to 60 (`test-player-controller.mjs` 22,
`test-player-views.mjs` 16, `test-player-boot.mjs` 22), plus five
documentation-drift issues Codex's review separately flagged (a stale
missing-peaks contradiction, stale "hides prev/next" language describing a
mechanism that doesn't exist, a stale `/review-step` description, two stale
test counts) — all fixed. Step 5 was also restructured into an explicit
5a/5b/5c sequence per that review's recommendation (deploy-and-verify the
canary on production *before* expanding it; expand the allowlist and delete
the legacy fallback as two separate decisions, not one step).

### The browser pass — done for real, not just reasoned about

No browser existed in the environment for most of this session. One turned
out to be reachable later via `playwright-chromium`/`playwright-webkit`
(globally installed, not a project dependency this repo carries). Built a
permanent, reproducible, checked-in harness:

**`scripts/browser_check.mjs`** — dev-only (same status as
`test-player-*.mjs`, not wired into `build.py` or any deploy gate). Run with:
```
python3 scripts/build.py   # make sure shows/ is current
NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs
```
Serves the real repo locally and drives real Chromium against it — real
production audio (`streamUrl` points at the live worker, nothing mocked),
real `WaveSurfer` rendering, real `BroadcastChannel` delivery. The two
breakage tests copy `assets/`+`shows/` into a temp directory and manipulate
the copy, so the script never touches the working tree.

**38/38 passed.** Controller mounts and legacy stays dormant on all three
allowlisted pages; real playback actually advances and responds to
toggle/seek/Space; a real `WaveSurfer` canvas renders; the Hero → track →
next round trip works with real audio at each step; the
`mad-sweetwater-2000-10-17` alternate-transfer case shows only one card
active at a time; real cross-tab claim/pause between a show page and
`/playlist/`; both breakage scenarios confirmed with real playing audio
(player-boot.js missing → full fallback; wavesurfer.esm.js missing → Full
Recording works, waveform rows correctly dead in both engines). A WebKit
smoke pass (mount, real click-gesture playback, canvas render) also passed,
run separately since `playwright-webkit` isn't reliably available via a
plain global install.

**Deep-link autoplay is policy-dependent — described that way, not as a pass
or fail.** `?autoplay=1#track-N` reliably queues the right track and
highlights the right row. Whether the browser actually starts playback on
arrival depends on Media Engagement, which a fresh session has none of —
Chromium blocked it here, confirmed identical against the legacy engine
(not a regression). What's actually asserted: the controller surfaces this
as a visible `'error'` state with a "Retry `<track>`"-labeled button and a
`role="status"` message, and **a real user-gesture click on Retry
successfully starts playback** — confirmed directly.

**Not covered, still needs real hardware:** actual Firefox, actual
iOS/Android devices (WebKit-the-engine approximates but isn't identical to
Safari, especially for mobile autoplay/backgrounding). And this was all
against the **local** build — production-origin verification (real caching,
real headers, the real deployed Worker) is Step 5's 5a, still outstanding.

## 🔧 Next up

**Step 5, sub-step 5a**: deploy the existing 3-page allowlist as-is (no
widening, no deletions) and verify it on the production origin — this is the
first time the canary actually does canary duty, since it's never been
deployed. See the plan's Step 5 entry for the full 5a/5b/5c sequence and why
it's split that way.

Before that: review and decide whether to commit/push what's sitting
uncommitted in this worktree right now (all of Step 4 + the seventh review's
fixes + the browser pass + this handoff).

## Gotchas learned this session

- **`document.readyState` is not a shortcut for the DOMContentLoaded
  barrier.** Already `'interactive'` while deferred/module scripts run, so a
  "past loading, just go" branch would fire the legacy engine before a later
  module could claim the page.
- **A mutation test can be vacuous** — the partial-mount teardown test passed
  with the teardown deleted until its malformed item moved from a row (always
  normalized before anything mounts) to a hero card (mounted after).
- **`browser.newPage()` creates an isolated context per call** (its own
  storage/cache partition) — silently breaks `BroadcastChannel` between what
  look like tabs, and serves stale cached responses across what looks like a
  fresh load after a file changed on disk. Use one explicit, shared
  `browser.newContext()` per scenario; a fresh one specifically when a file
  on disk just changed and the next load must not see a cached response.
- **WaveSurfer.js v7 renders into a Shadow DOM by default** — Playwright
  locators pierce it automatically, raw `document.querySelectorAll()` inside
  `page.evaluate()` does not.

## Durable facts (don't undo)

- **`downloads.lossless` carries an R2 key, not a URL.** `/stream` hard-403s
  every `.wav`/`.flac`. Named `lossless`, not `flac` — 64 of 747 items are WAV.
- **Recording ids key on the lossless original**, not the stream key, which is
  not unique across transfers of one tape.
- **No BroadcastChannel wire-format change until `/playlist/` and `/player/`
  migrate** — the legacy engines still expect a bare string; cross-tab
  claim/pause between old and new pages is real, confirmed behavior.
- **Deep-link autoplay fires on initial load only**, deliberately — exact
  parity with the two legacy engines. Whether it actually plays depends on
  browser autoplay policy, not app logic (see above).
- **A `wavesurfer.esm.js` failure kills waveform rows in BOTH engines** — it's
  the one dependency `wavesurfer.js` and `player-views.js` share. Not new,
  not a regression Step 4 introduced — true since before this initiative.
- Loudness control and sticky navigation remain **fully deferred**; see the
  plan's §2 and §5.
- Branch/worktree workflow is the plan's §8; sync with
  `git fetch origin && git merge origin/main` at session start and before a
  PR.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Player work:
`plans/player-consolidation/` (plan + `player-consolidation-codex.md`, seven
review passes with dispositions). Review loop: plan §7. Tests:
`node scripts/test-player-{controller,views,boot}.mjs`. Real-browser
verification: `scripts/browser_check.mjs` (needs `playwright-chromium`,
see its header for setup).
