# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-17 · **Branch:** `main` (all work committed & pushed, deploy verified live)

> Since the last handoff (workflow v6 + A/B tool), this run added archive-wide
> version visibility (`version-map` CLI + the `/archive-data/` browsable page),
> reprocessed both Sean Hannan 19 Broadway shows onto v6 (catching and fixing
> three real Drive data-integrity issues along the way), wrote up the change
> in `/history/`, and trimmed now-stale description text on both shows via the
> metadata editor. Everything is live; no open blockers.

## ✅ Done this session

### 1. `version-map` — archive-wide workflow-version view (commit `79ec6cf`)
Prompted by Rene: a show's tracks can legitimately span more than one
workflow version (a partial re-run only updates the tracks it touched), but
nothing showed that across the *whole* archive at once — `history <slug>`
only looks at one show. `audio_process.py version-map` tallies versions per
show, flags mixed ones (`⚠ MIXED`), and `--version N` lists every track
anywhere still on version `N` (e.g. reprocessing candidates predating a
fix). Documented in `AUDIO_PROCESSING.md`.

### 2. `/archive-data/` — browsable spec/version catalog (commit `e5bfc33`)
Planned in full Plan Mode (research → scope confirmation → approval) per
Rene's request for "a master list of all songs with all the spec data,
filter/query capable, reachable by a link rather than prominently displayed."
- New build asset `assets/track-spec.json` (`build_track_spec_catalog()` in
  `scripts/sitegen/feeds.py`) — one row per track, every show, merging
  catalog fields (title, songwriter, tags, dropouts) with processing
  provenance (procVer, in/out LUFS, gain, true peak, LRA, PLR, max M/S,
  treatment mode, chain) when a sidecar exists.
- New page `scripts/sitegen/pages.py:build_archive_data()`, client-rendered
  by new `scripts/archive-data.js` (~230 lines: chip-filter facets copied
  from `playlist.js`'s pattern, sortable columns, free-text search) against
  `.tech-table`/`.tech-scroll` styling already used by the per-show
  Technical Data table.
- **Unlisted by design** (Rene's explicit requirement): absent from
  `SITE_PAGES`/`EXTRA_PAGES` → no nav entry, no sitemap entry, `noindex`
  meta tag — same treatment as `/player/`/`/manual/`.
- **Entry point changed mid-plan:** the approved plan only linked it from
  `/manual/`; Rene later said "make a link for this available on the search
  page" too — added a one-line pointer to `/search/`'s intro, kept both.
- Verified via a fresh headless-Chromium Playwright smoke test (installed
  ad hoc into the scratchpad): all 679 rows render, each filter/sort/search
  path checked individually against known counts, zero console errors.
- **CI hiccup:** first push (feature files only, deliberately excluding the
  still-in-progress show reprocessing below) failed CI's "verify committed
  site is current" check — `assets/track-spec.json` had been committed in a
  state produced by the *working tree* (which already had uncommitted
  reprocessing edits), not by what was actually committed. Fixed by
  committing the reprocessing thread's files too and confirming
  `git status --porcelain` was empty after a fresh `build.py`, matching
  CI's exact check, before repushing.

### 3. Reprocessed both Sean Hannan 19 Broadway shows to v6 (commit `d971714`)
`sean-19-broadway-2000-01-24` (31 tracks) and `sean-19-broadway-2000-02-21`
(11 tracks), both from Drive Work Folder `Tracks/` (no NR). Full
`publish_show.py prepare`/`publish` runbook, three real data-integrity issues
caught and fixed on the Drive source **before** they could land in published
metadata:
- **Missing track + renumbering** on `2000-01-24`'s `Tracks/` — track 28
  ("Did You Ever See") was absent, with 29→28/30→29 shifted to fill the gap.
  Caught via an `rclone lsf` count check before running `prepare`; Rene fixed
  the source and confirmed.
- **Trailing-space filename** (`03 Galway Shawl .flac`) on `2000-02-21`'s
  `Tracks/` — the exact gotcha already documented in `AUDIO_PROCESSING.md`.
  Fixed on Drive, but the fix didn't propagate to the already-cached local
  `~/gdrive-mount` copy, which `prepare` prefers when it matches file count —
  silently reintroduced the trailing space. Caught after `prepare`, fixed in
  both places.
- **R2 filename-casing collisions** (the significant one, twice): a freshly
  processed track's filename (derived from the raw folder name) didn't
  exactly match the show's existing canonical R2 key casing — track 27
  "Some Get Married For Love" vs. canonical "for Love" on `2000-01-24`, and
  track 8 "Don't Think Twice It's Allright" vs. canonical "All Right" on
  `2000-02-21`. Because `rclone copy` matches purely by filename, the
  mismatch created a **duplicate** R2 object instead of an overwrite,
  tripping `publish_show.py`'s track-count integrity check ("R2 FLAC
  incomplete: 32/31", then "12/11"). First-attempt fixes only touched local
  `out/` + R2 + Drive, not the local `~/work/<slug>/tracks/` **input** folder
  already downloaded during `prepare` — since `process` derives its output
  filename from the input, a retry silently regenerated the bad casing and
  re-created the R2 duplicate. Root cause only fully understood after the
  second occurrence; the real fix touches all four locations every time:
  local input, local output, R2, and Drive source.
- Two title corrections along the way, both user-confirmed: track 5 on
  `2000-02-21`, "Irish Song" → "Ode to Biddy McGee"; track 6, "The German
  Clock Winder" → "The German Clockwinder."
- `draft_tracks.py` flagged 4 titles as needing a songwriter/tags check
  (Angel from Montgomery, Long Black Veil, Some Get Married for Love,
  Plastic Lemons) — verified by reading the catalog-merge logic directly
  (a "NEW to archive" flag only means no *other* show has that title; a
  track's own pre-existing data survives the merge) and cross-checking all
  4 against every other occurrence in `recordings.json`. No changes needed.
- Descriptions + per-show Updates notes drafted by hand; `/history/` got a
  new "Week ten — a more trustworthy audio engine" section covering the v6
  engine change and both shows (commit `aa785ce`).

### 4. Metadata-editor cleanup (commit `9386296`)
Ran `make edit` (`scripts/edit_metadata.py`, headless: `--no-open` in the
background, then `TaskStop` when done) to trim now-stale description lines
on both reprocessed shows — leftover "not yet split"/"not yet audited"/format
boilerplate that no longer applied now that both shows are fully processed
and split. Rebuilt and published.

## 🟥 Tooling gotchas (still real, unchanged this session)
- `rclone` uploads to `gdrive:` can stall mid-file — prefer local→Drive over
  a direct push; `--max-duration` retry loop if you must push directly.
- Audacity's MCP tools are unreliable — surgical hand-editing territory for
  Rene, not unattended automation.
- `pgrep -f '<script>.py'` can self-match the watcher process — match on the
  full path, or rely on the background-task notification instead.
- **New this session:** a Drive fix doesn't propagate to the cached
  `~/gdrive-mount` copy automatically, and `prepare`'s `fetch_tracks()`
  prefers that cache when the file count matches — always re-verify the
  actual filenames in `~/work/<slug>/tracks/` after any last-minute Drive
  correction, don't trust the count alone.
- **New this session:** an R2 filename-casing fix must be applied in **all
  four** places (local `tracks/` input, local `out/` output, R2, Drive
  source) or a retry regenerates the bug from the stale input.

## ⏭️ What's next
- No open items from this session's explicit requests.
- Not raised with Rene, worth a future prompt: whether `/archive-data/`
  should ever be mentioned in the public `/history/` narrative — deliberately
  left out this time (my own judgment call, to stay consistent with its
  "not prominently displayed" design intent), not something Rene weighed in
  on directly.

## Durable facts (don't undo)
- **All artists → −20 LUFS, −1 dBTP ceiling. Linear normalization only —
  never a limiter/compressor on the music itself** (applause-only limiting on
  audience tapes is the one sanctioned exception, unchanged). See `CLAUDE.md`.
- **Workflow v6: render is explicit `volume=<gain>dB`, not a second loudnorm
  pass.** Don't reintroduce a loudnorm-linear-mode render.
- `gdrive:` = owner account `renedebos@hotmail` (5 TB). No
  `--drive-shared-with-me` anywhere.
- **R2 filename-casing must match the show's existing canonical key exactly**
  when re-processing — `rclone copy` matches by filename, not content; a
  mismatch duplicates instead of overwriting. Fix all four locations (see
  gotchas above), not just the output.
- Engine: `audio_process.py` (diagnose/process/verify/status/versions/
  version-map/history/plan); `scripts/ab_compare.py` for A/B listening tests.
  `/archive-data/` is the browsable, whole-archive counterpart to
  `version-map` — check it before assuming a show is fully caught up to the
  current engine.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Technical detail:
`AUDIO_PROCESSING.md`. Playlist/player feature spec: `PLAYLIST FEATURE.md`.
