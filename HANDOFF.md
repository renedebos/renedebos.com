# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-19 · **Branch:** `main` — everything below marked ✅ is committed & pushed, deploy verified live. **`jerry-19-broadway-2001-01-15` is NOT shipped and has uncommitted, currently-broken working-tree state — read its section before touching that show.**

> Long session: pushed a batch of accumulated metadata-editor edits, retired
> two tag-vocabulary entries, added a playlist songwriter filter and
> process-version hover info, then spent most of the session reprocessing
> v1/v2 shows to the current engine (workflow v7) at Rene's request. Three
> of four reprocesses shipped clean. The fourth (`2001-01-15`) hit a
> filename/folder-path bug that's still open — see below, don't assume it's
> done just because earlier work in this same session said "0 mismatches."
> Also explored a full visual redesign of `/search/` via an Artifact
> mockup; Rene rejected it, nothing was built from it. Fixed three
> genuine (non-cosmetic) bugs on `/search/` along the way and carried the
> same default-sort fix to `/archive-data/`.

## ✅ Done this session

### 1. Pushed a backlog of metadata-editor edits (commits `29adb08`, `a4f27fb`, several more)
Rene had unsaved edits sitting in the metadata editor across several
`git push` requests through the session: tag/songwriter corrections on a
handful of tracks, Kelly Peterson guest-appearance credits (`guest` tag +
artist override) added consistently across her tracks and two Jerry Hannan
& Demir covers, a "Good Life" → "The Good Life" title fix, and — later —
tape-damage (`dropouts`) flags plus a couple of tags on the
`jerry-19-broadway-1999-08-23` "Part 1 (Distorted)" batch (tracks 15–21).
One of these batches also had a typo (`erry Hannan & Sean Hannan` missing
the leading "J" on `sean-19-broadway-unknown` track 11) — caught and fixed
before pushing rather than shipping the typo.

### 2. Fixed a mistitled/duplicate song (commit `e5a7973`)
`jerry-19-broadway-1999-06-07` track 27 was titled "Come On All You Young
Maidens" — actually the same traditional song already correctly catalogued
elsewhere as "A Bunch of Thyme" (confirmed: same opening lyric). Renaming
merged both performances onto one canonical `/songs/a-bunch-of-thyme/`
page and dropped the now-orphaned `/songs/come-on-all-you-young-maidens/`
per the build's own integrity check (`git rm -r songs/...`).

### 3. Retired two tag-vocabulary entries (commits `4a1e4e2`, `77ded5e`)
- **`story`** — Rene's call, no replacement; stripped from 51 tracks.
- **`traditional`** — fully redundant with `songwriter: Traditional` (unlike
  `cover`/`original`, which stay since a cover's writer can be unknown);
  stripped from 69 tracks. The playlist's "Traditional & Irish" preset and
  any traditional-song filtering now goes through the **Songwriter** facet
  instead of a tag.

Both removals: dropped from `TAG_VOCAB` in `scripts/sitegen/core.py`,
`TAGS.md`, and `scripts/playlist.js`'s `TAG_ORDER`/presets.

### 4. Playlist: songwriter filter + label tweak (commits `bb4e8bb`, `e321e09`)
New **Songwriter** facet on `/playlist/`: `Jerry & Sean` (original),
`Traditional`, `Lennon & McCartney` (merges the catalog's two raw spellings
— `Lennon-McCartney` / `Lennon & McCartney` — under one chip), `Steve
Poltz`. Renamed the "original" label from "Jerry & Sean Hannan (original)"
to just "Jerry & Sean" per Rene's request.

### 5. Metadata editor: song-list view + column widths (commits `5582ce5`, `1ce171b`, `ce3a838`)
Added a "Song list" toggle that flips the per-show accordion into a flat,
alphabetized table of every track — searching a song title now surfaces
every performance across every show in one screen, for fast batch tag
editing. A later width-rebalance request ("Title too wide, Tags too
narrow") was first applied to the wrong view (per-show table) and had to
be moved to the actual `#songTable` view once Rene caught it — Title 20%,
Tags 33%, with ellipsis truncation.

### 6. Process-version in hover popups (commit `ea42edd`)
The song-page hover popup already showed a track's workflow version; added
the same "Process version" row to (a) each track's hover popup on its own
**show page**, and (b) the **playlist queue's** track-info popup. Needed a
new `procVer` field on `assets/tracks.json` (`scripts/sitegen/feeds.py`) —
distinct from that file's existing `ver` field, which is an unrelated
MD5-prefix cache-buster, not a workflow version.

### 7. Reprocessed 3 of 4 targeted v1/v2 shows to v7 — ✅ shipped
Rene asked to bring the archive's remaining pre-v4 shows up to the current
engine. Full archive-wide audit found 12 shows on v1/v2; verified real
Drive state (not assumptions) before touching anything, catching two false
negatives from Drive-API rate-limiting in the process. Shipped:

- **`jerry-19-broadway-1999-06-21`** (commit `2e11001`) — v1→v7. Diagnose
  clean (no CLIPPING). Caught and fixed a stray trailing-space filename
  collision that briefly duplicated 2 tracks in R2, and restored 3 titles
  the fresh hand-edit export had corrupted (`_` substituted for `/` in two
  slash-titled tracks — filesystem can't hold `/` in a filename — plus one
  shortened title) back to the catalog's established names.
- **`jerry-19-broadway-1999-05-10`** (commit `594bfef`) — v2→v7. **3 tracks
  flagged full CLIPPING** (Model Family Man, Luxury of Murder, The Parting
  Glass) — sent back to Rene per the runbook. First re-export round-trip
  didn't actually change the audio (same MD5 as before — the Audacity
  export hadn't picked up the fix); second round-trip did. Also caught a
  **pre-existing, unrelated** FLAC/MP3 naming mismatch on "Hear Me" — its
  MP3 had been misnamed "I Need a Lover" since the original 2026-07-09 v1
  publish, nothing to do with this reprocess.
- **`jerry-19-broadway-1999-07-19`** (commit `594bfef`) — v2→v7. No
  clipping. Caught two title regressions where the fresh export used
  different names than the established catalog ("She is The Girlfriend of
  The Boyfriend of Herself" vs "The Girlfriend of The Boyfriend of
  Herself"; "Leprechaun" vs "The Barney Stone Blues") — confirmed same
  audio via exact duration match, Rene chose to keep the **old** titles for
  both.
- Both of the above hit the same R2 duplicate-key gotcha as `1999-06-21`
  (fresh export uses a different filename than the archived original →
  `rclone copy` creates a new object instead of overwriting → track-count
  check fails) — same fix each time: rename the local `out/` file to match
  the established title, delete the stray R2 object, re-upload.
- A separate bug surfaced and got fixed in commit `5d157fc`: regenerating
  `data/processing/*.json` provenance for these two shows (after an
  unrelated `git checkout` accident, see gotcha below) produced a
  correctly-v7 **audio** render but a stale **`ver: 2` label** in the
  provenance JSON — the resume-skip logic faithfully trusted whatever was
  in the (accidentally-reverted) provenance file for the "what actually
  rendered this track" field. Site was briefly showing "Process version:
  v2" on genuinely-v7 tracks. Corrected directly (`ver` → `7` for every
  affected track) rather than re-rendering (audio was never wrong).

### 8. `/search/` — 3 real bugs fixed, sort order changed (commits `9423296`, `b969111`, `bda4a90`)
While investigating a planned visual redesign, found and fixed:
- **Unbounded result list**: a broad query ("hannan") rendered all 709
  matches with zero cap — a **66,748px-tall** mobile page. Capped at 60
  with a "showing X of Y" status when truncated.
- **AUD/SBD badge rendering at browser-default link style** (16px,
  link-blue, body font) instead of the site's actual small-badge component
  (`.src-tag`, already used on Archive/Updates) — `search.js`'s `srcTag()`
  built the class `sr-src src-aud`/`src-sbd` but never included the
  `src-tag` class that actually carries the styling. One-line fix.
- **The "Archive Data" footer link** rendered unstyled (same root cause as
  the badge, different mechanism — it wasn't inside the `.about` wrapper
  that gives every other in-prose link its accent-green treatment). Scoped
  `.about a`'s styling to `.pl-intro a` instead (shared with `/playlist/`).

Also **tried and reverted** a song-grouping feature (25 "Truck" rows →
1 row w/ "25 performances", triggered above a 3-match threshold) — Rene
disliked the inconsistency (a 2-performance song stayed ungrouped next to
grouped 3+ ones) and asked to undo it. Reverted cleanly (commit `87e20c0`),
kept the cap + link fixes. **Sort order changed** on Rene's request
(commit `b969111`, extended to `/archive-data/` in `adf488a`): both pages
now sort by **title, then date, then track number** instead of
text-match-relevance score — searching a songwriter's name now groups all
their songs together chronologically instead of scattering them by score.
Needed a new `num` field on the search index.

### 9. Visual redesign of `/search/` — explored, rejected
Built a full interactive Artifact mockup (real site fonts inlined,
existing color tokens, live sample-data filtering) addressing Rene's brief
(whitespace, typographic hierarchy, search-bar-as-focus, grouped/labeled
filters, active-filter chips, results-dominant). **Rene didn't like it —
explicitly told not to build it.** Nothing from the mockup was ported into
`search.js`/`site.css`. Don't re-propose the same direction without new
input from Rene on what specifically didn't work.

## ⚠️ NOT done — `jerry-19-broadway-2001-01-15` is broken in the working tree, uncommitted

**Do not commit `data/recordings.json` as it currently sits without fixing
this first.** Audio is genuinely fine on R2 (verified, real v7 render) —
the problem is entirely in the catalog data pointing at the wrong place.

**What happened:** Splice.flac (a stray point-label artifact, confirmed by
Rene as safe to ignore) got removed from both local staging and the real
Drive `Tracks/`+`labels.txt`. Reprocessing produced 4 titles that
disagreed with the established catalog (State Trooper/Highway Patrolman,
Everything/Everything Reminds Me of You, Four Leaf Clover Inn/The Barney
Stone Blues, Never Knew a Woman/Woman) — **Rene chose to keep all 4 old
titles**, applied directly to `recordings.json` by hand (not by renaming
the `out/` files, unlike the `1999-06-21`/`1999-07-19` fixes — this is the
root of the bug below). Verification and the Drive `Processed/` backup
were in progress when **something outside this session deleted the entire
local `~/work/` staging tree** (`1999-05-10`, `1999-07-19` — both harmless,
already shipped — and `2001-01-15`, mid-flight; cause unknown, never
explained, worth asking Rene about in case it recurs on a future long
job). Re-ran `prepare`+`process` to regenerate the lost `out/` (audio is
byte-identical — deterministic render, confirmed by matching MD5s). Then a
`verify` run turned up **31/31 mismatches**, which led to this discovery:

- `data/recordings.json`'s `file`/`flac` paths for this show still point
  to **`FLAC/JerryHannan - 19 Broadway 2001-01-15/`** (no `SBD` suffix) —
  the **old, stale, pre-reprocess R2 folder** (33 files, dated 2026-07-09).
- Tonight's actual v7 reprocessed audio is sitting on R2 at
  **`FLAC/JerryHannan - 19 Broadway 2001-01-15 SBD/`** (31 files, correct
  content, MD5-matches the fresh render) — **but still under the
  first-draft, uncorrected filenames** (`01 State Trooper.flac`, `04
  Everything.flac`, `20 Four Leaf Clover Inn.flac`, `30 Never Knew a
  Woman.flac`) because the title fix was applied to `recordings.json` text
  only, never renamed on disk/R2 — the step that was done correctly for
  `1999-06-21`/`1999-07-19`'s title fixes was skipped here.
- Exactly how `recordings.json` ended up pointing at the **no-`SBD`**
  folder given `draft_tracks.py` always derives the path from
  `publish.json`'s `folder` field (confirmed `"...2001-01-15 SBD"` every
  time it was checked) is **not fully understood** — likely relates to
  this show already being a previously-published v1 show with pre-existing
  `file`/`flac` values before tonight's `draft_tracks` run; needs the
  historical `git diff` reread with fresh eyes, not more guessing under
  time pressure.

**To resume, in order:**
1. Rename the 4 disputed tracks' files in `~/work/jerry-19-broadway-2001-01-15/out/`
   (both `.flac` and `.mp3`) to the corrected titles Rene chose (Highway
   Patrolman / Everything Reminds Me of You / The Barney Stone Blues /
   Woman) — matching filenames, not just catalog text.
2. Re-run `python3 scripts/draft_tracks.py jerry-19-broadway-2001-01-15` —
   should now derive both correct titles *and* correct (`...SBD`) R2 paths
   in one pass. Re-run the title/songwriter/tags diff-against-HEAD check
   (see `CLAUDE.md`-adjacent habit this session used repeatedly) to confirm
   clean — trim the trailing-space titles on tracks 11/21/22 again if
   `draft_tracks` reintroduces them (it will, they come from source
   filenames).
3. Re-upload the 4 renamed tracks to `FLAC/…SBD/` and `MP3/…SBD/`,
   deleting the stale first-draft-named objects — same pattern as the
   `Angel from Montgomery`/`Hear Me` fixes earlier this session.
4. `gen_peaks.py`, then `audio_process.py verify` — **must show 0/31
   mismatches this time**; if not, stop and re-diagnose, don't force it.
5. Re-run the Drive `Processed/` backup (the one that failed when
   `~/work/` vanished) and content-verify (MD5, not just count — the
   folder already has 62 stale files from the original v1 publish, so a
   bare count check would false-pass).
6. Once verified clean end to end: `build.py`, commit, push, spot-check
   live.
7. Decide what to do with the now-fully-orphaned **no-`SBD`** R2 folder
   (33 old v1 files) — safe to delete once `recordings.json` is confirmed
   to no longer reference it anywhere, but don't delete before that's
   certain.
8. Write the **one consolidated Updates-page note** covering all 4
   reprocessed shows (`1999-06-21`, `1999-05-10`, `1999-07-19`,
   `2001-01-15`) — Rene asked for a summary version, not per-show entries;
   still not written since `2001-01-15` isn't done.
9. Run `publish_show.py cleanup` for the shows once each is fully verified
   live (frees local disk, double-checks live+R2+Drive first).

## Gotchas learned this session
- **A fresh hand-edit re-export can silently disagree with the established
  catalog** — different filename spelling/wording than what's already in
  `recordings.json`, even for the exact same audio (confirmed via matching
  duration). `draft_tracks.py` always trusts the *current* export's
  filename for the title, never the old catalog value, so **always diff
  title/songwriter/tags against `git show HEAD:data/recordings.json` after
  every `draft_tracks` run**, not just eyeball the FLAG output — this
  caught real regressions on 3 of the 4 shows reprocessed this session.
- **Fixing a title after `draft_tracks` has already run must rename the
  actual `out/` files (and R2 objects), not just edit `recordings.json`
  text** — editing text-only leaves the R2 path pointing at (or
  R2 objects named after) the pre-correction filename. This is exactly
  what broke `2001-01-15` (see above) after being done correctly for two
  other shows earlier the same session.
- **A fresh export reusing a different filename than the archived original
  creates a duplicate object in R2 instead of overwriting** — `rclone
  copy` matches by filename. Always check counts *and* content (MD5) after
  any re-upload, not just the automated count check, which can both
  false-fail (stale files inflate the "already there" count past the real
  target) and — new this session — mask a wrong-folder bug entirely
  (`2001-01-15` uploaded "successfully" to the wrong-but-real folder).
- **`git checkout HEAD -- <file>` on `data/processing/*.json` right before
  re-running `audio_process.py process`** feeds the resume-skip logic a
  stale provenance file it has no way to know is wrong — it will honestly
  report whatever `ver` that stale file says for any track it decides not
  to re-render. If you must isolate an unrelated commit from a file that's
  mid-edit, copy the working version aside first and restore it after,
  don't `git checkout` and re-derive.
- **Local `~/work/` staging can disappear mid-job for reasons outside this
  session's own actions** (see the `2001-01-15` section) — nothing in this
  conversation deleted it. Everything is recoverable if it happens
  (deterministic reprocessing, source safely on Drive) but it cost real
  time. Worth a heads-up to Rene; unclear if this is an environment policy
  that could recur.
- **A Drive `Processed/` file-count check can be satisfied by stale files
  from a prior run of the *same* show** — always MD5-verify content after
  any Drive backup, not just trust the count, especially on a show that
  was already published once before (which is every reprocess by
  definition).
- Drive's API can **rate-limit a rapid sequence of `rclone lsf` calls and
  return an empty/error result indistinguishable at a glance from "folder
  is genuinely empty"** — one show (`4th-street-tavern-1999-05-01`) was
  briefly misdiagnosed as missing its `Tracks/` folder entirely because of
  this; re-checking individually (slower, `rclone lsjson`) caught it.
  Don't trust a single rapid-fire loop's negative result for anything
  irreversible.

## Durable facts (don't undo)
- **All artists → −20 LUFS, −1 dBTP ceiling. Linear normalization only —
  never a limiter/compressor on the music itself** (applause-only limiting
  on audience tapes is the one sanctioned exception). A −16 LUFS archive-
  wide target was proposed and reviewed this session-adjacent — rejected:
  raising the target doesn't make quiet tracks louder (the per-track "max
  linear target" ceiling is fixed by the source audio, independent of the
  requested target), it just pushes more tracks into the quieter
  reduced-target bucket, making the archive *less* consistent, not more.
  Already tested once for Mad Hannans specifically (2026-06-28) and
  reverted for the same reason.
- **Workflow v7: render is explicit `volume=<gain>dB`, not a second
  loudnorm pass.** Never reintroduce a loudnorm-linear-mode render.
- `gdrive:` = owner account `renedebos@hotmail` (5 TB). No
  `--drive-shared-with-me` anywhere. `~/gdrive-mount` is a **local-only**
  staging copy on this machine — never synced automatically in either
  direction, always needs an explicit `rclone copy` push before Drive
  actually has what's placed there. Distinct from `~/work/`, the
  `publish_show.py` pipeline's own local staging dir (also never synced to
  Drive, purely transient).
- **Tag vocabulary is now 18 entries** (`story` and `traditional` retired
  this session) — see `TAGS.md`. `traditional`-song filtering now lives on
  the playlist's Songwriter facet, not a tag.
- Engine: `audio_process.py` (diagnose/process/verify/status/versions/
  version-map/history/plan). `/archive-data/` is the browsable,
  whole-archive counterpart to `version-map` — check it before assuming a
  show is fully caught up to the current engine (this is exactly how the
  `2001-01-15` gap got noticed this session).
- `publish_show.py prepare`/`publish` (re-run against an existing slug) is
  the preferred way to reprocess an already-published show. Its automated
  MD5 verify + Drive backup are necessary but **not sufficient** on their
  own if a title got hand-corrected after `draft_tracks` ran — always
  re-verify file paths/R2 folder names after any manual metadata edit, not
  just trust the pipeline's own "0 mismatches."

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Site templates/CSS
source-vs-output layout: `CLAUDE.md` → "Site Styling & Templates". Owner's
manual (all tools, all four workflow phases, full version history):
`PUBLISHING.md` (also rendered at `/manual/` — remember to rebuild after
editing it). Older phase-by-phase technical detail: `AUDIO_PROCESSING.md`.
Playlist/player feature spec: `PLAYLIST FEATURE.md`. Tag vocabulary:
`TAGS.md`.
