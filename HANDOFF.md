# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-06-28 · **Branch:** `main` (all work committed & pushed)

## What we did today

**Audio processing (2 shows to the −20 standard):**
- **2001-01-08** (30 tracks) → −20 LUFS, **added gated FLAC downloads** (was MP3-only), verified 30/30 R2 MD5. `7cd5d1b`
- **2001-01-15** (31 tracks) → re-mastered from raw masters −20 LUFS (replacing old −16 pass), verified 31/31, **`redo`→`done`**. `b3d265d`
- Both: peaks, Updates notes, Drive `Processed/` mirror, cleanup. Track 24 of 2001-01-15 ("Xmas Song") lands at −20.64 (TP-limited sketch, benign).

**Infrastructure / features built:**
- **Worker deployed** (`08898459`): `/stream` now 403s lossless keys + edge caching. Verified live.
- **Per-track workflow versioning** `24141ca`: each track stamped with `ver` + literal `chain`; sidecar **merges** (mixed-version shows possible); `WORKFLOW_VERSIONS` registry; new `versions` + `history` subcommands; backfilled the done shows as v1.
- **Processing status** `7da091d`: `status [--write]` command writes `processing_status` (per show) + `processed` (per track) into `recordings.json`, computed from sidecars. 2001-01-15 set `redo`; 21 whole-show-only = `needs-processing`.
- **Status surfaced on site**: badge + per-track **Ver** column in Technical-data table `a16a0f0`; status line on **every** show page `c755430`.
- Removed dropout notes/tags from 2001-01-15 `3d8d96d`.
- **History page**: added "Week four" `423ae36`; made History upkeep a Phase 3 step `915e630`.
- **Permissions**: created + widened `~/renedebos.com/.claude/settings.local.json` (allowlist + deny safety net).

## Current archive state
| Status | Count |
|---|---|
| **done** | 3 — `jerry-19-broadway-1999-06-21`, `2001-01-08`, `2001-01-15` |
| **needs-processing** | 28 — 7 track-listed (3 Sean, 4 Mad) + 21 whole-show-only |
| **redo** | 0 (cleared) |

## Half-finished / open threads
- **7 track-listed shows pending** (Drive folders all confirmed present):
  - Sean (→ **−20**): `sean-19-broadway-2000-01-24` (31), `…-2000-02-21` (11), `…-unknown` (18)
  - Mad (→ **−16**): `mad-sweetwater-2000-02-17` (21), `…-2000-10-17` (24), `mad-cafe-java-1999-09-09` (21), `mad-sweetwater-2001-01-06` (24)
- ⚠️ **The Mad −16 band-target path is untested** — first Mad run will validate it (watch the predicted-TP behavior; band shows can overshoot −16 and trigger dynamic-mode compression).
- ⚠️ **Some "needs-processing" shows may actually be old-normalized** (no provenance). The Week-three History notes say **Sean 2000-02-21** and **Mad 2001-01-06** already got a manual loudness pass. They're not in `REDO_SLUGS`, so they read as `needs-processing` — confirm at pull time (raw masters have widely varying input LUFS; pre-normalized cluster near target). If pre-normalized, treat like the 2001-01-15 redo.
- **Whole-show-only shows (21)**: counted `needs-processing` but the engine can't act on them (no split tracks) — they'd need splitting first, or a separate whole-file normalization path. No path built yet.
- **Track tagging** (covers/songwriters/genres powering search) — ongoing, partial.
- **Permissions**: widened allowlist **only activates on a new session**, and it **auto-approves `npx wrangler deploy`** — user hasn't confirmed they want that kept.

## Exact next steps
1. **Process the next show.** Suggested order: **Sean `2000-01-24`** (validated −20 path), or **Sean `2000-02-21`** for a fast 11-track win — then the Mad shows (first −16 run). Per-show flow:
   ```
   # slug + Drive folder (e.g. "SeanHannan - 19 Broadway 2000-01-24")
   rclone copy "gdrive:DAT Tapes/Work Folder/<folder>/Tracks" ~/work/<slug>/input \
     --include "*.flac" --max-depth 1 --progress
   python3 scripts/audio_process.py diagnose ~/work/<slug>/input --artist <sean|mad>
   # review (esp. for Mad: check predicted-TP at -16); then:
   python3 scripts/audio_process.py process ~/work/<slug>/input ~/work/<slug>/processed \
     --target <-20|-16> --slug <slug>
   python3 scripts/update_tracks.py <slug> ~/work/<slug>/processed
   python3 scripts/gen_peaks.py --slug <slug>
   # add Updates note (report:true); then:
   python3 scripts/audio_process.py status --write
   python3 scripts/build.py
   # update build_history() Week section  <-- standing requirement
   git add -A && git commit && git push
   rclone copy ~/work/<slug>/processed "gdrive:DAT Tapes/Work Folder/<folder>/Processed" \
     --exclude "*.txt" --progress
   python3 scripts/audio_process.py verify <slug>
   rm -rf ~/work/<slug>
   ```
2. **At pull time, check input LUFS** to catch the pre-normalized Sean/Mad shows (redo vs fresh).
3. **Always update the History page** as part of publishing (now in the doc + memory).
4. **Worker changes** still need a manual `cd worker && npx wrangler deploy` — the Action only deploys the Pages site.
5. **Restart the session** to activate the widened permission allowlist (and decide whether to keep `wrangler deploy` auto-approved).

## Reference
- Workflow doc: `AUDIO_PROCESSING.md` (4 phases; engine = `scripts/audio_process.py`).
- Per-artist targets: jerry/sean/seanjerry **−20**, mad **−16**; ceiling **−1 dBTP**.
- Status/version queries: `audio_process.py status`, `history <slug> --chains`, `versions`.
- rclone: `gdrive:` is now the **owner** account (renedebos@hotmail, 5 TB) — reach content by path with **no** `--drive-shared-with-me` (that flag now excludes owned content); `r2:hannan-audio` needs `--s3-no-check-bucket`.
