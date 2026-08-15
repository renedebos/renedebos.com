# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-15 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

**Phase 1 (all show pages on the shared `PlaybackController`) is complete,
review-hardened, and live in production** — see git history / the plan's
Phase 1 section for that work; not repeated here.

**Phase 2 (`/playlist/` migration) is now through Stage 2b — the new
engine is the default for every visitor, not just a canary.** Stage 2c
(deleting the legacy fallback) has not started.

## ✅ Done this session — Phase 2, start to Stage 2b

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

Local suites: **99/99 passing** (`test-player-boot.mjs` 23,
`test-player-controller.mjs` 26, `test-player-views.mjs` 17,
`test-playlist-state.mjs` 18, `test-playlist-views.mjs` 15). `build.py`,
`verify_markup.py`, `--check-allowlist-coverage` all clean throughout.
`browser_check.mjs`'s new `checkPlaylistPage()`/`runPlaylistBreakageTest()`
are still syntax-checked only — no `playwright-chromium` in this
environment, never run for real.

## 🔧 Next up

**Stage 2c — delete `scripts/playlist.js`** (and its generated
`assets/playlist.js`), remove the `?engine=legacy` branch, drop the
storage dual-write consideration (moot now — only one engine writes),
simplify `verify_markup.py`'s wiring check, retarget the two
`browser_check.mjs` checks that still treat `/playlist/` as a legacy
reference point. **Gated on 2+ weeks of default-on production plus a
clean `browser_check.mjs --prod` run** (decision #4 from the scoping
pass — longer than Phase 1's one-week precedent, because silent
saved-playlist data loss wouldn't necessarily show up in a quick check).
**Do not start this before 2026-08-29** without Rene explicitly
shortening the soak.

Nothing else is queued. If Rene wants `browser_check.mjs` actually run
for real (not just syntax-checked) before Stage 2c, that needs
`playwright-chromium` installed in whatever environment does the check —
not available here.

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
- **The flat `savedPlaylists` localStorage key is the single canonical
  store through Stages 2a–2c** — a versioned `v2` envelope is deliberately
  deferred to a dedicated post-2c stage, once `playlist.js` is gone and
  there's only one writer (see the plan's storage-schema section for why
  a dual-write design was rejected).
- **`syncHash()` drops the `?engine=` query param when the queue empties**
  — known, real, deliberately left alone as legacy parity (see review
  round 2, finding #1). If this is ever fixed, fix it in the new engine
  only — `playlist.js` is going away in Stage 2c, not worth touching.
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
