# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-18 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

## ⛔ READ THIS FIRST

**The loudness-variant campaign is DONE and live.** All 680 tracks are
rendered at −14 LUFS in R2 under `MP3-14/`, the player toggle ships on every
surface, and **Loud is the DEFAULT playback variant** (Rene, 2026-08-18).
Merged as PR #20, deployed, and spot-checked on renedebos.com itself. The −20
archive is unchanged and remains the master and the download.

**PR #21 is OPEN and unmerged** —
<https://github.com/renedebos/renedebos.com/pull/21>. It adds the scope line
above each show's technical-data table and the Loud columns on
`/archive-data/`. Nothing in it is live until it merges; deploy fires only on
push to `main`.

**The player consolidation is finished as a project.** Phase 3 (the sticky
mini-player) is PARKED — do not resume it, and do not run `/apply-review`
against its findings. Its modules are deleted from this branch and preserved
on branch `miniplayer-parked` (commit `6bdecc6`).

**Note the branch name is misleading.** `player-consolidation` now holds
loudness and variant work. Consider branching fresh for whatever comes next.

## ✅ Done this session (2026-08-18)

### The −14 loud variant shipped, end to end
680/680 tracks rendered from the **published −20 archive FLACs** (never
re-staged from Drive — re-staging is what destroyed hand-edited fades on
2026-08-11) and uploaded to `MP3-14/`, filename byte-identical to each
`MP3/` counterpart so the variant key is a one-token swap. No Worker change
was needed.

**The derivation is enforced, not assumed.** Every variant track records
`src_md5`; the archive sidecar's `md5` is the same quantity for the published
FLAC; `check_variant_derivation()` in `sitegen/core.py` **fails the build** if
any pair disagrees. `audio_process.py` gained `--provenance-out` so a variant
render can never merge −14 numbers into the archive's own sidecar.

### The toggle covers every player surface
One preference module, `scripts/variant-pref.js` (`localStorage`
`hannanVariant`, enum-validated, cross-tab sync). Show pages, song pages,
`/songs/`, `/playlist/` read it through `PlaybackController`; the `/player/`
popup and the legacy `player.js` fallback read it through the
`window.HannanVariant` bridge plus a `hannanvariantchange` DOM event, because
classic scripts cannot `import` and cannot rely on a deferred module having
run yet.

**`data-src` in the markup stays the ARCHIVE url everywhere**; the variant
rides in `data-item`'s `loudUrl`. A page whose module fails to mount degrades
to the master, never to a key that might not exist. Whole-show recording
cards have no −14 render and always play the archive.

Verified in headless Chromium on all five surfaces: Loud by default, the
control flips `aria-pressed` and the note, the choice survives a reload, a
mid-track switch holds position, and the legacy engine (forced by blocking
`song-boot.js`) behaves identically.

### Disclosure shipped with it
`/process/` explains the variant and states the cost (median 0.5 LU of LRA,
worst 3.10 LU). Every page with a player says which version is playing. PR #21
extends that to the measurements themselves — see above.

### Three stale R2 keys deleted
`01 State Trooper.{mp3,flac}` under `MP3/`, `MP3-14/` and `FLAC/` for
`JerryHannan - 19 Broadway 2001-01-15 SBD`, left from the rename to
"Highway Patrolman" (which this branch also corrected in `recordings.json`).
Confirmed unreferenced first; only the prose update notes mention the old
name.

### The 1999-10-25 noise reduction was audited and is intact
Rene asked whether that show still carries the Audacity NR. **It does**, on
all 26 tracks, proven rather than inferred — see the recipe below.

## 🔍 Reusable audit: "does this show still carry its hand edits?"

Worth repeating for any show. Cost: minutes, mostly download.

1. **Which source was staged** — `~/work/<slug>/publish.json` records
   `source_sub` (`Tracks Noise Reduction` vs `Tracks`).
2. **Was it really that folder** — `rclone hashsum md5` on both Drive folders
   (no download needed) vs `md5sum` of the local staged files. For
   1999-10-25: **26/26** identical to `Tracks Noise Reduction/`, **0/26** to
   `Tracks (pre-NR archive)/`.
3. **Is the live audio what provenance says** — pull each published FLAC from
   R2, `ffmpeg -f md5` the decoded audio, compare to the sidecar `md5`.
   **26/26 MATCH**.
4. **Does the live audio derive from that source** — re-render locally from
   the staged file with the sidecar's recorded `chain` (same ffmpeg build) and
   compare decoded md5. **24/26 bit-exact**; the two exceptions are the
   applause-limiter defect below, not a source problem.
5. **Acoustic confirmation** — quietest-window RMS on the live file
   (**−99.3 dB**) vs the pre-NR source (**−51.4 dB**); above 8 kHz, −123.0 vs
   −69.9 dB. Above 8 kHz *during music* the two are within 0.2 dB, which is
   what NR at 6 dB / sensitivity 5 should look like: it acts in the gaps, not
   on the performance.

Two traps this run hit, both worth knowing:
- **`astats` prints at `-v info`.** Running it under `-v error` silently
  yields no numbers — which reads exactly like "the measurement was zero".
- **Match staged filenames, not published ones.** Tracks 18 and 19 "failed"
  reproduction only because Audacity exported them as `18 Angel of
  Montgomery` and `19 Peacful Easy Feeling`, both corrected at publish. Both
  are bit-exact against their original filenames.

## 🐞 Open defect: applause-limiter provenance is not reproducible

**Found 2026-08-18, not yet filed or fixed.** `audio_process.py:1760-1764`:
when a publish **resumes** over an existing applause-limiter render it does
not know what gain produced those bytes, so it infers one —
`actual_gain = round(output_integrated - input_integrated, 2)` — and writes
that into the provenance `chain`. For a limiter track that subtraction is
systematically wrong, because the limiter already pulled the applause
transients down, so output loudness is not input + gain.

Measured on 1999-10-25 track 14: chain records `volume=2.65dB`, the render
actually applied **≈2.67 dB** (live file 0.0198 dB louder than the re-render;
the difference is spread across the whole track rather than concentrated in
the 1:40–1:45 applause window, which is what identifies it as a global gain
difference and not a limiter difference). Track 20 the same. Audibly nothing;
but the recorded chain is not a recipe that reproduces the bytes.

**The fix already exists for the other mode.** Transient-cap writes a
`.v8state.json` beside each output holding the gain/limit that actually
produced it, and refuses to resume without it — *"provenance must never
describe a chain it merely guesses"* (`audio_process.py:1728`). Do the same
for applause renders instead of inferring. **Do not** go after rounding; that
was an early wrong guess in this session.

## 🧹 R2 orphan inventory (measured 2026-08-18, mostly NOT cleaned)

Compared every key under `MP3/`, `MP3-14/`, `FLAC/` against `recordings.json`.
2423 keys, 316 unreferenced:

| category | count | what it is |
|---|---|---|
| directory placeholder keys | 100 | empty `…/` markers, harmless |
| files under superseded folder names | 210 | old spellings (`New George's` vs `New Georges`), non-`SBD` variants, an older `- NN Title.mp3` naming generation |
| **files inside a LIVE show folder** | **6** | the ones that matter |

The six are three tracks as MP3 + FLAC: `18 Angel of Montgomery`
(1999-02-01), `15 Still I Love Him` (1999-06-21), `22 Leprechaun`
(1999-07-19). Same class as the State Trooper keys already deleted, but each
is a **different rename** and none has been cross-referenced yet. Nothing
deleted beyond the three approved. `rclone delete` against `r2:` is
agent-executable; `gdrive:` still needs Rene.

## 🎯 Next session — start here

1. **Merge PR #21**, watch the Action, then spot-check on renedebos.com (green
   Action alone is not proof). Both CI gates pass locally.
2. **Fix the applause-limiter provenance defect** above — small, contained,
   and the pattern to copy is already in the same file.
3. **Decide the six live-folder orphans** — cross-reference each title first;
   the 210 superseded-folder files are a separate, lower-stakes sweep.
4. **Optional:** migrate the `/player/` popup onto `PlaybackController`. It is
   now the last independent engine and the last consumer of the
   `window.HannanVariant` bridge; killing it removes both.
5. **Optional:** `python3 scripts/build_archive_zip.py` to refresh the
   complete-archive snapshot — it does not include the variant (downloads stay
   −20), so this is only needed if the curated FLACs changed.

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

**Keep `~/work/jerry-19-broadway-1999-10-25/` (1.2 GB) for now.** Its staged
`tracks/` are the NR exports the audit above was run against; deleting them
means re-downloading from Drive to repeat it. Drive still holds the originals,
so it is safe to delete once you are done with that show.

Also: **`main` is checked out in a separate worktree** at
`/home/renedebos/renedebos.com`, currently at `79a9232` (PR #19) — 4 commits
behind `origin/main`. Nothing diverged, so
`git -C /home/renedebos/renedebos.com pull` fixes it. Do that before working
there or you will branch off an old base.

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
- `plans/loudness-variants/loudness-variants-plan.md` — **campaign complete**;
  §5-result records what actually shipped and supersedes §5's three-way
  `Archive / Louder / Loudest` sketch (only one variant was rendered).
- `plans/title-filename-consistency/` — not started. Drive filenames that
  disagree with published titles, plus the orphaned-duplicate defect in
  `Processed/`. Step 2 (stop `draft_tracks.py` clobbering corrected titles) is
  the fix that actually matters and is purely local.
- `plans/player-consolidation/` — closed; `-codex.md` logs every review round.

**Tests:** `node scripts/test-*.mjs` — 6 suites plus `test-fake-dom.mjs`
(a helper). **160/160 passing**, re-run 2026-08-18 after the variant work
touched `player-controller.js`, `player.js`, `playlist-views.js` and
`songs.js`:

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
at `https://renedebos.com`. **A full `--prod` sweep still has NOT been run** —
not against PR #18, #20 or #21. Post-deploy checking has been hand-run URL
spot-checks each time. That remains the standing loose end.

Note the MCP Playwright tools are configured for channel `chrome` and fail
here (`/opt/google/chrome/chrome` missing). The bundled chromium at
`~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` works, driven
either headless with `--dump-dom` or over CDP (`--remote-debugging-port`)
from `node --experimental-websocket` — Node 20 has no global `WebSocket`
without that flag. That is how this session's browser verification was done.

**Variant tooling:** `scripts/render_variant.py` (`--list` / `--jobs N` /
`--upload`), `scripts/variant_outliers.py`, `scripts/variant_listen.py`. Rank
listening candidates by **LRA delta, not engagement** — on archive input the
engagement screens measure against a yardstick the first limiter pass already
lowered.

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
