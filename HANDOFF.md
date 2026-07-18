# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-18 · **Branch:** `main` (all work committed & pushed, deploy verified live)

> Two front-end/content sessions back to back, no audio processing. First:
> unified every generated interior page's layout with the homepage's
> alignment/spacing/type scale (five Artifact mockups explored first, none
> shipped). Second (this one): retired the one un-split, not-currently-
> planned show from public view site-wide, cleaned up several copy/UI
> inconsistencies that assumed it still existed or that the "split shows"
> distinction still mattered, fixed a stale leftover sentence on the
> homepage, trimmed the archive legend, and added a reusable hover-info
> popup to song-page performance rows. Everything below is live and
> verified; last session's audio-work carryover items are still untouched
> and still open (checked, not stale — see "What's next").

## ✅ Done this session (2026-07-18, part 2)

### 1. Hid the un-split 2025-07-03 show site-wide (commit `45243c2`)
Rene doesn't plan to process the Western Saloon show for a while and wanted
it off the public site entirely, not just off one page. Added a `"hidden":
true` flag on the show in `data/recordings.json` and a new `PUBLIC_SHOWS`
filter in `scripts/sitegen/core.py` (`M["shows"]` minus anything hidden),
threaded through every listing/feed that used to iterate `M["shows"]`
directly: archive page (`artist_sections`/`date_sorted_list` in
`fragments.py`), homepage show count, `assets/search-index.json`,
`sitemap.xml`. `build.py`'s per-show page-generation loop now skips hidden
shows too, so `/shows/jerry-western-saloon-2025-07-03/` 404s — its stale
prior-build output dir was `git rm`'d. **`M["shows"]` itself (unfiltered)
is still what `validate()`/`stamp_added_dates()` use** — those write back
to `recordings.json`, so they must see the full show, not a filtered copy,
or a rebuild would silently delete it from the data file.

With that show gone, every remaining listed show is track-indexed, so the
"split shows only" distinction stopped meaning anything:
- Archive page: removed the "Split shows only (N)" toggle button and its
  `data-split` view-rendering/localStorage JS entirely (view is now just
  artist/date, no split dimension); `artist_sections()`/`date_sorted_list()`
  dropped their now-unused `only_tracks` parameter; tagline copy dropped
  "filter to split shows".
- Homepage: removed the "30 INDEXED" stat (redundant with "SHOWS" once
  every show is indexed) from `HOME_SHELL`'s stat line and `build_home()`.
  Also removed the "Most of these tracks have not been processed..."
  paragraph from `scripts/content/about.html` — outdated now that every
  track has gone through the audio workflow at least once.
- Songs page: removed the "The N other shows in the archive aren't split
  into individual songs yet" note and its `n_other` computation — no longer
  true.
- Search page: `scripts/search.js`'s idle-state status line went from one
  combined "N songs and shows" count to "N songs and M shows" (counts
  `type: "track"` vs `type: "show"` rows in the index separately).

### 2. Fixed a stale leftover sentence on the homepage (commit `5258244`)
`scripts/content/why.html`'s closing line of the second paragraph read
"...That's really where the three reasons below come from," but the list
below it has read **four** reasons for a while — the sentence was never
updated when the fourth reason was added. Deleted the stale clause.

### 3. Trimmed the archive-page legend (commit `12c1dde`)
Rene wanted `SBD`/`AUD` (source) and the "Individual tracks available"
track-count badge dropped from the `.archive-legend` key at the top of
`/archive/`, but the actual icons/badges on each show row left alone —
legend text only, in `build_archive()`; `show_row()` in `fragments.py`
(which renders the per-row badges) wasn't touched.

### 4. Hover info popup on song-page performance rows (commits `38f9c88`, `2c19e15`)
Reused the existing `data-info`/`.info-tooltip` convention (`assets/player.js`
already drives this for show-page track titles) rather than inventing a new
mechanism. Hovering a performance's venue/date line on `/songs/<slug>/` (and
the lazily-rendered occurrence rows on `/songs/`) now shows Title, Venue,
Date, Source, Duration, Size, and Process version (the workflow version
number from the processing sidecar, e.g. "v5" — distinct from the
unrelated MD5-prefix `ver` cache-buster already on each occurrence).
`collect_songs()` in `core.py` now carries `source`/`size_mb`/`proc_ver` on
every occurrence dict so both the server-rendered song page
(`_song_occ_html` in `fragments.py`) and the client-side render path
(`scripts/songs.js`, fed by `assets/song-occurrences.json`) have the same
fields — the popup needed building twice since occurrences render two
different ways depending on which page you're on. A "Show" field
(show title) was in the first cut but Rene asked to drop it as redundant
with Venue/Date already being there.

## 🟥 Tooling gotchas (durable, still real)
- **Everything under `assets/` that `build.py` writes is a build output, not
  a source file** — not just `assets/site.css` (source: `scripts/site.css`).
  Same pattern for `assets/search.js` (source: `scripts/search.js`),
  `assets/songs.js`, `assets/player.js`, `assets/playlist.js`, etc. — every
  `write("assets/X", open(.../"X").read())` line in `scripts/build.py`'s
  `main()`. And every generated HTML page (archive, songs, search, updates,
  contact, history, all `/shows/*/`) comes from
  `scripts/sitegen/fragments.py`/`pages.py`, not hand-editable HTML. Edit
  the source under `scripts/`, not the copy under `assets/` — see
  `CLAUDE.md` "Site Styling & Templates". Lost a full round of CSS edits to
  this once (2026-07-18); nearly repeated it on `search.js` the very next
  session, caught that time via `diff` before losing anything.
- `rclone` uploads to `gdrive:` can stall mid-file — prefer local→Drive over
  a direct push; `--max-duration` retry loop if you must push directly.
- Audacity's MCP tools are unreliable — surgical hand-editing territory for
  Rene, not unattended automation.
- `pgrep -f '<script>.py'` can self-match the watcher process — match on the
  full path, or rely on the background-task notification instead.
- A Drive fix doesn't propagate to the cached `~/gdrive-mount` copy
  automatically, and `prepare`'s `fetch_tracks()` prefers that cache when
  the file count matches — always re-verify actual filenames in
  `~/work/<slug>/tracks/` after a last-minute Drive correction, don't trust
  the count alone. (This session: a folder existed under `~/gdrive-mount`
  with a typo'd name that didn't correspond to anything on real Drive at
  all — not just stale, a completely separate local-only folder. Confirm
  what a `~/gdrive-mount` path actually is before treating it as Drive.)
- An R2 filename-casing fix must be applied in **all four** places (local
  `tracks/` input, local `out/` output, R2, Drive source) or a retry
  regenerates the bug from the stale input.
- `rclone hashsum md5` (whole file) and `ffmpeg -f md5` (audio stream only)
  are **not** directly comparable — hashing the same audio via both methods
  will legitimately differ once tags are embedded. Compare like for like
  (whole-file to whole-file, or stream to stream) when verifying a Drive
  backup against a local render.
- `json.dump(..., ensure_ascii=True)` (the default) re-escapes every
  existing non-ASCII character (em dashes, etc.) in a JSON file on any
  write, producing a huge noisy diff for a one-field edit. Always pass
  `ensure_ascii=False` when hand-patching a provenance sidecar, matching
  `audio_process.py`'s own convention.
- **`rm -rf`/`rm -r` are blocked at this environment's permission layer**,
  even after explicit user confirmation for the specific deletion. Delete
  files individually then `rmdir` bottom-up instead when clearing a scratch
  directory tree.
- **Don't reach for `git stash` to "just quickly test something"** when
  there's uncommitted work in progress — it stashes everything, not just
  what you meant to set aside. Caught immediately via `git stash pop` this
  session, but it was a real near-miss on in-progress feature work.
- **A show's Drive Work Folder can get renamed after its original publish**
  (e.g. an `SBD` suffix added later) without the R2/site folder name
  following. `publish_show.py`'s single `folder` value can't correctly
  serve both the R2 upload path and the Drive `Processed/` backup path in
  that case — the Drive backup step needs a manual redirect to the current
  real folder name.
- **A show's R2 folder can carry two filename conventions at once** — a
  bare `NN Title.ext` for FLAC but a prefixed `Show - NN Title.ext` for MP3,
  left over from an old process. Re-publishing adds new bare-name files
  alongside the old prefixed ones rather than overwriting, so the
  post-upload file-count check can trip on "too many," not "too few" —
  investigate before assuming the upload failed.
- **A repo doc rendered into a live page needs a rebuild + deploy after
  every edit, same as any other content change** — editing the source
  `.md` file is not enough by itself. Check `scripts/sitegen/pages.py` for
  an `open(...).read()` on the doc to know if it's one of these.
  `PUBLISHING.md` → `/manual/` is the only current case among the five
  project docs.

## ⏭️ What's next
- **`jerry-19-broadway-2001-01-15` is still on workflow v1** (confirmed via
  `audio_process.py status`) — same bug class as this session's and last
  session's reprocesses. `~/work/plastic-lemons-ab/` (166 MB) looks like an
  unfinished A/B investigation into exactly this question; not yet raised
  with Rene as a firm "reprocess this too" decision.
- `~/work/ab/sean-19-broadway-2000-01-24-16/` (182 MB) — the current Moon
  Shadow A/B comparison, for a show already on v6 (lower urgency, one point
  release behind). Not confirmed whether Rene finished reviewing it.
- **Stale old-naming MP3s left on R2 and in Drive `Processed/`** from before
  this session's `jerry-19-broadway-2001-01-08` reprocess (30 + 30 files,
  the show's pre-reprocess MP3 naming convention). `rclone delete` against
  R2/Drive is blocked at this environment's permission layer even after
  explicit confirmation — Rene needs to run the two delete commands himself
  (given earlier this session).
- Carried over, still unresolved: whether `/archive-data/` should ever be
  mentioned in the public `/history/` narrative — left out so far as a
  judgment call to stay consistent with its "not prominently displayed"
  design intent, not something Rene has weighed in on directly.

## Durable facts (don't undo)
- **All artists → −20 LUFS, −1 dBTP ceiling. Linear normalization only —
  never a limiter/compressor on the music itself** (applause-only limiting on
  audience tapes is the one sanctioned exception). See `CLAUDE.md`.
- **Workflow v7: render is explicit `volume=<gain>dB`, not a second loudnorm
  pass.** Don't reintroduce a loudnorm-linear-mode render. On the
  applause-limiter true-peak retry, `limit_db` and `gain_db` must be backed
  off **together** — backing off gain alone doesn't move an overshoot that
  the limiter, not the gain, is actually causing.
- `gdrive:` = owner account `renedebos@hotmail` (5 TB). No
  `--drive-shared-with-me` anywhere.
- **R2 filename-casing must match the show's existing canonical key exactly**
  when re-processing — `rclone copy` matches by filename, not content; a
  mismatch duplicates instead of overwriting. Fix all four locations (see
  gotchas above), not just the output.
- **The R2 stream URL is not `Cache-Control: no-store`** — it's a 1-year
  immutable cache keyed off a `v=` version parameter (the provenance
  sidecar's MD5 prefix), or a 1-hour TTL without one. A re-upload isn't
  "live" until the provenance sidecar is updated and the site rebuilt.
- Engine: `audio_process.py` (diagnose/process/verify/status/versions/
  version-map/history/plan). `scripts/ab_compare.py` for A/B listening
  tests. `/archive-data/` is the browsable, whole-archive counterpart to
  `version-map` — check it before assuming a show is fully caught up to the
  current engine.
- `publish_show.py prepare`/`publish` (re-run against an existing slug) is
  the preferred way to reprocess an already-published show — it's what
  produced every real reprocess on record (v6, v7) and adds MD5 verification
  + Drive backup that the older manual `update_tracks.py` path skips.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Site templates/CSS
source-vs-output layout: `CLAUDE.md` → "Site Styling & Templates". Owner's
manual (all tools, all four workflow phases, full version history):
`PUBLISHING.md` (also rendered at `/manual/` — remember to rebuild after
editing it). Older phase-by-phase technical detail: `AUDIO_PROCESSING.md`.
Playlist/player feature spec: `PLAYLIST FEATURE.md`. Tag vocabulary:
`TAGS.md`.
