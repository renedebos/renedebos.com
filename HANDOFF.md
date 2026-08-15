# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-15 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

**Phase 1 (all show pages on the shared `PlaybackController`) is complete,
review-hardened, and live in production** — see git history / the plan's
Phase 1 section for that work; not repeated here.

**Phase 2 (`/playlist/` migration) is now fully complete — Stage 2c
deleted the legacy `playlist.js` engine and its `?engine=` resolver the
same day Stage 2b shipped.** Rene explicitly waived the originally-planned
2+ week soak (the only realistic blast radius is client-side
`savedPlaylists` localStorage, never audio files or server-side data) but
did NOT waive the real-browser gate — `browser_check.mjs --prod` was run
for real (not just syntax-checked, for the first time ever) after
installing `playwright-chromium` into this environment, and a genuine bug
that run surfaced was fixed before it passed clean. See "Done this
session" below and the plan doc's Phase 2 section for the full record.
**Not yet committed or pushed — this needs a review pass and Rene's
go-ahead before it ships.**

## ✅ Done this session — Phase 2, start to Stage 2c (complete)

1. **Scoped Phase 2** (Explore + Plan agents, then a Codex review of the
   design itself, verified line-by-line before folding into the plan —
   commit `a2f3e19`). Corrected 5 real defects in the first-draft design
   (queue-change detection, hash-length bound, `playlist.js`'s deferral
   conditional, `removeAt()` index-shift direction, the storage
   dual-write direction) and recorded 4 decisions with Rene (3-stage
   canary rollout, `prev()`-at-start restarts track 1, a fixed not
   preserved unknown-id hash, 2+ week soak before Stage 2c).

2. **Implemented Stage 2a directly** (Claude wrote it, not Codex — Rene's
   explicit standing preference, see `feedback_codex_write_claude_review.md`
   in auto-memory): new `scripts/playlist-boot.js` +
   `scripts/playlist-views.js`, `player-controller.js` gained
   `queueRevision`/`onQueueExhausted`/`onExternalClaim`, `playlist.js`
   gated to defer when `?engine=controller`. Shipped default-off
   (`PLAYLIST_CONTROLLER_ENGINE = False`), canary via `?engine=controller`.

3. **Two Codex review rounds on the implementation**, both via
   `/review-step`-style verify-then-disposition (never taken on the
   review's word — every finding traced against actual code/tests before
   acting):
   - **Pre-merge round** (`player-consolidation-codex.md`'s "Phase 2 Stage
     2a implementation review"): 7 findings, 5 fixed (transactional
     mount/teardown, stuck "paused elsewhere" message, unconditional
     highlight scan, `verify_markup.py`'s unimplemented default-literal
     check, `appendQueue()` bound-after-normalize ordering), 1 test-gap
     partially closed, 1 declined as pre-existing/out-of-scope.
   - **Post-deploy round** (requested via a direct `mcp__codex__codex`
     call rather than the script, scoped to what the first round missed
     plus the untested deploy-fix commit): 5 findings, 4 fixed
     (`verify_markup.py`'s both-absent blind spot, `MAX_SAVED_PLAYLISTS`
     enforced on read not just write, a seek-drag freeze bug, a dead
     `firstOrder` assertion plus a false coverage claim in a test
     comment), 1 left as deliberate legacy parity (`syncHash()` drops the
     `?engine=` param on empty queue — byte-identical to `playlist.js`,
     Rene's explicit call to leave it).

4. **Deployed to production** (PR #10, `4400531`) — **broke the deploy
   workflow on merge**: `test-playlist-state.mjs` used a plain
   `globalThis.navigator = {...}`, which throws under CI's Node (a
   getter-only accessor there; same class of bug already fixed for
   `test-player-controller.mjs` in `5078e47`, but this new file predated
   that fix and local dev Node has no such global to catch it). Fixed and
   redeployed (PR #11, `ed01f2f`).

5. **Rene did a full manual production pass** at `?engine=controller`:
   mount, queue build/play, next/prev, share-link round-trip, saved
   playlists, endless rollover, remove/shuffle, cross-tab external-claim,
   `?engine=legacy` fallback — all confirmed working. One thing noticed
   and deliberately left alone: playback controls vanish entirely once a
   non-endless queue reaches its end (`currentItem` goes `null` → the
   view hides the whole panel) — traced and confirmed byte-identical to
   legacy `playlist.js:696`, not a Stage 2a regression.

6. **Post-deploy hardening round shipped** (PR #12, `43b1a60`) with the 4
   fixes from review round 2 above, each with a fail-then-pass-proven
   regression test.

7. **Stage 2b: flipped the default** (PR #13, `015ba65`) —
   `PLAYLIST_CONTROLLER_ENGINE = True`. Confirmed on production: the
   resolver's baked-in default literal is `true`, no-param `/playlist/`
   now loads the controller engine, `?engine=legacy` still works.
   `playlist.js` stays loaded as the runtime fallback through Stage 2c.

8. **Stage 2c: implemented same day, soak explicitly waived by Rene**
   (client-side `savedPlaylists` localStorage is the only realistic blast
   radius, never audio files or server data — see the plan doc's Phase 2
   section for the full reasoning). The real-browser gate was kept, not
   waived: installed `playwright-chromium` into this environment (it
   wasn't here before) and ran `browser_check.mjs --prod` for real against
   production for the first time ever (previously only syntax-checked).
   - Deleted `scripts/playlist.js`/`assets/playlist.js` and the entire
     `?engine=`/`window.PLAYLIST_ENGINE` resolver mechanism — `pages.py`'s
     `build_playlist()`, `PLAYLIST_CONTROLLER_ENGINE`, and
     `playlist-boot.js`'s auto-run gate all simplified to unconditional.
   - `verify_markup.py`'s `check_playlist_engine_wiring()` rewritten for
     single-engine reality (playlist-boot.js present exactly once, legacy
     playlist.js and any leftover resolver wiring text absent,
     `window.WORKER_ORIGIN` still set) with an expanded selftest.
   - Storage dual-write: confirmed moot by construction — there was never
     actual dual-write code, only a comment explaining why the flat key
     stayed canonical; that comment is now simply accurate.
   - `browser_check.mjs`'s `runPlaylistBreakageTest()` **deleted outright**
     (not retargeted to a fake "graceful degradation" assertion — a Codex
     review of that plan correctly called out that asserting "no mount
     flag, no crash" after removing the only engine just blesses a dead
     page as a pass, not a real test; a missing `playlist-boot.js` is
     already caught by `verify_markup.py`/`build.py`'s asset checks and
     the real smoke check). `checkPlaylistPage()` lost the
     `?engine=controller` param and the legacy-dormancy step.
   - **A real bug surfaced by actually running the check for real**: the
     hash round-trip check's `page.goto()` "reload" navigated to a URL
     byte-identical to the current one, which per the HTML spec is a
     same-document navigation with no JS state reset — verified directly
     against production. The check had never actually reloaded anything;
     fixed by using `page.reload()` instead. Distinct from the pre-existing
     `browser_check.mjs` timing flake noted in the plan doc's Phase 1
     section (that one's a tight playback-timing assertion; this one was a
     navigation-semantics bug in the check itself).
   - `TAG_ORDER`'s home moved to `playlist-boot.js`; `PUBLISHING.md`'s two
     references repointed there (`manual/index.html` picks it up on
     rebuild — it's generated from `PUBLISHING.md`, not hand-edited).
     `track-select.js`'s comments about integrating with `playlist.js`
     updated to name `playlist-views.js`/`playlist-boot.js`.
   - `site_worker.js:173` still has one stale `scripts/playlist.js`
     comment — **left alone** (that file is deploy-infra's territory, not
     this initiative's) and flagged here for that team to clean up.
   - `test-playlist-state.mjs`: removed dead `window.PLAYLIST_ENGINE`
     setup and a stale "playlist.js takes over" assertion message; added a
     real test proving the controller mounts unconditionally even with a
     stale `?engine=legacy` param on the URL (the module doesn't read
     `location.search` at all anymore).

Local suites: **119/119 passing** (`test-player-boot.mjs` 23,
`test-player-controller.mjs` 26, `test-player-views.mjs` 17,
`test-playlist-state.mjs` 19, `test-playlist-views.mjs` 15). `build.py`,
`build.py --check`, and `verify_markup.py` all clean. `browser_check.mjs
--prod`: **178/178** for real (first real run ever) — real playback, real
cross-tab `BroadcastChannel` coordination between `/playlist/` and a show
page, and the hash round-trip fix above all verified against the live
site.

## 🔧 Next up

Phase 2 is done. **Nothing from this session is committed or pushed yet**
— it needs a review pass (Codex + Rene) before it ships; do that before
starting anything else. After that: Phase 3 (`/player/` popup) is
"not started," not scoped for this session, and not queued — see the plan
doc for its outline if picked up later.

## Gotchas learned this session

- **Node's CI runner (>=21) has a getter-only `navigator` global** —
  `globalThis.navigator = {...}` throws there but silently works on
  older local dev Node. Any new test file that needs to fake `navigator`
  must use the `setGlobalNavigator()` `Object.defineProperty` pattern
  (see `test-player-controller.mjs` or `test-playlist-state.mjs`), not a
  plain assignment. This has now bitten twice (`5078e47`, `ed01f2f`) —
  check for it explicitly in any future new test file touching
  `navigator`.
- **A Codex review round only reviews what you scope it to.** The first
  round (pre-merge) never looked at the deploy-fix commit because it
  didn't exist yet — worth an explicit "review what's new since the last
  round, plus anything untouched" framing on a follow-up round, not just
  "review the branch again" (which risks re-litigating settled findings
  instead of finding new gaps).
- **`git stash` can't target untracked new files** — for a fail-then-pass
  proof on a brand-new file, `cp file /tmp/backup` + revert-in-place +
  restore-via-`cp` is the reliable pattern this session settled on
  throughout, not `git stash push -- <path>`.
- **Deterministic tests involving `Math.random()`-based shuffle logic**
  (e.g. endless-mode reshuffle) need `Math.random` monkey-patched
  (restore in `finally`) to actually prove reordering happened — a test
  that captures a "before" order and never asserts against it will pass
  even if the reshuffle silently does nothing.

## Durable facts (don't undo)

- **Everything under "Durable facts" in this file's prior version (Phase
  1 facts about `downloads.lossless`, recording-id keying, BroadcastChannel
  wire format, deep-link autoplay, WaveSurfer failure blast radius, the
  controller's `<audio>` element never being pre-appended) is unchanged
  and still true** — not reproduced here again; see git history for this
  file's Phase 1-era version, or the plan document, if the specifics are
  needed.
- **`/playlist/`'s BroadcastChannel wire format is still the legacy bare
  string** — Phase 2 deliberately kept it unchanged (see the plan's
  scoping section); no upgrade until Phase 3 (`/player/` migration) lets
  every participant change together.
- **The flat `savedPlaylists` localStorage key is still the canonical
  store, now post-2c** — `playlist.js` is deleted and `playlist-boot.js`
  is the only writer, so the reconciliation problem that motivated
  deferring a versioned `v2` envelope is gone. A `v2` envelope is now
  unblocked if anyone wants to pick it up, but nobody has asked for it —
  don't treat this as queued work, just as no-longer-blocked.
- **`syncHash()` still drops the whole query string (not just an
  `?engine=` param — there's no such param anymore) when the queue
  empties**, via `win.history.replaceState(null, '', win.location.pathname)`.
  This used to specifically matter for `?engine=legacy`/`?engine=controller`;
  now that those are gone it's a much lower-stakes generic quirk (any
  other query param a visitor arrived with gets dropped too). Not fixed as
  part of Stage 2c — nobody has asked for it, and it was never confirmed
  as a real problem beyond the now-moot engine-param case.
- Branch/worktree workflow: sync with `git fetch origin && git merge
  origin/main` at session start and before a PR.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (unrelated to this
initiative, but the canonical project-wide instructions file). Player
work: `plans/player-consolidation/` (plan + `player-consolidation-codex.md`
for every review round's findings/dispositions/fixes, Phase 1 and Phase
2 both). Tests: `node scripts/test-{player,playlist}-*.mjs`. Real-browser
verification: `scripts/browser_check.mjs` (needs `playwright-chromium`;
`--prod` points it at `https://renedebos.com`).
