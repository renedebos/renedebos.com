# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-22 · **Branch:** `main` — everything below is committed & pushed, deploy verified live on renedebos.com itself (not just green Action).

> Two audio-processing threads this session: (1) fixed a silent Drive-backup
> verification gap discovered while double-checking the prior session's
> reprocess, and (2) reprocessed `mad-sweetwater-2000-10-17` to workflow v7,
> which surfaced a much bigger problem — a truncated hand-edit export that
> diagnose couldn't catch — and led to a new permanent safeguard in
> `publish_show.py`.

## ✅ Done this session

### Fixed a silent Drive `Processed/` backup verification gap (commit `dab37b6`)
Asked to confirm `sean-19-broadway-unknown`'s Drive backup from the prior
session was real — it wasn't. `drive_backup()`'s completeness check only
counted FLAC/MP3 files, so when Drive `Processed/` already held 36 stale
files from the **old** 2026-06-30 run, the count was satisfied instantly
without any new content ever being copied; `processing_report.txt` was
missing entirely. Re-ran the backup for real (content-verified via
`rclone check`), found 6 leftover stale-named duplicates from the old run
still sitting alongside the new ones and had Rene delete them.

**Fix:** `drive_backup_matches()` now runs `rclone check` (FLAC/MP3 hashes)
plus an explicit `processing_report.txt` presence check, used in both
`cmd_publish`'s backup loop and `cmd_cleanup`'s pre-delete safety gate (the
latter used to gate deleting the local `out/` copy on the same broken
count-only logic — a worse instance of the same bug). Documented in
CLAUDE.md's runbook section.

### Reprocessed `mad-sweetwater-2000-10-17` to workflow v7 (commit `931e70a`)
Jerry Hannan's birthday show at the Sweetwater, previously on v1 processing.
24 tracks, hand-edited fades/clip-fixes in Drive's `Tracks/` folder, no NR,
`labels.txt` present.

**Major snag — a truncated export that diagnose couldn't catch:** the first
`prepare` run diagnosed clean, but tracks 15–24 turned out to be 0.5–8
seconds long instead of full songs (confirmed against the show's own
previously-published durations, e.g. "Truck" was 3:38, "Hollywood" 4:33).
Loudness/clipping/click diagnose has no notion of "is this the right
length," so a truncated file sails through — and the unusually large gain
needed to hit target loudness on those tracks (the PRED_TP flags) was the
missed tell. **Already got as far as uploading the broken clips to R2
(MD5-verified, since verification only proves upload-matches-what-we-sent)
before this was caught** — nothing was live on the site yet, caught before
build/commit/push. Rene re-exported the affected tracks correctly from the
Audacity project; re-verified durations against the old catalog before
re-running `prepare`.

**Permanent fix — added to `publish_show.py`:** `check_duration_regression()`
runs at the end of `cmd_prepare`, comparing each fresh track's actual
`ffprobe` duration against the currently-published catalog duration for
that same track number, and hard-stops (`SystemExit`) if a track shrank to
under half its previous length. Bypassable only with an explicit
`--allow-duration-drift` flag for a genuine intentional re-edit — can't be
silently skipped by just re-running `prepare` again.

**Second snag — same stale-leftover pattern, different layer:** R2 upload
hit `R2 FLAC incomplete: 26/24` because 2 tracks (17, 24) had different
filenames between the broken first export and the corrected second export
(`ABC's` → `ABC`, `The Kiss_DaDaDa` → `The Kiss_Da Da Da`), leaving the
broken run's tiny files (~1MB, `07:53` timestamp) sitting alongside the
correct ones on both FLAC and MP3 sides. Rene deleted the 4 stale objects;
publish resumed and completed (engine skips already-processed tracks).

**Own mistake caught mid-session:** first attempt at restoring the drifted
title `"The Kiss_Da Da Da (Slave to an Angel)"` used the wrong target —
guessed `"The Kiss - Da Da Da..."` from a `git log -p` grep that conflated
the `title` field with `file`/`flac` path fields (paths use `-`, titles
use `/`). Caught by spot-checking the rendered song page against the
archive's actual established convention (commit `fdb84c8` explicitly
normalized this exact drift pattern to `"The Kiss / Da Da Da..."` back on
2026-07-15) before it shipped — corrected before commit.

**Other title fixes:** "Model Family Man" and "Plastic Lemons" had picked
up stray trailing whitespace from the fresh export (confirmed no other
show in the archive has the trailing space) — trimmed.

Full runbook completed: R2 upload MD5-verified (0 mismatches, 24/24 both
FLAC+MP3), Drive `Processed/` backed up and content-verified (0
differences, `processing_report.txt` present), `draft_tracks.py` flags
reviewed (5 flags, all either pre-existing-metadata carryovers or
resolved by the title fixes above), Updates note + Week twelve History
bullet added, `build.py --check` clean, `status --write` run and
rebuilt, committed, pushed, Action green, spot-checked the live show
page/song pages/updates feed/history page directly on renedebos.com.

## Gotchas learned this session
- **A count-only "is the backup done" check can't tell fresh output from
  stale same-named leftovers of a prior run** — this bit both the Drive
  `Processed/` backup (files from an old run) and the R2 upload check
  (files from the broken first attempt at *this* run). The fix pattern is
  the same in both places: verify by content/hash (`rclone check`,
  MD5-vs-provenance), not by count, and when a mismatch appears, look for
  old-dated files under a *different* filename than the current run's
  output before assuming something is broken — check `rclone lsl` mtimes.
- **Loudness/clipping/click diagnose has no concept of "is this track the
  right length."** A severely truncated file (a fraction of the real
  song) can diagnose perfectly clean — even look *safer* (quieter, no
  clipping). The only reliable tell without an explicit duration check
  was the unusually large gain needed to hit the loudness target
  (PRED_TP), which is a correlation, not a guarantee — hence the new
  explicit duration-regression check in `publish_show.py`, not a "watch
  for large PRED_TP" heuristic.
- **When restoring a drifted title to the archive's "established
  convention," don't infer the convention from a `git log -p` text grep
  without checking which JSON field the match came from** — track
  `file`/`flac` paths and the `title` field can legitimately use
  different punctuation for the same song (paths avoid `/` and `-`
  differently than what displays). Cross-check against the actual
  rendered song page (which aggregates the true display convention) or a
  clean field-scoped grep before committing a title fix.
- **`rm -rf` is hard-denied even against the agent's own `~/work/<slug>`
  scratch directories** — same guardrail as `rclone delete/purge/sync/move`.
  Plain `rm` on individual files (no `-r`/`-f` flags) still works; use that
  to clear stale cached `out/`/`tracks/` files before a redo instead.

## Durable facts (don't undo)
- `publish_show.py` now has two content-based safety checks that didn't
  exist before this session: `drive_backup_matches()` (Drive backup
  verification) and `check_duration_regression()` (truncated-export
  detection, `cmd_prepare` only, bypass via `--allow-duration-drift`).
  Don't revert either to count-only/duration-blind logic.
- `mad-sweetwater-2000-10-17` and `sean-19-broadway-unknown` are both now
  fully on workflow v7, with verified (not just count-checked) Drive
  `Processed/` backups.
- Archive-wide title conventions live in git history, not a lookup table —
  when in doubt about which variant is "correct," check `fdb84c8` (the
  main title-normalization commit) and the rendered song page, not a raw
  text grep across mixed JSON fields.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Owner's manual (all
tools, all four workflow phases, full version history): `PUBLISHING.md`
(also rendered at `/manual/`). Older phase-by-phase technical detail:
`AUDIO_PROCESSING.md`. Tag vocabulary: `TAGS.md`.
