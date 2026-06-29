# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-06-29 · **Branch:** `main` (all site work committed & pushed through `fce5b83`)

> Read this first. There is **in-flight background work** to finish and a newly
> installed **Audacity MCP** to use.

## ⚡ Immediate pick-up tasks

### 1. Finish the Drive `Processed/` rebuild (was 3 of 7 done at restart)
Context: the `gdrive:` remote was switched from a full 15 GB gmail account
(`renedebos.ai@gmail`) to the **owner 5 TB account `renedebos@hotmail`**. The old
`Processed/` mirrors (owned by the gmail acct) were deleted; we're rebuilding them
**from R2** (the verified source) onto the 5 TB account. `rclone copy` is
idempotent — **just re-run; it skips files already uploaded.** Drop
`--drive-shared-with-me` (owned content now; the flag excludes it).

Rebuild all 7, FLAC + MP3 from R2 into each show's `Processed/` (DriveFolder | R2-name):
```
JerryHannan - 19 Broadway 1999-06-21      | JerryHannan - 19 Broadway 1999-06-21
JerryHannan - 19 Broadway 2001-01-08 SBD  | JerryHannan - 19 Broadway 2001-01-08
JerryHannan - 19 Broadway 2001-01-15 SBD  | JerryHannan - 19 Broadway 2001-01-15
MadHannans - Cafe Java 1999-09-09         | MadHannans - Cafe Java 1999-09-09
MadHannans - Sweetwater 2000-02-17 SBD    | MadHannans - Sweetwater 2000-02-17
MadHannans - Sweetwater 2000-10-17 SBD    | MadHannans - Sweetwater 2000-10-17
SeanHannan - 19 Broadway 2000-02-21       | SeanHannan - 19 Broadway 2000-02-21
```
Per show: `rclone copy "r2:hannan-audio/FLAC/<r2>" "gdrive:DAT Tapes/Work Folder/<drv>/Processed" --s3-no-check-bucket --transfers 8 --drive-chunk-size 32M`, then same for `MP3/<r2>`. Verify each lands at 2×tracks files.

### 2. Complete the 2001-01-06 Drive mirror (was 41/48)
`rclone copy ~/work/mad-sweetwater-2001-01-06/processed "gdrive:DAT Tapes/Work Folder/MadHannans - Sweetwater 2001-01-06/Processed" --exclude "*.txt"` (idempotent). NOTE: `~/work` may have been cleared — if so, rebuild this one from R2 too (`MadHannans - Sweetwater 2001-01-06`, 24 FLAC + 24 MP3).

### 3. `sean-2000-01-24` declip — now doable via the Audacity MCP
The Audacity MCP (`audacity` server, 131 tools) is installed + registered with Claude Code (user scope, `~/Audacity-MCP/.venv`). After this restart its tools are live. **Launch Audacity** (display `:0`, `mod-script-pipe` enabled) so the MCP can drive it, then:
- Pull the 7 clipping tracks (`Tracks/`): **07, 09, 14, 17, 19, 22, 23**. Worst clipping (priority): **22 Maids…(4110 fs-samples), 17 Wild World, 23 Long Black Veil**; 07 has the single longest run (17 samples). All are brief transient clips in loud applause/whoo at song ends — **gentle envelope ride-down on the crowd tails** (not an aggressive fade), optional declip; preserve the live feel.
- Re-export lossless → `audio_process.py diagnose` (confirm CLIPPING→NONE) → `process --target -20 --slug sean-19-broadway-2000-01-24` → publish (Phase 3).

### 4. `sean-19-broadway-unknown` — still HELD
recordings.json has 18 tracks but Drive `Tracks/` has **20 FLAC (2 unnumbered)**. Needs human reconciliation (extra takes? mis-split?) before processing.

## Archive state: **done: 8 / needs-processing: 23**
Done (live + R2-verified at −20): 3 Jerry (1999-06-21, 2001-01-08, 2001-01-15) +
all 4 Mad (2000-02-17, 2000-10-17, cafe-java-1999, **2001-01-06**) + sean-2000-02-21.

## Durable changes made this session (don't undo)
- **All artists → −20 LUFS** (Mad moved −16→−20; A/B proved no audible gain from −16). See memory [[mad-target-20]].
- **`gdrive:` = owner account `renedebos@hotmail` (5 TB).** No `--drive-shared-with-me` anywhere (removed from Makefile, `batch_process.py`, docs; CLAUDE.md updated). The 15 GB gmail acct was freed.
- **Engine `--eq` + workflow v2:** `audio_process.py process --eq "<chain>"` applies a literal corrective-EQ chain before loudnorm, recorded per-track. Fixed a drift bug (measure now reads the post-EQ signal). Used to restore 2001-01-06. 2001-01-06 EQ chain is in its sidecar `chain`.
- **`batch_process.py`** stages shows (validate→diagnose→process to −20) without publishing; parks sidecars in `~/work/<slug>/sidecar-staged.json` (not `data/processing/`) so staged≠done; publish block restores it.
- **`update_tracks.py`** re-reads recordings.json right before writing (race-safe) — but still do recordings.json edits AFTER the upload finishes.

## Reference
- Workflow: `AUDIO_PROCESSING.md`; engine `scripts/audio_process.py` (diagnose/process/verify/status/versions/history).
- Targets: all artists **−20 LUFS**, **−1 dBTP** ceiling.
- rclone: `gdrive:` no flag (owner acct); `r2:hannan-audio` needs `--s3-no-check-bucket`.
- Per-show publish (Phase 3): `update_tracks.py` (R2) → `gen_peaks.py --slug` → edit recordings.json (Updates note + any description) → `status --write` → `build.py` → update `build_history()` → commit/push → Drive mirror (`…/Processed`, no flag) → `verify <slug>`.
