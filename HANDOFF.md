# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-19 (second pass) · **Branch:** `main` (no feature branch open)

## ⛔ READ THIS FIRST

**The audio / player / loudness arc is closed.** Everything is on `main`, live,
and verified on renedebos.com itself — not just by a green Action. There is no
in-flight work and no open PR.

**The page-layout and copy cleanup project is STARTED, and round 1 is live.**
`plans/page-cleanup/` exists on `main`: a plan with a decision register and a
mechanically-derived inventory. All three items Rene named are gone from the
live site, along with several the inventory turned up. **Every row of the
register is decided** — see "Page cleanup" below for what shipped and what a
round 2 would be.

**The repo is clean, and that is new.** As of today: one branch (`main`) plus
the deliberate `miniplayer-parked` archive, one deploy path, no stranded
plans. Five PRs merged and one closed today were mostly getting there. Don't
undo it by starting the next project on an old branch.

**Phase 3 (the sticky mini-player) is PARKED** — do not resume it, and do not
run `/apply-review` against its findings. Everything is on branch
`miniplayer-parked` (`6bdecc6`). Never merge it; never delete it.

## ✅ Done this session (2026-08-19)

### Page cleanup round 1 — plan, inventory, and the cut
`plans/page-cleanup/` created and PR #29 merged and verified live. Full detail
under "Page cleanup" below. The short version: the three items Rene named are
gone, plus a four-times-per-page redundancy the inventory found that nobody had
listed, and both policy-disclosure blocks survived as explicit KEEPs.

### The mobile seek rail got a real pointer target
Seeking on a phone meant landing a fingertip in a **3px-high box**. The element
is now **24px** (WCAG 2.5.8's floor) while the rail it draws is still 3px —
painted as a background *image* sized `100% 3px` and centred, not as the
element's background colour.

**That is why every painter assigns `style.backgroundImage`, never the
`background` SHORTHAND.** The shorthand resets `background-size`/`-repeat`/
`-position`, and an inline style beats a stylesheet longhand, so one shorthand
write silently inflates the hairline to fill all 24px. **There are five
painters across four files**, not the one the old handoff named:
`player-views.js`, `playlist-views.js`, `player.js`, `continuous-player.js`
(twice). The last two are the degraded-mode fallbacks — miss either and the
fat bar appears only in the mode nobody looks at.

Verified in a real 390×844 mobile viewport on all three live surfaces
(show-page recording card, `/playlist/` now-playing, `/player/` popup with a
track queued): box 24px, `background-size: 100% 3px`, no inline shorthand
after the painter runs, and `elementFromPoint` answering across the full
±10px where it previously answered within 3px.

`.track-row .progress-range` (the 2px row-bottom variant) was deliberately NOT
touched: its own rule sets the `background` shorthand, which resets the
inherited longhands, and **no generated page currently emits it** — every track
row on every show page is a waveform row. It covers a fallback branch in
`pages.py` nothing hits today.

### The production browser sweep now covers the loud variant
`browser_check.mjs --prod` had **never been run in full** before today. First
run: 184/185. Both halves needed work.

The one FAIL was **the test, not the site** — a fixed 2.5 s sleep on the
`/playlist/` playback check, against ~0.8–1.3 s of real startup latency.
Reproduced 4/4 clean immediately after. Now polls with a 15 s ceiling. *A fixed
sleep asserts "fast enough", which is not the property under test.*

The 184 passes covered **no part of the −14 variant** — the script predates the
rollout. Ten new checks added, in their own browser context (the first needs a
genuinely fresh profile):

- fresh profile resolves to loud with **nothing persisted** (the default is a
  coercion of the absent value; if it ever starts writing on load, changing the
  default later silently misses anyone who merely visited)
- **`data-src` stays the archive url on every row**, loud riding in
  `data-item`'s `loudUrl` — the load-bearing one, invisible to every other
  check, and what makes a failed module mount degrade to the master
- whole-show cards carry no `loudUrl`; real playback streams `MP3-14/` by
  default and `MP3/` after switching, read off `audioElement.currentSrc`
- the choice persists, survives reload, and an unrecognised stored value
  coerces back to the default

**195/195 against production** after both changes.

### Applause-limiter provenance: the code half is fixed
A publish that *resumed* over an existing applause render inferred the applied
gain as `round(out_I - in_I, 2)` — systematically wrong, because the limiter
has already pulled the transients down, so output loudness is not input + gain.
`audio_process.py` now persists the real gain/limit in a `.v8state.json` beside
the output (the file the transient cap already used, now carrying a `"mode"`
key) and refuses to resume without it.

Verified on the track it was measured against (1999-10-25 trk 14): fresh render
applies **2.67 dB**; the old formula computes exactly the published **2.65**;
resume now reproduces the chain byte for byte. Legacy state files with no
`"mode"` still resume. **Do not** go after rounding — that was an early wrong
guess.

**The data half is open and written up: `plans/applause-provenance-repair/`.**
42 tracks across 16 shows are in applause mode — *upper bound, not the count of
bad records*. Step 1 is a ~20 min scoping pass that decides whether the rest is
worth doing at all (0.02 dB, no audio affected).

### The R2 / Drive orphans are gone
Six R2 keys and four Drive `Processed/` files deleted after cross-referencing
each. Two traps worth keeping:

- **`Angel of Montgomery` is a LIVE filename** in
  `SeanHannan - 19 Broadway unknown date`. Match on the full key, never the
  filename, or you delete a published track.
- **On 1999-06-21 the clean-looking name was the stale one.** The live key is
  `15 Still I Love Him␣␣` (two trailing spaces, 2026-08-13 v8 render); the
  tidy `15 Still I Love Him` was the superseded 2026-07-18 render. **Do not
  "promote" the tidier name — it is older audio.** Renaming the live key to
  drop the spaces is a separate, optional tidy-up.

Still uncleaned, low stakes: 210 files under superseded *folder* names and 100
directory-placeholder keys.

### Repo hygiene: branches, worktrees, plans, deploy
- Merged **PR #24** (home-page's plan record), **#25** (share proposal),
  **#26** (`.gitignore` secrets), **#27** (`workflow_dispatch`). Closed
  **PR #1**, open since 2026-06-09.
- Retired `home-page`, `share`, `applause-precedence` — branches, remotes and
  worktrees. `player-consolidation` is 0 ahead and retirable (see below).
- **Every plan now lives in `plans/` on `main`**, none stranded on a branch.

**Merging a long-lived branch reverts `HANDOFF.md` if you let it.** `home-page`
looked safe to merge *precisely because* its feature had already shipped — but
its `HANDOFF.md` was six days stale and the merge would have reverted this file
(316 lines changed, 204 deletions). **This file is rewritten every session, so
any long-lived branch's copy is stale by definition: resolve it to whichever
side is newer, never merge it line by line.**

### One deploy path, and a button to press
**Two systems were deploying `renedebos-site` on every push to `main`** — the
GitHub Action *and* Cloudflare's Workers Builds integration (the finding in
`plans/home-page/home-page.md` §8, confirmed on a live commit). Rene
disconnected Workers Builds; verified absent from the check runs afterwards.
The remaining path is gated: Action → `build.py --check` → `wrangler deploy`,
SHA-pinned.

**PR #1 would have been a regression, not a no-op.** Its auto-generated
`wrangler.jsonc` omitted `"main"`, `run_worker_first`, the `PLAYLISTS` KV
binding and `not_found_handling` — i.e. no Worker script at all, and a return
of the 2026-07-08 bug where *navigations* to `/play/{slug}` short-circuit to
the 404 fallback and cache that way while `fetch()` still works. Its
`.gitignore` half was real and was salvaged (PR #26): `.dev.vars*` / `.env*`
hold live Cloudflare tokens and were not ignored.

**Both workflows now have `workflow_dispatch`.** They were push-only, so when a
run wedged in `queued` — `cancel` and force-cancel both HTTP 500, `rerun`
refused — `main` could not be redeployed without inventing a commit.
`deploy-worker.yml` was worse: also `paths:`-filtered, so an empty commit
wouldn't have triggered it either.

**Known cosmetic leftover:** the PR #26 run is a zombie, still `queued`, cancel
still 500s. Inert — superseded by a later successful deploy of the same
content, and it only carried a `.gitignore` change. It expires on its own.

## 🎯 Page cleanup — round 1 shipped, register fully decided

`plans/page-cleanup/` — a plan (principles, decision register, verbatim
appendix) and an inventory. **PR #29, merged and verified on renedebos.com
itself**, not just by a green Action.

**The inventory is the reason this was finite.** Every standing text block with
its generator `file:line` and how many pages it actually reaches, counted from
`recordings.json` + the processing sidecars + the built trees. Regenerate the
counts before acting on a row — they are a snapshot.

It sharpened the handoff's own numbers: the "done" pill reads `done` on **30 of
30** generated show pages, not 30 of 31 — the 31st show is hidden and track-less,
so it generates no page at all. `STATUS_BLURB`'s three other values reached zero
pages.

**It also found what nobody had listed: the password fact was stated FOUR times
on every show page.** Track hint, Full Recording hint, `.wav-note`, and the
download button's hover. Now once in body copy plus the hover.

### What shipped

- Show pages: the "Audio processing · `done`" pill and blurb cut (`STATUS_BLURB`
  deleted); password redundancy 4 → 1; `status_line()` now emits **only** the
  hand-work pills and returns `""` for the 22 shows with none.
- Sitewide (174 pages): the eyebrow above every `<h1>` cut — **the `eyebrow`
  parameter and all ten call sites went too**, not just the markup — and the
  footer's "Part of The Hannan Tapes archive" cut in both shells. `tagline` is
  now optional; passing `""` omits the element.
- Song pages (136): header is just the song title.
- `/contact/` sub, `/playlist/` help (3 paragraphs → 2), and `/process/`'s
  hand-bumped "Last updated", which was genuinely stale.
- Three orphaned CSS rules removed with their markup.

### ⚠️ The two things that must NOT be swept up in a round 2

**The variant disclosure note and the "These figures describe the archive
master" scope line are policy commitments, not clutter.** While Loud is the
default, `CLAUDE.md` requires every page with a player to say in plain words
which version is playing, and `/process/` to explain the cost. **Both read
exactly like the boilerplate that was cut**, which is why they are explicit
KEEPs in the plan §3 with their reasons. Verified live after the deploy: the
note on the show and song pages, the scope line on all 30 show pages.

### A round 2, if there is one

- **The noise-reduced pill renders twice** on the 8 shows carrying it —
  page-level and on the technical-data summary. Predates this work; more visible
  now the label row is gone.
- `/contact/`'s `.contact-section` still has `padding-top: 2rem`, which existed
  to sit under the sub that was cut. Slightly loose on desktop, fine on mobile.
- Layout/placement rather than copy, plus the editorial items in inventory §8
  (per-show descriptions, `/history/`, the homepage cards).

### Practical notes, still true

- Every change is a template edit in `scripts/sitegen/fragments.py` or
  `pages.py`, then `make build`. **There is no per-page HTML to edit.**
- Batch into one or two commits, not one per string — each is a rebuild.
- There is a **`content-editor` agent** for this kind of wording work.

## 🔭 Other open items (none blocking)

1. **The applause provenance data repair** — `plans/applause-provenance-repair/`,
   step 1 is ~20 min. Nothing depends on it.
2. **`plans/title-filename-consistency/`** — not started, and the only parked
   item with a *recurring* cost: `draft_tracks.py` re-derives titles from Drive
   filenames with zero preservation, so every corrected title is clobbered on
   the next reprocess. Only bites when publishing/reprocessing a show.
3. **`plans/share/`** — proposal, unblocked. Its §4 blocker **dissolved rather
   than resolved**: it waited on player-consolidation's URL-grammar decision,
   which was never made (Phase 3 parked). Whoever builds the timestamp piece
   owns that decision; the two in-scope pieces were never blocked.
4. ~~Retire `player-consolidation`~~ — **done.** Branch, remote and worktree
   are all gone; `git worktree list` is back to `main` plus whatever feature
   worktree is open.
5. **`origin/claude/hannan-chromebook-droplet-sync-jq0hfb`** — 2 ahead, 42
   behind. Nobody has opened it.
6. **Optional:** migrate the `/player/` popup onto `PlaybackController` — the
   last independent engine and the last consumer of the `window.HannanVariant`
   bridge. **Optional:** `scripts/build_archive_zip.py`, only if curated FLACs
   changed (they haven't).
7. ~~`/review-step` defaults to the player-consolidation plan~~ — **done.**
   `.claude/commands/review-step.md` now defaults to
   `plans/page-cleanup/page-cleanup-plan.md`. Repoint it whenever the current
   project changes: a review run against the wrong plan reads as confident and
   is wholly unusable.

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
   compare decoded md5. **24/26 bit-exact**; the two exceptions were the
   applause-limiter provenance defect, now fixed.
5. **Acoustic confirmation** — quietest-window RMS on the live file
   (**−99.3 dB**) vs the pre-NR source (**−51.4 dB**); above 8 kHz, −123.0 vs
   −69.9 dB. Above 8 kHz *during music* the two are within 0.2 dB, which is
   what NR at 6 dB / sensitivity 5 should look like: it acts in the gaps, not
   on the performance.

Two traps this hit, both worth knowing:
- **`astats` prints at `-v info`.** Running it under `-v error` silently
  yields no numbers — which reads exactly like "the measurement was zero".
- **Match staged filenames, not published ones.** Tracks 18 and 19 "failed"
  reproduction only because Audacity exported them as `18 Angel of
  Montgomery` and `19 Peacful Easy Feeling`, both corrected at publish.

## ⚠️ Measurement traps (audio work)

- **The sparsity screen is meaningless on archive input.** Near-peak density
  jumps ~9× (0.3 % → 2.8 %) purely as a **yardstick** effect: the first
  limiter pass lowered the peak the screen measures *against*. The music is
  not denser. Engagement and longest-event are the real signals; LRA is what
  says the dynamics survived.
- **Never baseline against `track-spec.json`'s stored `lra`.** Always render a
  local −20 control. Doing otherwise manufactured two phantom findings.
- **Always A/B as MP3, never FLAC**, and re-measure loudness on the MP3s since
  encoding shifts true peak.

## 🧹 Local disk

Most of the old cleanup list is done. Survivors:

- `~/work/_bench` (38 MB) — deletable.
- **Keep `~/work/jerry-19-broadway-1999-10-25/` (1.2 GB)** until the applause
  provenance scoping pass runs: it is the only staged source left and holds
  both known-bad tracks. `~/work/_applause_test` (the −20 regression fixture)
  was deleted this session, so fixtures now have to be built from a staged
  show's `tracks/`.

`rm -rf` is blocked for the agent — Rene runs these.

## Player consolidation — final state (closed)

- **Phase 1** (all show pages on shared `PlaybackController`) — complete, live.
- **Phase 2** (`/playlist/` migration, legacy engine deleted) — complete, live.
  `/assets/playlist.js` 404s.
- **Phase 3** (sticky mini-player) — **PARKED** on `miniplayer-parked`
  (`6bdecc6`), including Task 3's finished-but-uncommitted CSS. No page ever
  referenced the modules, so their deletion is invisible to visitors.
- **Optional remnant:** the `/player/` popup on `PlaybackController`.

**What survives from Phase 3 and is worth keeping:** song pages on the shared
controller; three real bug fixes on live pages its reviews turned up; the
`--player-*` token aliases in both stylesheets; and `onAnyExternalClaim()` in
`player-controller.js` (no subscribers, deliberately kept — inert and tested).

## Gotchas worth carrying forward

These came out of the player work but are general.

Added 2026-08-19:

- **Inventory before deciding, and count the generated output — not the data.**
  The handoff said "30 of 31 shows say `done`"; the live figure is 30 of 30,
  because the 31st is hidden and generates no page. And the strongest finding of
  the whole cleanup — one fact stated four times per show page — was on nobody's
  list. A register built only from remembered examples would have missed it.
- **Removing markup means removing its parameter too.** Cutting the eyebrow
  `<p>` while leaving `eyebrow=` at ten call sites would have left a dead
  argument that reads as load-bearing to the next person. Same for the CSS: a
  rule whose only selector is gone is a landmine, not a leftover.
- **Copy that reads like boilerplate is not always boilerplate.** The variant
  disclosure note is indistinguishable in tone from the lines being cut, and is
  a documented commitment. Write the KEEPs down *with their reason* in the same
  document as the cuts, or a later pass rediscovers them as clutter.
- **A shorthand CSS property resets its longhands, and inline beats
  stylesheet.** `style.background = ...` silently wipes a `background-size`
  set in CSS. When a rule depends on a longhand, every JS painter must assign
  the longhand too — and *find them all*: this one had five painters across
  four files where the notes named one.
- **Grep for every writer, not the one the doc mentions.** Two of the five
  were in degraded-mode fallback engines — the code paths nobody looks at, and
  therefore the ones where a regression survives longest.
- **A fixed sleep is not an assertion about the thing under test.** A 2.5 s
  wait with ~1 s of real margin produced exactly one spurious FAIL in a 185-
  check run. Poll for the condition. (This does not contradict "a flaky test
  is a bug report" below — the bug report was about the test.)
- **Verify a claim before repeating it, even your own.** Twice today a
  confident summary was wrong: "the branch was since merged" (it was not, and
  still held 3 commits) and "those are just HANDOFF notes" (they were the
  project's completion record). Both were one command away from being checked.
- **An "already shipped" branch is the dangerous kind.** It looks redundant,
  so it invites deletion — while still holding unmerged commits *and* a stale
  copy of every living document.
- **A PR that only adds a file can still be a regression.** PR #1's
  auto-generated `wrangler.jsonc` would have removed `"main"`,
  `run_worker_first` and a KV binding by *replacing* a file that had evolved
  past it. Diff a proposed config against the live one, never read it alone.
- **Two systems doing the same job is a problem even when both succeed.** Two
  deploy paths ran green on every commit for months; only one had an integrity
  gate, and whichever finished last won.
- **A workflow with no manual trigger is one stuck runner away from
  undeployable.** `cancel`, force-cancel and `rerun` can all fail at once.
  `workflow_dispatch` costs nothing and is the escape hatch.

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

- **`.progress-range` is a 24px pointer target drawing a 3px rail via
  `background-size: 100% 3px`.** Every painter must assign
  `style.backgroundImage`, never the `background` shorthand — five sites in
  `player-views.js`, `playlist-views.js`, `player.js` and
  `continuous-player.js` (×2). A shorthand write inflates the hairline to a
  24px bar.
- **The applause/tcap render state file is shared and mode-tagged.** Both
  modes write `.v8state.json` beside the output with a `"mode"` key; a resume
  refuses a file from the other mode. The `v8` name is historical. Files with
  no `"mode"` are transient-cap by construction and still resume.
- **The strict −1.00 dBTP re-check on resume is transient-cap-only.** The
  applause loop deliberately warns-and-keeps when it exhausts retries;
  applying the check to it would strand those tracks re-rendering forever.
- **`browser_check.mjs`'s variant pass needs its own browser context** — its
  first assertion is that a *fresh* profile defaults to loud with nothing
  persisted, which any earlier context that touched the toggle invalidates.

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
- `plans/applause-provenance-repair/` — not started, written 2026-08-18. The
  stored-provenance half of the applause defect above; step 1 is a 20-minute
  scoping pass that decides whether the rest is worth doing.
- `plans/share/` — proposal, unblocked; its stated blocker dissolved rather
  than resolved (see "Other open items").
- `plans/home-page/` — **closed**, shipped 2026-08-13. Its §8 records the
  stray second deploy mechanism, now disconnected.
- `plans/page-cleanup/` — **round 1 shipped** (PR #29). Register fully decided;
  removed copy recorded verbatim in its Appendix A, CSS included, so restoring
  anything needs no git archaeology. See "Page cleanup" above.
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
at `https://renedebos.com`. **First full `--prod` sweep ran 2026-08-19:
195/195**, after adding the variant pass and fixing one flaky timing
assertion. The long-standing "never actually run against production" loose end
is closed. Local run (which adds the breakage tests): **189/189**.

It takes ~7 minutes — run it in the background with an end-marker, not in the
foreground, or a 2-minute tool timeout will kill it.

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
(`~/.claude/skills/` or a project `.claude/skills/`).
