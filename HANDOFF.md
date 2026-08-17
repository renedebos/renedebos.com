# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-17 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

## ⛔ READ THIS FIRST

**The player consolidation is finished as a project.** Phase 3 (the sticky
mini-player) is PARKED — do not resume it, and do not run `/apply-review`
against its findings. Its modules are deleted from this branch and preserved
on branch `miniplayer-parked` (commit `6bdecc6`).

**The active work is the loudness variants** —
`plans/loudness-variants/loudness-variants-plan.md`. Read §4-decisions,
§4-ab and §4-gating there before doing anything; every decision is settled
except two (§4-open).

**Everything is merged, deployed and verified live.** `origin/main` is at
`6a13dea` (PR #18). This branch is **one doc commit ahead** (`a243125`,
unpushed) — the loudness decision record. Working tree clean.

**Note the branch name is now misleading.** `player-consolidation` currently
holds loudness work. Consider branching fresh for the render campaign.

## ✅ Done this session (2026-08-17)

### The applause-precedence engine change shipped
`--transient-cap-over-applause` (workflow v8, `scripts/audio_process.py`) lets
the transient cap take a track the applause-limiter would otherwise keep, so
the archive's 42 applause-limited tracks aren't stranded a median 6.7 dB below
a loud target. **Opt-in only** — left automatic it rewrites the −20 *archive*
(Truck −23.65 → −20.0), which is why the flag exists at all.

Six post-review fixes were applied before merging (`3092acd`), the most
important being a **wrong claim in `CLAUDE.md`**: it said the flag "lets the
cap take" Truck. It does not — the flag grants *eligibility*, and the track
then declines on its own, first on the 6 dB attenuation ceiling and then, once
`--transient-cap-max-gr` lifts that, on engagement. Reaching −14 needs the
override **and** `--transient-cap-force` per track. Corrected in both
`CLAUDE.md` and the plan.

Also fixed: `recipe_signature()` was emitting the new key unconditionally,
which would have rehashed every track rendered since v7 and re-armed every
accepted listen-block. It is now emitted only when the flag is on, and the
flag-off hash was verified byte-identical to the pre-change payload.

### Internal docs are no longer served publicly
`CLAUDE.md` and `HANDOFF.md` were returning **200 on renedebos.com**. The
`.assetsignore` fix was committed earlier but never deployed; PR #18 shipped
it. Verified after deploy: `/CLAUDE.md`, `/HANDOFF.md`, `/plans/…`,
`/assets/miniplayer-*.js` all 404, while `/`, `/search/`, `/archive-data/`,
show pages, `player.js`, `home-shows.json` and `tracks.json` all 200.

### The loudness source question was settled by listening
**Decision: render the −14 variant from the published −20 archive FLACs, not
from the original hand-edited source.** Rene's call; the one real objection
was tested and cleared.

The objection was double-limiting: for the 257 tracks whose published file
already went through a limiter, deriving the variant means a second pass over
peaks the first pass had flattened into plateaus. Tested blind and
loudness-matched on the two heaviest cap cases of the hardest show
(`mad-cafe-java-1999-09-09` tracks 21 Rocky Road, 13.2 dB, and 22 The Kiss /
Da Da Da, 10.7 dB — the one with the hand-drawn fade). The from-source side
was **byte-identical to the approved pilot render** (md5 `ece83ce0`,
`fa07d2ad`), so the comparison was against the genuine article.

**Rene heard no difference on either track, fade included.**

| | 21 src → arch | 22 src → arch |
|---|---|---|
| Cap engagement | 5.8 % → 7.1 % | 7.2 % → 8.2 % |
| Longest event | 0.55 s → 0.65 s | 0.30 s → 0.35 s |
| Near-peak density | 0.3 % → 2.8 % | 0.2 % → 2.6 % |
| LRA (MP3) | 11.5 → 11.4 LU | 15.8 → 15.6 LU |

The deciding argument was **correctness, not cost**: re-staging 30 shows from
Drive is precisely the operation that destroyed hand-edited fades on
2026-08-11 and caused the "Hear Me" → "I Need a Lover" drift. Deriving from
the archive makes variant-vs-archive disagreement structurally impossible.

## 🎯 Next session — start here

**1. Get the download-throughput number.** This is the only thing blocking the
campaign design, and it is one command on Rene's **work laptop**:

```
rclone copy "r2:hannan-audio/FLAC/MadHannans - Cafe Java 1999-09-09/" ./test/ \
  --s3-no-check-bucket --include "01 *" --progress
```

R2 from the Chromebook measured **~26–60 KB/s single-stream, ~250 KB/s with
`--multi-thread-streams 8`**. At 250 KB/s the full 25 GB archive is ~28 hours
of transfer. If the laptop clears ~2 MB/s the whole campaign is an afternoon.
A 4-hour job and a 28-hour job want different runners — don't write the runner
before knowing which.

**Local disk and CPU are NOT the bottleneck** (measured: 587 MB/s write,
2.9 GB/s read, 8 cores). Only the network path to R2 is slow. An earlier
claim in this session that local copying was slow was wrong.

**2. If the laptop is faster, run the whole pipeline there**, not just the
staging. Download → render → upload → delete, with nothing crossing to the
Chromebook but the final metadata update. The pipeline is portable: `rclone`
(with `r2:` configured), `ffmpeg`, `python3`, `scripts/audio_process.py`.

**3. Pull from R2, not Drive.** Drive's `Processed/` folders hold the same
FLACs but accumulate orphaned duplicates under stale filenames, and the
*newer* file is sometimes the wrong one (the §1b finding in
`plans/title-filename-consistency/`). R2 is keyed by exactly what
`recordings.json` says. Only consider Drive if it benchmarks much faster, and
then MD5 every file against R2 first.

**4. Settle the two §4-open items** — the R2 key convention and how the
variant is recorded in provenance so `/archive-data/` and `version-map` stay
honest. Provenance must record that the variant is **derived from the −20
archive**, not from source. This is an engineering call, not a Rene decision.

**5. Design the runner as show-by-show and pipelined.** Only ~17 GB free
against a 25 GB archive, so it must stage per show. Pipelining (download show
N+1 while rendering show N) costs ~2–4 GB peak and roughly halves wall time
versus strict sequential. Also check whether the engine can be told to skip
writing the intermediate FLAC — the variant ships as MP3 only, so that FLAC is
pure churn.

### Campaign parameters already settled (plan §4-decisions)
- **−14 LUFS, one variant.** No −17.
- **All 680 tracks.** Every track gains ≥3 dB, 643 gain ≥6 dB — there is no
  subset where "Louder" would be inaudible.
- **MP3 only** (~5.6 GB; FLAC too would be ~30.7 GB). Downloads stay archival
  at −20. Also matches the finding that 24-bit FLAC stutters in Chrome on the
  Chromebook and reads as dropouts.
- **From the published −20 archive FLACs.**
- **Gating (Rene's instruction, plan §4-gating): no blocking gates**, because
  a gate overridden on all 680 tracks isn't a gate. **But keep measuring** —
  log engagement/longest-event per track, render everything, then listen to
  the **five worst outliers** before shipping. Rene has heard ~42 of 680.
- **The −1.00 dBTP abort is exempt from "ignore the gates" and stays.** It is
  what stops clipped audio reaching the site.

### Then, after the render campaign
- The player toggle (plan §5) — small; four of five surfaces already share
  `PlaybackController`.
- **`/process/` needs a caveat sentence** (plan §7). Its "linear gain only…
  the dynamics of the room stay intact" claim contradicts shipped
  transient-capped audio. Do not let the public page contradict provenance.

## ⚠️ Two measurement traps in this work

- **The sparsity screen is meaningless on archive input.** Near-peak density
  jumps ~9× (0.3 % → 2.8 %) purely as a **yardstick** effect: the first
  limiter pass lowered the peak the screen measures *against*. The music is
  not denser. Every track will read artificially dense and trip it. Engagement
  and longest-event are the real signals; LRA is what says the dynamics
  survived.
- **Never baseline against `track-spec.json`'s stored `lra`.** Always render a
  local −20 control. Doing otherwise manufactured two phantom findings in an
  earlier session.
- **Always A/B as MP3, never FLAC**, and re-measure loudness on the MP3s since
  encoding shifts true peak.

## 🧹 Cleanup Rene still needs to run

`rm -rf` is blocked for the agent.

```
rm -rf ~/work/_dbltest ~/work/_bench ~/work/_applause_test \
       ~/work/_regress ~/work/_app2 ~/work/loudness-pilot
```

`~/work/_applause_test` (72 MB) is the −20 regression fixture for the
applause-precedence change — worth keeping if you expect to touch that code.
`~/work/loudness-pilot` is the big one (~4.8 GB).

Also: **`main` is checked out in a separate worktree** at
`/home/renedebos/renedebos.com` and is stale at `643869e`, ~75 commits behind.
Nothing diverged, so `git -C /home/renedebos/renedebos.com pull` fixes it.
Do that before working there or you will branch off a very old base.

## Player consolidation — final state (closed)

- **Phase 1** (all show pages on shared `PlaybackController`) — complete,
  review-hardened, live.
- **Phase 2** (`/playlist/` migration, legacy engine deleted) — complete,
  live. `/assets/playlist.js` 404s.
- **Phase 3** (sticky mini-player) — **PARKED**. Modules deleted from this
  branch (`c4dd43c`); no page ever referenced them, so the deletion is
  invisible to visitors. Everything is on `miniplayer-parked` (`6bdecc6`),
  including Task 3's finished-but-uncommitted CSS.
- **Optional remnant:** migrating the `/player/` popup onto
  `PlaybackController`. It kills the last duplicated shuffle implementation
  and the last independent engine. It blocks nothing.

**What survives from Phase 3 and is worth keeping:** song pages on the shared
controller; three real bug fixes on live pages that its reviews turned up; the
`--player-*` token aliases in both stylesheets; and `onAnyExternalClaim()` in
`player-controller.js` (no subscribers, deliberately kept — inert and tested).

**Open, unrelated to any phase: the 3px seek rail on live players.** On mobile,
seeking on a show page or `/playlist/` means hitting a 3px-high box away from
the thumb. Fix shape: give the range at least a 24px block-size while keeping
the visual rail at 3px, and because `_paintRange()` assigns the `background`
shorthand — which resets `background-size`/`-repeat`/`-position`, and inline
style beats a CSS longhand — switch it to `backgroundImage` rather than
reaching for `!important`. Small and self-contained.

## Gotchas worth carrying forward

These came out of the player work but are general.

- **A test fake that is wrong about the platform hides real bugs — plural.**
  `FakeAudio.play()` fired `play`/`playing` on every call, and assigning `src`
  did not set `paused`. Neither matches the platform. Modelling both rules
  turned five tests red across four suites: four were relying on the lie, and
  the fifth was a **live bug on `/playlist/`**. Don't "simplify" a fake toward
  whatever makes the suite green.
- **A flaky test is a bug report, not a retry candidate.** One failure in ~20
  runs diagnosed to a real `player-controller.js` defect. Re-running until
  green would have buried it.
- **Ask "what mutation would make this fail?" while writing the test.** This
  project has shipped three tests that passed for the wrong reason.
- **Ask what a fix makes untestable.** Twice, a correct fix removed the only
  path proving a *different* line was load-bearing. Re-pin on a property that
  is still local rather than deleting the belt-and-braces line.
- **A character check is not a URL parser.** `isSitePath()` let four values
  through that resolve off-origin (backslash, and tab/CR/LF before the second
  slash). Parse against a sentinel origin and compare origins.
- **A tool going quiet is a symptom, not a null result.** A literal NUL byte
  in a template string made `grep` treat the source as binary, so every
  subsequent `grep` returned nothing. The verification sweep now covers every
  C0 control character except tab/newline/CR.
- **"All tests pass" is scoped to the runtime you ran them on.** Local is Node
  20, CI is Node 24. Simulate the other with `node --import <preload>`.
- **A failing check on freshly-deployed code is not automatically a
  regression — but treat it as one until proven otherwise.** Check user impact
  first, reproduce locally, then read the design docs.
- **Verifying a claim is often cheaper than defending it.** A short Playwright
  script settled a CSS-theming argument in one run.
- Narrow "verify these fixes" review rounds repeatedly came back clean while
  the very next *broad* round found several real bugs the narrow framing had
  hidden. Use both.

## Durable facts (don't undo)

- **`FakeAudio` (both copies) models two spec rules deliberately:** `play()`
  fires `play`/`playing` only on a paused → playing transition, and assigning
  `src` (or calling `load()`) sets `paused = true`. A harness-contract test
  asserts both. Reverting either re-hides two live bugs.
- **Never call `play()` on a media element that was not paused.** It resolves
  without firing anything, so a controller already in `'loading'` never leaves
  it. Guards in `PlaylistNowPlayingView._prev()` plus a backstop in
  `_playIndex()`. Kept even though the backstop hides the symptom: a needless
  `play()` still mints an ownership `play-attempt` and clears `lastPlayError`.
- **A view creates a fresh `AbortController` per `onAttach()` and aborts the
  outgoing one first.** `mount()` calls `onAttach()` even for a view already
  in its set, so replacing without aborting leaves two live handler sets.
- **Song occurrences are `playSingleton()` — the queue does NOT accumulate
  across rows.** Two `browser_check.mjs` assertions once claimed the opposite
  and failed against production; they were what was wrong. Don't "restore"
  them.
- **Ownership claims hook the media `play` EVENT, never the `'playing'`
  STATE**, and both are ignored when `audio.paused` is already true. Every
  rebuffer is `playing → loading → playing`, so the state would mint an epoch
  per buffering hiccup. Direct regression tests exist for both.
- **`storage` events are a wake-up signal only — never act on
  `event.newValue`.** It can be stale by delivery. Re-read and re-validate.
- **`player.js`'s `initLegacyPlayback()` fallback and `initCustomPlayers()`'s
  per-row engine are not being deleted** — deliberate degraded-mode safety
  nets the readiness contract references.
- **`assets/*.js` and `assets/*.css` are build outputs** copied verbatim from
  `scripts/` by `scripts/build.py`. Edit the `scripts/` copy and rebuild; a
  direct edit to `assets/` is silently discarded. Same for every generated
  HTML page — see `CLAUDE.md`.
- Everything under "Durable facts" in this file's Phase-1/Phase-2-era versions
  is unchanged and still true (see git history): `downloads.lossless`,
  recording-id keying, BroadcastChannel wire format, deep-link autoplay,
  WaveSurfer failure blast radius, the controller's `<audio>` never being
  pre-appended, the flat `savedPlaylists` key, `syncHash()`'s
  query-string-dropping quirk.
- Branch/worktree workflow: `git fetch origin && git merge origin/main` at
  session start and before a PR.

## Reference

**Runbook:** `CLAUDE.md` → "Publishing a Split Show". Canonical project-wide
instructions.

**Plans:**
- `plans/loudness-variants/loudness-variants-plan.md` — the active work.
- `plans/title-filename-consistency/` — not started. Drive filenames that
  disagree with published titles, plus the orphaned-duplicate defect in
  `Processed/`. Step 2 (stop `draft_tracks.py` clobbering corrected titles) is
  the fix that actually matters and is purely local.
- `plans/player-consolidation/` — closed; `-codex.md` logs every review round.

**Tests:** `node scripts/test-*.mjs` — 6 suites plus `test-fake-dom.mjs`
(a helper). **160/160 passing** as of this handoff:

| suite | tests |
|---|---|
| `test-player-controller.mjs` | 57 |
| `test-player-boot.mjs` | 28 |
| `test-playlist-state.mjs` | 29 |
| `test-player-views.mjs` | 17 |
| `test-playlist-views.mjs` | 16 |
| `test-song-boot.mjs` | 13 |

(Down from 327 because the two mini-player suites, 164 tests, were deleted
with the parked modules. `test-player-controller.mjs` went 60 → 57 in the same
commit.)

Also clean: `python3 scripts/build.py --check` (integrity OK, 31 shows, 680
curated tracks, no orphan song pages).

**Real-browser verification:** `scripts/browser_check.mjs` — needs
`playwright-chromium`, a **global** install here, so run it as
`NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs`. `--prod` points
at `https://renedebos.com`. **A full `--prod` sweep has NOT been run against
the PR #18 deploy** — post-deploy checking was done by hand (URL spot-checks
listed above). That is the one loose end.

**Audio tooling:**
- `scripts/ab_compare.py <slug> <track> [--raw PATH]` — A/B live vs freshly
  rendered, on `:8767` via `scripts/ab_server.py` (a Range-supporting static
  server; stdlib `http.server` has no Range support, which breaks `<audio>`
  seeking).
- `scripts/tcap_ui.py` — transient-cap control panel on `:8769`.
- `scripts/audio_process.py version-map` and `/archive-data/` — archive-wide
  workflow-version and spec visibility.

**Also outstanding, unrelated:** Rene wants to set up custom skills
(`~/.claude/skills/` or a project `.claude/skills/`). That belongs on `main`.
