# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-06-29 (late) · **Branch:** `main` (site committed/pushed; no new site commits this session)

> This session was almost entirely the **`sean-19-broadway-2000-01-24` declip**. Read the
> Audacity MCP reality-check below before driving it again — it is flaky and cost us time.

## ⚡ Immediate pick-up (after reboot)

### 1. Resume the declip of `sean-19-broadway-2000-01-24` ← MAIN TASK
**Plan agreed with Rene this session:** *he hand-edits the clipped claps in Audacity himself*
(surgical, clap-by-clap), then **I process the resulting lossless file**. We are NOT using an
automated region level-ride — see "Why not the level-ride" below.

7 clipping tracks (from `input/diagnostic_report.txt`): **07, 09, 14, 17, 19, 22, 23**.

Progress:
- **09 Smoke in Heaven — EDITED BY RENE.** Saved to
  `~/gdrive-mount/SeanHannan - 19 Broadway 2001-01-24/Edited/09 Smoke in Heaven.flac` (+ .mp3).
  ⚠️ **Not yet diagnosed/processed.** Next: `audio_process.py diagnose` on it → confirm CLIPPING→NONE
  → `process --target -20 --slug sean-19-broadway-2000-01-24` → publish (Phase 3).
- **07, 14, 17** — Rene was about to edit these when Audacity died (see #2). Staged space-free
  copies exist: `~/work/sean-19-broadway-2000-01-24/declip/t07.flac`, `t14.flac`, `t17.flac`.
- **19, 22, 23** — not started.

⚠️ **DO NOT assume the other 6 are applause clipping like 09.** Rene's explicit caution.
**Per-track step:** locate each clip first (see ffmpeg recipe in #4), confirm *what* clips
(applause? vocal/guitar transient? mic bump?), THEN choose treatment.

### 2. ⚠️ DATE DISCREPANCY — resolve before publishing
Rene's edited 09 saved into a Drive/mount folder named **`SeanHannan - 19 Broadway 2001-01-24`**,
but the show slug + work dir are **2000-01-24** (`sean-19-broadway-2000-01-24`). One of these years
is wrong. **Ask Rene which is correct** so files don't get mis-filed. (Note: `gdrive-mount` is a
LOCAL copy, not a live mount — see [[metadata-editor]] — so the edit must be rclone-pushed to Drive
once the date is confirmed.)

### 3. Drive `Processed/` rebuild loop — was killed by reboot, RE-RUN (idempotent)
The background rebuild from the previous handoff was still mid-run (on Cafe Java) when we rebooted.
Done before reboot: Jerry 1999-06-21 (42), 2001-01-08 (60), 2001-01-15 (62). NOT finished:
Cafe Java, Sweetwater 2000-02-17, 2000-10-17, Sean 2000-02-21. **Re-run the loop** (rclone copy is
idempotent; skips uploaded files). Table + per-show command are in git history of this file / prior
handoff; pattern:
`rclone copy "r2:hannan-audio/FLAC/<r2>" "gdrive:DAT Tapes/Work Folder/<drv>/Processed" --s3-no-check-bucket --transfers 8 --drive-chunk-size 32M` then same for `MP3/<r2>`; verify each = 2×tracks.

## 🟥 Audacity MCP reality-check (lost us a track + much time)
The `audacity` MCP (131 tools) is installed/registered but **UNRELIABLE in practice**:
- **Import chokes on paths with spaces.** Always copy to a space-free name first
  (we use `~/work/sean-19-broadway-2000-01-24/declip/tNN.flac`).
- **Empty/`success:false` responses are ambiguous** — the pipe often returns `{"raw":"","success":false}`
  for commands that *did* run, and sometimes `BatchCommand finished: OK` when nothing happened.
  **Retry READ commands; NEVER blind-retry a destructive effect** (verify state via `select_all` /
  `project_get_info Tracks` first — empty track list = `BatchCommand finished: OK` with empty message).
- **It silently lost a full 172s track** during an `effect_clip_fix` call early on.
- **Audacity itself crashed/closed** mid-session (the import "OK but no track" symptom preceded a
  `PIPE_WRITE_FAILED Broken pipe`). After reboot, **relaunch Audacity** (`DISPLAY=:0`, mod-script-pipe
  enabled — preference persists). **Tip: launch with the file as an arg to bypass MCP import**, e.g.
  `audacity "/…/input/17 Wild World.flac"`, then drive it with the MCP for anything else.
- Net: for deterministic DSP, **ffmpeg is more reliable than the MCP**. Use Audacity (GUI, by Rene)
  for surgical hand-editing; use ffmpeg/`audio_process.py` for measured processing.

## 🔬 09 Smoke in Heaven — clip analysis (reference for the surgical edits)
- Track 172.31s, 24-bit/48k stereo. **Only the audience clapping clips:** exactly **9 full-scale
  (0 dBFS) windows, all within 151.7–160.0s (2:31.7–2:40)** — rhythmic claps, ~1/sec. True peak **+2.2 dBTP**.
- Rest of the track never exceeds −0.5 dBFS. The applause **tail 2:46–end (166–172s) is NOT clipped**
  (peaks ~−2 dBFS) — Rene asked to limit that tail to −6 dB, but note it doesn't address the 2:31–2:40 overs.

### Why not the automated level-ride
A trapezoidal ffmpeg gain envelope over the clap region works (−4 dB → true peak −1.8 dBTP, etc.) but
**ducks Sean's singing between the claps too** — a region envelope can't tell a clap from the vocal under
it. Rene rejected it for that reason. Correct automated tool would be a **Limiter** (NOT Compressor:
Audacity's compressor min attack ~100ms can't catch ms-long clap transients). Limiter only touches
samples above threshold, so the vocal between claps is untouched: **Soft Limit, limit −4 to −6 dB**.
But the chosen path is Rene's manual editing.

### ffmpeg clip-locator recipe (per track)
```
ffmpeg -nostats -hide_banner -i tNN.flac -af "astats=metadata=1:reset=1:length=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-" -f null - 2>/dev/null \
 | grep -oE "pts_time:[0-9.]+|Peak_level=[-0-9.]+" | paste - - | sed -E 's/pts_time://; s/Peak_level=//' | awk '$2>=-0.5'
```
Lists the windows at/near full scale → tells you WHERE and (by listening) WHAT clips.

## 🧹 Session artifacts (safe to delete; all in `~/work/sean-19-broadway-2000-01-24/declip/`)
- `abserver.py` + `ab.html` — a range-capable A/B comparison web server (port 8777, dies on reboot).
  Multi-way comparator (Original vs −4/−8/−12/−16/−20 dB rides) used to demo the level-ride to Rene.
- `t09_ride_*.flac` (−4/−8/−12/−16/−20) — test renders, not for release.
- `t07/t09/t14/t17.flac` — space-free import copies. `ride09.txt` — filter scratch.
- `t09_check.flac` (261 bytes, empty export from the lost-track incident).
Originals are untouched in `input/`.

## Other held item
- **`sean-19-broadway-unknown`** — still HELD: recordings.json has 18 tracks, Drive `Tracks/` has 20
  FLAC (2 unnumbered). Needs human reconciliation before processing.

## Durable facts (don't undo) — carried from prior handoff, still true
- **All artists → −20 LUFS, −1 dBTP ceiling.** (Mad moved −16→−20; A/B proved no gain.) [[mad-target-20]]
- **`gdrive:` = owner account `renedebos@hotmail` (5 TB). No `--drive-shared-with-me` anywhere.**
- Engine `audio_process.py` (diagnose/process/verify/status/versions/history); `--eq "<chain>"` applies
  corrective EQ before loudnorm, recorded per-track. `batch_process.py` stages without publishing.
- `update_tracks.py` re-reads recordings.json right before writing (race-safe) — still do recordings.json
  edits AFTER uploads finish.

## Per-show publish (Phase 3) — reference
`update_tracks.py` (R2) → `gen_peaks.py --slug` → edit recordings.json (Updates note + description) →
`status --write` → `build.py` → update `build_history()` → commit/push → Drive mirror (`…/Processed`,
no flag) → `verify <slug>`. Workflow detail: `AUDIO_PROCESSING.md`.
