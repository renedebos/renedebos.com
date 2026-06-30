# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-06-30 · **Branch:** `main` (all work committed & pushed)

> This session **finished and published two Sean shows**: the `2000-01-24` declip and the
> undated `unknown` set. Both are fully live (R2 + site + Drive mirror). No open blockers.

## ✅ Done this session

### 1. `sean-19-broadway-2000-01-24` — declip + normalize — PUBLISHED
- Rene hand-edited the 9 clipped tracks (07, 09, 14, 17, 19, 22, 23, 24, 31) in Audacity;
  a prior pass had already processed all 31 to −20 LUFS and uploaded to R2.
- This session closed the remaining Phase-3 items: removed the stale "not normalized yet"
  description line, **verified R2 (31/31 md5 OK)**, and **completed the Drive `Processed/`
  mirror (62 files)** — the earlier mirror had stalled at 21/62.
- **Date discrepancy RESOLVED:** the show is **2000-01-24** (slug, R2 keys, mount folder all
  agree now; the old "2001-01-24" mount-folder name is gone). No longer an open question.
- Commits: `4f62ab0` (description), `79a5bc5` (handoff). Show already published in `b6c6db6`.

### 2. `sean-19-broadway-unknown` — normalize — PUBLISHED (commit `ebf877e`)
- **Was previously HELD** (18 in recordings.json vs 20 FLAC in Drive). Rene reconciled it to a
  clean **18 numbered tracks** and dropped them in `~/gdrive-mount/SeanHannan - 19 Broadway unknown date/`.
- Diagnose: **clip NONE on all 18** — clean tape, no hand-editing needed. Processed all 18 to
  −20 LUFS (workflow v2), **replacing an earlier −16 LUFS Audacity pass** (stale description note
  removed). Sidecar written; **R2 verified 18/18**; peaks regenerated; Updates note + history
  bullet added; **Drive `Processed/` mirror = 36 files**.
- **Source filenames were normalized on staging:** the local files had `w_Jerry` / `w_Kelly Peterson`
  suffixes + casing (`don't…`, `Angel of Montgomery`); I copied them into `~/work/.../input/` under the
  **canonical R2 names** (matched by track number) so uploads overwrote in place, no dup keys.
- ⚠️ **Worth a listen:** several track durations changed vs the old raw upload (e.g. track 3
  "Don't Think Twice" **+17s**). That means the files Rene supplied are **different cuts** than the
  original split. Displayed durations now match what's live; flag only if the re-splits were unintended.

## 🟡 Notes / minor follow-ups (no action required)
- **Technical-data "Ver" column looks "missing" on long-title shows.** It renders correctly
  (`v2` for every track, confirmed on the live site) but is the **last of 11 columns** inside
  `.tech-scroll` (`overflow-x:auto`), so on shows with long titles (e.g. 2000-01-24's "Maids When
  You're Young…") it sits off the right edge until you scroll. Rene confirmed the data is correct and
  **declined a CSS change.** If ever wanted, the one-liner is to let the title column wrap:
  `.tech-table td:not(.tnum):not(.tver){white-space:normal;min-width:9rem}` in `scripts/site.css`
  (then `build.py` copies it to `assets/site.css`).
- Session scratch in `~/work/sean-19-broadway-2000-01-24/declip/` (A/B server, `t09_ride_*` renders)
  is safe to delete. Originals untouched in each show's `input/`.

## 🟥 Two tooling gotchas that cost time (now in memory)
- **rclone uploads to `gdrive:` stall mid-file** — byte count freezes, rate decays toward 0, ETA
  explodes; `--timeout` does NOT catch it (Drive keeps the conn alive). Don't tune `--transfers`;
  use a **`--max-duration` retry loop** (atomic Drive uploads → killed mid-stall files just retry;
  done files are skipped) and prefer **local→Drive** over R2→Drive. Full recipe: [[rclone-drive-upload-stall]].
- **`pgrep -f '<script>.py'` self-matches the watcher.** An `until ! pgrep -f gen_peaks.py` loop
  matched its OWN command line (which contains the string) → deadlocked forever; gen_peaks/status
  silently never ran. **Match on the running file PATH or use the bg-task notification**, not a
  script name that also appears in the watcher's own command.

## 🟥 Audacity MCP reality-check (unchanged — still flaky)
The `audacity` MCP (131 tools) is UNRELIABLE: import chokes on spaces (copy to space-free names);
empty/`success:false` responses are ambiguous (retry READs, never blind-retry a destructive effect —
verify state first); it once **silently lost a 172s track**; Audacity itself crashed mid-session
(`PIPE_WRITE_FAILED`). Launch with the file as an arg to bypass MCP import. For deterministic DSP,
**ffmpeg beats the MCP**. Use Audacity (GUI, by Rene) for surgical hand-editing only. [[audacity-mcp-unreliable]]

## ⏭️ What's left in the archive
- `status --write` → `done: 10, needs-processing: 21`. All **track-listed** shows are now `done`.
- The 21 `needs-processing` are **whole-show-only** shows (no split tracks yet) — they need
  **splitting into tracks first**, then the normal pipeline.
- Separate item: **`jerry-19-broadway-2001` (30-song soundboard set)** still carries a "these tracks
  have not been normalized yet" description line (recordings.json ~line 1057) — it's a different show,
  left untouched this session.

## Durable facts (don't undo)
- **All artists → −20 LUFS, −1 dBTP ceiling.** (Mad moved −16→−20; A/B proved no gain.) [[mad-target-20]]
- **`gdrive:` = owner account `renedebos@hotmail` (5 TB). No `--drive-shared-with-me` anywhere.**
- `gdrive-mount/` is a **LOCAL copy**, not a live mount — edits must be rclone-pushed to Drive. [[metadata-editor]]
- Engine `audio_process.py` (diagnose/process/verify/status/versions/history); `--eq "<chain>"` applies
  corrective EQ before loudnorm, recorded per-track. `update_tracks.py` re-reads recordings.json right
  before writing (race-safe) — still do recordings.json edits AFTER uploads finish.

## Per-show publish (Phase 3) — reference
`update_tracks.py` (R2) → `gen_peaks.py --slug` → edit recordings.json (Updates note + description) →
`status --write` → `build.py` → update `build_history()` → commit/push → Drive mirror (`…/Processed`,
**use the max-duration retry loop, local→Drive**) → `verify <slug>`. Detail: `AUDIO_PROCESSING.md`.
