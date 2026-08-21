# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-21 (fifth pass) · **Branch:** `main` — everything merged, deployed, verified live

## ⛔ READ THIS FIRST

**Nothing is open.** No PRs, no unmerged branches, no stale worktrees. The
fourth pass's warnings are all resolved: **#48 merged** (the iPhone autoplay
cue is live), the branch sweep is done, and `main` = `origin/main` =
`2f2c765` (end of 2026-08-21). Local branches are `main` plus the deliberate `miniplayer-parked`
archive — the target state. (Two stray remote branches predate this pass and
were left alone: `claude/hannan-chromebook-droplet-sync-jq0hfb`,
`cloudflare/workers-autoconfig`.)

**The `/player/` continuous-player popup is GONE** (fifth pass, Rene's call).
`/player/` 301s to `/playlist/`; since the hash never reaches the server, an
old `/player/#p=<ids>` bookmark still lands on exactly that queue. Do not
rebuild a popup — the reasoning is in "The continuous player retired" below.

**Phase 3 is now HALF-unparked, and the halves must not be confused.** The
mini-player **bar** (view + CSS) shipped from the parked branch as an on-page
control and is live on every player surface. The **coordinator** — tab
identity, fenced lease, cross-page session restore, Stage 3a-canary Tasks 4–9
— stays parked on `miniplayer-parked` (`6bdecc6`). Never merge that branch
(it is stale against main — lift files from it, don't merge); never delete
it; don't resume the coordinator or run `/apply-review` on its findings
without Rene asking. The plan doc is
`~/.claude/plans/imperative-frolicking-widget.md`.

**Playback UX settled into one shape this pass. Don't re-litigate it:** the
bottom bar is the persistent control everywhere; nothing else sticks. The
show pages' sticky active row and `/playlist/`'s sticky now-playing card were
both tried and both deliberately removed/unstuck once the bar superseded them
— the same song pinned twice reads as a bug. `codex-notes.md` (untracked,
external review doc) still proposes popup/continuous-player ideas; they are
superseded by this.

## ✅ Done this session (2026-08-20/21, fifth pass)

Thirteen commits, all on `main`, each deployed and then verified against
production (not just a green Action) — plus three more later on 2026-08-21,
listed last below. The pass had two arcs: a metadata/
cleanup arc, and a playback-UX arc that ended with the mini-player bar as the
site's one persistent player control.

### Drive source filenames reconciled with the catalog (`0ec0772`…`a82a656`)

New tool pair: `scripts/title_match.py` (the one positional filename↔title
comparison, shared by its three callers so the build can't warn at a
different threshold than the sync tool holds) and
`scripts/sync_source_titles.py` (sweeps every Work Folder's `Tracks/` — NR
folder wins — against `recordings.json`, `apply=1` renames on Drive).
15 drifted filenames renamed; `data/source_names.json` is the tracked
listing cache the offline build warning reads. Two traps now encoded in
comments there: the 1999-08-23 show's **unlabelled folder is the FIRST tape**
("Pt1 Distorted" names the reel, not the page order — do not "fix" the
order), and `sanitize()` maps `/` → ` - ` because a medley title with the
slash deleted matches nothing in the archive. Also fixed mid-sweep:
`mad-sweetwater-2000-02-17`'s Drive numbering (two 18s, no 21), verified
against published R2 keys before renaming.

### Show/song pages: one tracks toolbar (`fad9675`, `2928e75`)

The Archive/Loud control and the Select-all/ZIP pills — previously two
toolbars in two visual languages — are one row of same-height controls
(`.tracks-toolbar`, `--ctl-h`, 44px on coarse pointers). The "Downloads
default to the Archive master" sentence and the "How these were made" link
are gone (the download modal's own chooser states the format at the moment
it matters); **the "You are hearing the Loud version" disclosure stays** —
it is the price of the Loud default and must not be removed. ZIP button
briefly carried its size on its face; **moved into the password modal on
2026-08-21** — each version option now shows its own size (Archive FLAC vs
Loud MP3), for single tracks, whole-show transfers and every ZIP, and a
chooser-less download (complete-archive ZIP) gets a one-line `ZIP · 25.3 GB`.
The loud size is `size_mb` (the archive MP3's): measured against all 680
`MP3-14/` + `MP3/` objects in R2, the two differ by ≤ 7 bytes. Separately,
23 show descriptions lost their processing-boilerplate paragraph (that story
lives at `/process/`).

### /playlist/ page slimmed (`658f1bc`)

The **Songwriter filter facet is gone** (its UI only — `SONGWRITER_MAP` and
the matching stay, because the "Traditional & Irish" preset is expressible
ONLY through the songwriter field; the `traditional` tag was retired
2026-07-19). The **folk/country/blues/rock tag chips are gone** from
`TAG_ORDER` — 94/680 tracks between them, thin playlists. The tags remain on
the tracks and in /search/; no data or vocabulary change. **Rene: no "All
tags" chip** — asked and declined.

### The continuous player retired (`d791332`)

The `/player/` popup + `continuous-player.js` (~700 lines): deleted, not
migrated. It was desktop-only by construction (a phone gets a tab, not a
popup, and backgrounded tabs suspend audio), undiscoverable, untested, and
the last surface on the legacy engine. `/player/` → 301 `/playlist/` in
`LEGACY_REDIRECTS`; hash survives, so old share links still build their
queue. `sendToPlayer()`, `#pl-player`, and track-select's "Add to player"
went with it.

### Sticky experiments, then the real answer (`dac34eb`, `d791332`, `05c33b7`, `a09e93f`, `e695c32`)

The path matters because two shipped steps were then deliberately undone:

1. `/playlist/`'s now-playing card was found sticking BEHIND the sticky site
   header (top:0 vs the header's z-index 10). Fixed by deriving the offset:
   `--header-pad`/`--mark-h`/`--header-h` tokens in `site.css` — any future
   sticky element should use `top: var(--header-h)`, never a literal 79px.
2. Show pages got a sticky active track row. Shipped, worked, **removed one
   day later** — superseded by the bar (and its `overflow: clip` enabler on
   `.track-list` reverted to `hidden`).
3. **The mini-player bar (Option A)**: `miniplayer-views.js` + its 39-test
   suite + the `.mini-player` CSS lifted from `miniplayer-parked` onto main —
   both parked suites passed UNMODIFIED against today's controller despite
   82 lines of drift. The review's `_paintRange` defect fixed on the way in
   (backgroundImage, never the `background` shorthand — the shorthand resets
   background-size and inflates the 3px rail to the 24px tap box). Root div
   emitted by the page builders; **every boot imports the bar DYNAMICALLY so
   a broken bar asset costs the bar, never the page**.
4. **Unified + shuffle** (`e695c32`): /playlist/ (card unstuck, stays as
   queue header), all 136 song pages, and /songs/ mount the same bar. Shuffle
   button added (Rene asked; 138px title space measured at 390px), driven by
   `controller.toggleShuffle()` so the bar's and the card's buttons are two
   views of one state. Hides with prev/next on singleton queues. The mount
   policy (close = pause + unmount; the audio's next 'play' remounts) lives
   ONCE in `attachMiniPlayerBar()`, exported from the view module and called
   by all three boots — three hand copies is how engines drift.

`miniplayer-state.js` is on main in `scripts/` ONLY (never built to assets):
the view suite exercises its real codec, and its own 126-test suite now runs
in CI via the `test-*.mjs` glob — so controller changes that would break the
parked coordinator's assumptions fail CI even though nothing ships it. That
is deliberate.

### Later on 2026-08-21: pills, modal sizes, and a bar that never hid (`3674a52`, `e70848b`, `e024b5b`)

- **Hand-work pill once per show page** (`3674a52`): the noise-reduced /
  pre-edited / corrective-eq pill was emitted twice (status line + the
  Technical-data `<summary>`); the summary copy is gone. `/contact/` lost an
  orphaned `padding-top` from page-cleanup round 1.
- **Download sizes moved into the password modal** (`e70848b`): the ZIP pill
  reads just "Download ZIP"; the modal names a size beside *each* version on
  every surface (track, show/song/playlist ZIP, whole-show transfer incl.
  alternates). The loud size is the archive MP3's `size_mb` — measured over
  all 680 `MP3-14/` vs `MP3/` objects, ≤ 7 bytes apart, same rounded MB on
  every one, so no new field. `fmt_size_mb()`/`formatSizeMb()` share one
  integer half-up GB rounding (`:.1f` and `toFixed(1)` disagree on exact .x5).
  Codex review caught the alternate-transfer cards left sizeless; fixed
  before shipping.
- **Playlist selection bar never hid** (`e024b5b`, Rene found it): the
  "N songs selected · Clear · Build playlist" bar toggles `hidden`, but
  `.track-select-bar { display: flex }` beat the UA `[hidden]` rule, so Clear
  and un-ticking emptied the selection while the bar stayed on screen —
  broken since the feature landed on 2026-07-13. One-line
  `.track-select-bar[hidden] { display: none; }` fix; a parse of every other
  `hidden`-toggled element found no further bare `display` rule.
- **"All songs by artist X" made reachable** (Rene's use case: every song Sean
  & Jerry Hannan did). Two gaps: `/search/` listed nothing without typed text —
  a filter chip only changed the count — and `/songs/`'s artist switch was a
  hand-written All/Jerry/Mad/Sean that omitted "Sean & Jerry" although the
  legend showed it. Now `/search/` **browses** when the box is empty and any
  chip is set (uncapped, title→date order; query mode keeps the 60 cap), and
  the chips live in the URL (`?artist=…&type=…&source=…`, unknown values
  ignored). `/songs/`'s switch is generated from the same `present` list as
  the legend, so the two can't drift again.

## ✅ Done this session (2026-08-19, fourth pass)

### 🔴 The autoplay bug — "Play random tape" failed on every iPhone (PR #48; merged in the fifth pass)

The homepage's **"Play random tape"** navigates to
`/shows/<slug>/?autoplay=1#track-N`. **User activation does not survive a
navigation** — the tap happened in the *previous* document, so the `play()` the
show page makes on arrival has no gesture behind it and the browser rejects it:

    NotAllowedError - play() can only be initiated by a user gesture.

Desktop Chrome and Safari allow it anyway on the strength of their
media-engagement heuristics. **iOS Safari and Firefox never do.** So on a phone
that button failed 100% of the time, and the row read "Playback failed — tap to
retry" with the button relabelled "Retry".

**Nothing was broken.** The track was queued, highlighted, scrolled to and one
tap from playing. It was only being *dressed* as a failure. It now says
**"Tap play to start"** in muted type, keeps an ordinary "Play" button and takes
no failure styling — the same resolution `continuous-player.js` already used for
a restored queue ("press play to resume").

**The controller deliberately keeps ONE state for both.** The remedy — a `play()`
from a real gesture — is identical, which is what lets `toggle()` treat them
alike. The **view** separates them, on the error's `name`, guarded by the item id
exactly as `_lastPlayError`'s own contract requires. Don't "simplify" that into a
new controller state without re-reading the six consumers of `state === 'error'`.

**How it survived: `browser_check.mjs` had an assertion that locked in the bug.**
It correctly detected the block, *logged* `(autoplay was blocked by browser
policy this run)`, and then asserted that the error UI was correct. A green suite
over a bug every iPhone visitor hit. That assertion now asserts the cue.

**Reproducing it needs no phone**, which is the part worth keeping:

    chromium --autoplay-policy=user-gesture-required
    -> https://renedebos.com/shows/<slug>/?autoplay=1#track-3

Reproduced against **live production** on the first attempt.

**Two dead ends shipped first, and both are now corrected in the code:**
- **#46** added `load()` on every source change and its comments claimed this
  fixed the iPhone report. **It did not.** The line is kept (both paths now
  re-select the resource the same documented way) but no longer claims to be a
  fix. Its test is kept for the contract, not the bug.
- **#47** added a `?diag=1` diagnostic to read the real rejection off a phone.
  It did its job — the string above came from it — and #48 **deletes it**.

The first report was *"refresh, then the first track tapped fails"*, which sent
the search down the wrong path entirely. Rene's later correction — *"it's the
Play random tape button"* — is what cracked it.

### The show-page track list got substantially denser (#43, #44, #45)

**A waveform now renders only on the active row** (playing *or* paused), not on
all ~31. Measured on a real page: rows 43px → 37px, the list 1358px → 1172px.

This introduced **`.is-active` as distinct from `.playing`**, and the distinction
matters: `.playing` is stripped on pause, so keying the waveform to it would
leave a paused row showing a waveform with nothing saying why. `.is-active` means
"this row holds the audio position"; `.playing` means "sound is coming out now".

The active row is also visually stronger (accent bar, accent title, filled play
button) and the waveform **animates in** — as a keyframe animation, not a
transition, because it crosses `display: none → block`.

Two follow-ups fixed mobile: the active row's wrapped download/add icons were
left-aligned instead of lining up with the idle rows' right-aligned ones (#44),
and the active row wrapped its metadata onto a second line (#45).

**Long titles now clamp to two lines.** Worth recording *why*, because the first
measurement was wrong: an initial "0/31 titles truncated" came from measuring
`scrollWidth > clientWidth` on a height-clamped element. The real figures were
**17/31 clipped on one line vs 3/31 on two**, which reversed the recommendation.

### Show pages lost two blocks and gained per-file sizes (#34, #35, #36, #37)

- The **"Audio processing · `done`"** badge is gone from the technical-data
  summary — every show is `done` except the one hidden show.
- The **"Full shows stream as 320 kbps MP3."** line is gone.
- Full-show recording cards now read **`FORMAT WAV (2.13 GB)`** and
  **`STREAM MP3 320 kbps (453 MB)`** — each size sits with the file it describes,
  which drops a line *and* removes the "one size, two files" ambiguity. All 69
  `stream_size` values were collected by HEAD request against the live worker.

**Gotcha:** `recording_card()` runs meta values through `esc()`, so `&nbsp;`
renders as literal text. Use a real U+00A0.

### Full shows became downloadable in both versions (#39)

The full-show download offered lossless only; it now uses the same Archive/Loud
chooser as per-track downloads. **Read "The loud download" below first** — the
no-sticky-preference rule is a deliberate decision, not an oversight.

### `/songs/`'s variant toggle became a deferred reveal (#40)

The premise for removing it — "there is no player on that page" — turned out to
be **false**: `/songs/` inserts players lazily per `<details>`, and the toggle
really does flip `MP3-14/` ↔ `MP3/`. Removing it would have broken the
disclosure commitment. It is now hidden until a song is expanded and rows exist.

**This also fixed a live wrong-fact bug:** `variant-ui.js` was overwriting the
server-rendered note with *"Downloads are always the Archive version"*, which
stopped being true on 2026-08-19 when the loud download shipped. The prose now
lives in one place.

### Accessibility and a reverted "fix" (#41, #42)

Artist dots got accessible names. The add-to-playlist control was resized to
match its neighbours and Rene **reverted it** — the 19px/18px sizes are
deliberate (play primary, download secondary, add tertiary) and were never equal
to the download button. There is now a comment saying so, so it is not "fixed"
again.

### `/history/` brought up to date (#38)

"The Story So Far" now runs through August 19 (weeks fifteen to eighteen).

## ✅ Done this session (2026-08-19, third pass)

### Cloudflare Web Analytics was never actually collecting
The zone has Web Analytics on and Cloudflare injects `beacon.min.js` at the
edge, but `script-src` blocked it on **every page** — a CSP violation in the
console and zero data collected, for however long it had been enabled. Found
by chasing a single console error on a production spot-check rather than
shrugging at it.

**Allowed by HOST, not by the documented path.** Cloudflare's docs say to add
`https://static.cloudflareinsights.com/beacon.min.js`. That would not have
worked: the real request is `.../beacon.min.js/v4513226c...`, and **a CSP
source path only prefix-matches when it ends in `/`** — otherwise it must
match exactly. The documented source would have looked right and kept failing
silently.

No `connect-src` change was needed and none was added: under *automatic*
injection the beacon posts to same-origin `/cdn-cgi/rum`, covered by `'self'`.
Confirmed rather than assumed — see the verification note below.

**`build.py --check` now fails if `site_worker.js` and `_headers` declare
different CSPs.** Both files define one; only the Worker's takes effect
(`secure()` calls `headers.set()` on every response, overwriting `_headers`),
which makes `_headers` easy to forget and a stale copy worse than none. The
check parses both rather than hardcoding the policy, and was verified by
**mutation**: reverting `_headers` exits 1, restoring it exits 0.

### The -14 variant became downloadable
PR #31, Rene's request. An Archive/Loud chooser in the password modal — the
one funnel every download passes through — so a single control covers track
buttons, the show ZIP, the song ZIP and the playlist ZIP. **Full reasoning in
"The loud download" below; read it before touching a download path.**

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

## 🔊 The loud download (new 2026-08-19, PR #31)

The -14 variant is now offered as a **download**, not only as a stream. Read
this before touching any download path: the constraints below are decisions,
not implementation details, and none are obvious from the code.

**It is a FORMAT choice, not a volume switch.** Archive is lossless FLAC at
-20; Loud is 320 kbps MP3 at -14. Everything else follows from that:

- **Archive is preselected on every open and the choice is deliberately NOT
  remembered.** A sticky preference would quietly hand out lossy files for the
  rest of a session after one click. Do not "improve" this by persisting it.
- The option sub-labels say **"lossless"** and **"not lossless"** outright.
  Do not shorten them to just the loudness figures.
- A loud ZIP renames its folder and info file and appends a provenance note.
  A download is the one place someone holds this audio with no page around it
  to say what it is.

**Where the option is withheld, and why:**

- **All 67 whole-show recordings** — no -14 render exists, so the modal hides
  its version control rather than offering a dead option.
- **Any ZIP where not every file has a variant.** All-or-nothing: a silently
  mixed archive is indistinguishable from a correct one once unpacked, and no
  filename in it would say which track was which. All 680 curated tracks have
  both renders today, so every ZIP qualifies — the guard is for when that
  stops being true.

**No Worker change was needed and none was made.** `/download` is
key-agnostic and `audioType()` already returns `audio/mpeg` for anything that
is not `.wav`/`.flac`. Only `/stream` restricts formats, and that is the rule
refusing lossless. The whole feature is client + template.

**One subtlety worth keeping:** `/auth` signs `${file}:${expires}`, so the
version choice must resolve **once** and feed both `/auth` and `/download`.
`resolveTarget()` in `player.js` exists for exactly that; splitting it would
produce a 401 that looks like a password problem.

The playlist ZIP is built client-side from `assets/tracks.json` (which already
carries the variant key), and its provenance note is asserted byte-identical
to the server-built one — an unpacked ZIP should not reveal which code path
made it.

**Three documents said downloads were archive-only and are now updated:**
`CLAUDE.md`, the on-page variant note, and `/process/`. The variant note is
the standing disclosure commitment while Loud is the default playback
variant — it cannot be left stale.

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

**The note's wording changed on 2026-08-19** (PR #31): it used to end
"Downloads are always the Archive version", which the loud download made
false. It now says downloads *default* to the Archive master and the download
box offers the louder MP3. The commitment is unchanged — only the fact it
states. Any future change to what downloads offer has to come back here.

### Round 2 happened, mostly on the show page (fourth pass)

Not run from the register — driven ad hoc by Rene, item by item. What went:
the `done` status badge, the "Full shows stream as 320 kbps MP3." line, the
standalone Size row on recording cards, and (a layout rather than copy cut) the
waveform on every non-active track row. Detail in the fourth-pass log above.

**Still open from the original round-2 list:**

- ~~The noise-reduced pill renders twice~~ — **done 2026-08-21** (`3674a52`):
  the tech-table `<summary>` copy was dropped; the page-level pill from
  `status_line()` is the one that stays. Verified live on the 8 shows.
- ~~`/contact/`'s orphaned `padding-top: 2rem`~~ — **done** in the same
  commit; `main`'s own 4rem top padding already provides the gap.
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
6. ~~Migrate the `/player/` popup onto `PlaybackController`~~ — **resolved by
   deletion, fifth pass**: the popup is gone entirely (see "The continuous
   player retired"). **Optional:** `scripts/build_archive_zip.py`, only if
   curated FLACs changed (they haven't).
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

## Player consolidation — final state (closed; amended fifth pass)

- **Phase 1** (all show pages on shared `PlaybackController`) — complete, live.
- **Phase 2** (`/playlist/` migration, legacy engine deleted) — complete, live.
  `/assets/playlist.js` 404s.
- **Phase 3** (sticky mini-player) — **SPLIT in the fifth pass.** The view
  layer (`miniplayer-views.js` + CSS) is UNPARKED and live on every player
  surface as an on-page bar. The coordinator (cross-page persistence, Stage
  3a-canary Tasks 4–9) stays **PARKED** on `miniplayer-parked` (`6bdecc6`).
  That branch is now stale against main — lift files, never merge it.
- **The `/player/` popup remnant is resolved by deletion** (fifth pass): the
  popup and `continuous-player.js` are gone, `/player/` 301s to `/playlist/`.
  There is no engine left outside `PlaybackController` except `player.js`'s
  deliberate runtime fallback. Consolidation is genuinely finished.

**What survives from Phase 3 and is live:** the bar itself; song pages on the
shared controller; three real bug fixes on live pages its reviews turned up;
the `--player-*` token aliases (now seven, in site.css — home.css's mirror
still lives only on the parked branch); and `onAnyExternalClaim()` in
`player-controller.js` (no subscribers, deliberately kept — inert and tested).

## Gotchas worth carrying forward

These came out of the player work but are general.

Added 2026-08-21 (fifth pass):

- **An author `display` silently defeats the `hidden` attribute.** The UA
  `[hidden] { display: none }` rule loses to any `.foo { display: flex }`, so
  an element that shows/hides via `el.hidden` needs its own
  `.foo[hidden] { display: none; }` (or `.foo:not([hidden]) { display: … }`).
  Bitten four times now: `.pl-now`, `.mini-player`, `.variant-reveal`, and the
  playlist selection bar (which never hid for five weeks).

Added 2026-08-19 (fourth pass):

- **User activation does not survive a navigation.** A click on page A cannot
  authorise `play()` on page B. Any "click here and it starts playing over
  there" flow is a blocked autoplay on iOS Safari and Firefox, always — and
  works on desktop Chrome/Safari, which is exactly what hides it. If a feature
  navigates in order to play, design for the block; do not treat it as an edge
  case.
- **A blocked autoplay is not an error, and must not be styled as one.** The
  browser is asking for a gesture, not reporting a fault. Cue the row and say
  what to do. `NotAllowedError` is the reliable signal.
- **A test can lock in a bug and still be green.** `browser_check.mjs` detected
  the blocked autoplay, logged that it had happened, and then asserted the wrong
  UI was correct. When writing an assertion about a degraded path, ask what the
  *right* behaviour is — not what the code currently does. This one shipped a
  100%-reproducible iPhone bug past a passing suite.
- **Don't ship a fix you cannot reproduce.** #46 was inferred from the only
  functional difference between a failing and a succeeding attempt. The
  reasoning was sound and the conclusion was wrong. What actually worked was
  reproducing it — in this case `--autoplay-policy=user-gesture-required` in
  Chromium against **live production**, no phone required. Reach for the
  reproduction before the hypothesis.
- **Take a bug report's wording literally, then re-ask.** "After I refresh, the
  first track fails" and "the Play random tape button fails" describe the same
  symptom and *completely* different code paths. The first reading cost two
  PRs. When a repro attempt doesn't reproduce, that is information about the
  description, not just the code.
- **Measure the thing you actually changed.** A "0/31 titles truncated" figure
  came from testing `scrollWidth > clientWidth` on an element already clamped by
  height. The true figures (17/31 vs 3/31) reversed the recommendation.

Added 2026-08-19 (third pass):

- **A CSP source path only prefix-matches when it ends in `/`.** Otherwise it
  must match exactly. Cloudflare's own documented source
  (`.../beacon.min.js`) would never have matched the versioned URL actually
  requested (`.../beacon.min.js/v4513226c...`). Vendor docs can be wrong about
  their own vendor.
- **A header is not proof a third-party script works.** The only real check is
  driving a browser and watching for both the script `200` *and* its report
  request succeeding — here `POST /cdn-cgi/rum -> 204`. A correct-looking CSP
  with a blocked beacon looks identical to a working one from `curl -I`.
- **Chase the single console error.** One unexplained error on a production
  spot-check turned out to be analytics that had never collected anything. The
  temptation to write it off as "some Cloudflare thing" was the whole trap.
- **Kill your own local servers before running the browser sweep.**
  `browser_check.mjs` copies the site to `PORT + 1` (8124) for the breakage
  tests; a stray `python3 -m http.server 8124` left over from taking
  screenshots serves the real tree instead, so the deliberately-deleted
  modules load fine and **12 checks fail** in a way that reads exactly like a
  code regression. Cost a full re-run to diagnose.
- **Don't claim a test exists before writing it.** A commit message here
  asserted a CSP-sync check that did not exist. The fix was to write the check
  (and verify it by mutation), not to soften the message.
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

- **The download version chooser never remembers the last choice.** It resets
  to Archive on every open. The two options are different *formats*, so a
  sticky preference silently hands out lossy files. See "The loud download".
- **`resolveTarget()` resolves the Archive/Loud choice exactly once**, feeding
  both `/auth` and `/download`. `/auth` signs `${file}:${expires}`; resolving
  twice, or resolving after `/auth`, produces a 401 that presents as a wrong
  password.
- **A loud ZIP is offered only when EVERY file in it has a variant.** Never
  relax this to "as many as we have" — a mixed archive cannot be identified as
  mixed after unpacking.
- **`site_worker.js`'s CSP is the one that takes effect**, not `_headers` —
  `secure()` calls `headers.set()` on every response. Both must be updated
  together; `build.py --check` fails the build if they diverge.

- **`.progress-range` is a 24px pointer target drawing a 3px rail via
  `background-size: 100% 3px`.** Every painter must assign
  `style.backgroundImage`, never the `background` shorthand — four sites now
  (fifth pass: `continuous-player.js`'s two died with it,
  `miniplayer-views.js` joined): `player-views.js`, `playlist-views.js`,
  `player.js`, `miniplayer-views.js`, one each. A shorthand write inflates
  the hairline to a 24px bar.
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

**Tests:** `node scripts/test-*.mjs` — 8 suites plus `test-fake-dom.mjs`
(a helper). **329/329 passing** as of 2026-08-21 (fifth pass; the two
mini-player suites came back with the bar — see "Sticky experiments" above):

| suite | tests |
|---|---|
| `test-miniplayer-state.mjs` | 126 |
| `test-miniplayer-views.mjs` | 39 |
| `test-player-controller.mjs` | 58 |
| `test-player-boot.mjs` | 28 |
| `test-playlist-state.mjs` | 29 |
| `test-player-views.mjs` | 20 |
| `test-playlist-views.mjs` | 16 |
| `test-song-boot.mjs` | 13 |

(History: the fourth pass ran 164 after the two mini-player suites, 164
tests, were deleted with the parked modules; the fifth pass lifted them back
UNMODIFIED and 165 → 329. `test-player-controller.mjs` went 60 → 57 in the same
commit, then 57 → 58 with the `load()`-on-source-change contract. The three
tests added to `test-player-views.mjs` in PR #48 cover the blocked-autoplay
cue, that a real failure still reads as a failure, and that a stale block from
one track cannot leak onto another.)

Also clean: `python3 scripts/build.py --check` (integrity OK, 31 shows, 680
curated tracks, no orphan song pages). Since 2026-08-19 that command also
**fails the build if `site_worker.js` and `_headers` declare different
CSPs** — see `scripts/sitegen/_csp_check.py`.

**Real-browser verification:** `scripts/browser_check.mjs` — needs
`playwright-chromium`, a **global** install here, so run it as
`NODE_PATH="$(npm root -g)" node scripts/browser_check.mjs`. `--prod` points
at `https://renedebos.com`. **First full `--prod` sweep ran 2026-08-19:
195/195**, after adding the variant pass and fixing one flaky timing
assertion. The long-standing "never actually run against production" loose end
is closed. Local run (which adds the breakage tests): **193/193** as of the
fourth pass.

It takes ~7 minutes — run it in the background with an end-marker, not in the
foreground, or a 2-minute tool timeout will kill it.

**Kill any local static server on 8124 first.** The breakage tests copy the
site to `PORT + 1` and rename modules away; a stray server on that port serves
the real tree instead, and 12 checks fail in a way indistinguishable from a
code regression.

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
