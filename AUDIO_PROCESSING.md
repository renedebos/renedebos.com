# Audio Processing Instructions for Claude Code

## Overview
This is a two-phase workflow for batch processing live concert recordings made with a stereo audience mic on DAT tape. Sources may be **WAV or FLAC** (both lossless); a folder may contain a mix of the two.

- **Phase 1** — Diagnostic analysis of all files. Generates a report. No files are modified.
- **Phase 2** — Apply filters and loudness normalization based on Phase 1 findings. Run only after user reviews the diagnostic report.

Always run Phase 1 first and wait for user confirmation before proceeding to Phase 2.

### Input formats and output container
Process both `*.wav` and `*.flac` in the input folder. **Output mirrors the input
container** — WAV in → WAV out, FLAC in → FLAC out — so the archive stays lossless
either way and FLAC sources keep their ~50% size advantage. All ffprobe/ffmpeg
commands below work identically on either container; only the Pass 2 output codec
differs (see "Bit depth" under Phase 2). Throughout this doc "WAV" in the example
commands stands in for "the input file," whatever its container.

---

## Prerequisites
Check that ffmpeg is installed before doing anything else:
```
ffmpeg -version
```
If not installed, tell the user to run: `sudo apt install ffmpeg`

Also check that sox is installed:
```
sox --version
```
If not installed: `sudo apt install sox`

---

## Phase 1 — Diagnostic Analysis

### Goal
Analyze all WAV files and produce a diagnostic report so the user can make informed processing decisions. **Do not modify any files.**

### Run the following checks on every WAV file:

**1. File info** (sample rate, bit depth, channels, duration)
```
ffprobe -v quiet -print_format json -show_streams input.wav
```

**2. Stereo width** — measure difference between left and right channels
```
ffmpeg -i input.wav -af "pan=stereo|c0=c0-c1|c1=c1-c0,volumedetect" -f null - 2>&1
```
If the difference channel mean volume is below -60 dBFS → flag as DUAL MONO
Otherwise → TRUE STEREO

**3. Loudness and dynamics** — integrated LUFS, LRA, true peak
```
ffmpeg -i input.wav -af loudnorm=I=-20:LRA=11:TP=-1:print_format=json -f null - 2>&1
```
Parse JSON for: `input_i` (integrated LUFS), `input_lra` (loudness range), `input_tp` (true peak)

**4. Clipping detection** — count genuinely full-scale samples
```
ffmpeg -i input.wav -af "astats=measure_perchannel=0" -f null - 2>&1
```
Read two fields from the Overall block: `Peak level dB` and `Peak count`.

**Do NOT flag on `Peak count > 0` alone.** `Peak count` is the number of samples
at the file's *own* peak level, whatever that level is — it is always ≥ 1, so that
rule flags every file. It only means clipping when the peak actually reaches full
scale. Apply this logic:
- If `Peak level dB` < -0.1 → **no clipping** (peak isn't at the ceiling), Clip = 0.
- Else Clip = `Peak count`. Then judge severity:
  - `Clip` > ~500 samples → flag `CLIPPING` (sustained — review in Audacity).
  - 1–500 samples → note as minor/incidental; do **not** warn (typically inaudible).

Note: `input_tp > 0 dBTP` from the loudness check (step 3) is **inter-sample true
peak**, not digital clipping. It is resolved by the -1 dBTP output ceiling in
Phase 2 and must not be reported as clipping.

**5. DC offset**
```
sox input.wav -n stat 2>&1 | grep "Mean"
```
Flag any file where mean amplitude is above 0.01 or below -0.01

**6. Frequency energy** — check how much energy is below 80Hz and above 16kHz
```
ffmpeg -i input.wav -af "lowpass=f=80,volumedetect" -f null - 2>&1
ffmpeg -i input.wav -af "highpass=f=16000,volumedetect" -f null - 2>&1
```
Report mean volume of low-end (<80Hz) and high-end (>16kHz) energy per file

### Diagnostic Report Format
Write `./diagnostic_report.txt` with the following:

```
DIAGNOSTIC REPORT
Generated: [timestamp]
Files analyzed: [n]
===========================================

SUMMARY
-------
Sample rate:        [e.g. 48000 Hz]
Bit depth:          [e.g. 16-bit]
Stereo/Mono:        [e.g. TRUE STEREO / DUAL MONO]
Avg integrated LUFS:[e.g. -26.4]
Avg LRA:            [e.g. 13.2]
Files with clipping:[e.g. 3]
Files with DC offset:[e.g. 0]
Low-end energy (<80Hz): [e.g. -42 dBFS mean — HIGH-PASS FILTER RECOMMENDED]
High-end energy (>16kHz): [e.g. -68 dBFS mean — LOW-PASS FILTER OPTIONAL]

RECOMMENDATIONS
---------------
[List specific filter and processing recommendations based on findings]
e.g. "High-pass filter at 80Hz recommended — significant low-end energy detected"
e.g. "3 files have clipping — review tracks 04, 11, 22 in Audacity before processing"
e.g. "All files confirmed TRUE STEREO — process as stereo"

PER-FILE DETAILS
----------------
File                  | LUFS   | LRA  | True Peak | Clipping | DC Offset | Stereo     | Duration
----------------------|--------|------|-----------|----------|-----------|------------|----------
track_01.wav          | -28.3  | 14.2 | -2.1 dBTP | NONE     | OK        | TRUE STEREO| 3:42
track_02.wav          | -24.1  | 9.8  | -0.3 dBTP | NONE     | OK        | TRUE STEREO| 4:15
...

FLAGS
-----
[List any files that need attention, e.g.:]
⚠ track_04.wav — CLIPPING DETECTED. Review in Audacity before processing.
⚠ track_11.wav — LRA > 15 (very dynamic). Normalization may sound uneven.
⚠ track_22.wav — DUAL MONO detected. Consider converting to mono.
```

After writing the report, tell the user:
- Where the report was saved
- Summary of key findings in plain language
- Ask the user to review and confirm before proceeding to Phase 2

---

## Phase 2 — Processing

### Only run after user confirms they have reviewed the diagnostic report.

### Goal
Apply a high-pass filter (if recommended) and loudness normalize all WAV files to **-20 LUFS integrated** with a **-1 dBTP true peak ceiling**. Save to `./processed/` without modifying originals.

### Ask the user before processing:
1. "The diagnostic recommended a high-pass filter at 80Hz. Apply it? (yes/no)"
2. "Apply a low-pass filter at 18kHz? (yes/no — optional, mild benefit)"
3. "Apply 60Hz hum notch filter? (yes/no — only if hum was audible)"

### Processing chain per file (two-pass loudness normalization):

Build the ffmpeg audio filter chain based on user answers:
- If high-pass: add `highpass=f=80`
- If low-pass: add `lowpass=f=18000`
- If hum notch: add `equalizer=f=60:width_type=o:width=2:g=-20,equalizer=f=120:width_type=o:width=2:g=-10,equalizer=f=180:width_type=o:width=2:g=-6`
- DC offset removal: **only if Phase 1 flagged it.** Note `dcshift=0` is a no-op —
  it shifts by zero and removes nothing. To actually remove DC, either apply a
  gentle high-pass `highpass=f=20`, or shift by the measured mean
  `dcshift={-mean}` using the value from the Phase 1 sox check. If an 80 Hz
  high-pass is already in the chain, DC (0 Hz) is already removed — skip a
  separate DC step.
- Always end with loudnorm

**Pass 1** — measure loudness (apply filters in measurement too):
```
ffmpeg -i input.wav -af "{filters},loudnorm=I=-20:LRA=11:TP=-1:print_format=json" -f null - 2>&1
```
Parse JSON for: `input_i`, `input_lra`, `input_tp`, `input_thresh`, `target_offset`

**Pass 2** — apply filters + normalization:
```
ffmpeg -i input.wav -af "{filters},loudnorm=I=-20:LRA=11:TP=-1:measured_I={input_i}:measured_LRA={input_lra}:measured_tp={input_tp}:measured_thresh={input_thresh}:offset={target_offset}:linear=true:print_format=summary" -ar {sample_rate} -c:a {pcm_codec} ./processed/{filename}.wav
```

**Bit depth — do not build the codec as `pcm_s{bitdepth}le`.** 24-bit WAV (and
24-bit FLAC) report `sample_fmt=s32` in ffprobe, so a naive `s{bitdepth}` either
guesses wrong or emits 32-bit. Detect from `bits_per_raw_sample` (authoritative;
if empty and `sample_fmt=s32`, assume 24-bit), then pick the codec for the output
container:

| Source depth | WAV output (`{pcm_codec}`) | FLAC output |
|--------------|----------------------------|-------------|
| 16-bit       | `pcm_s16le`                | `flac -sample_fmt s16` |
| 24-bit       | `pcm_s24le`                | `flac -sample_fmt s32 -bits_per_raw_sample 24` |
| 32-bit int   | `pcm_s32le`                | `flac -sample_fmt s32` |
| float        | `pcm_f32le`                | `flac -sample_fmt s32 -bits_per_raw_sample 24` (FLAC can't store float; encodes as 24-bit int — fine for non-float concert audio) |

Use the WAV column for `.wav` input and the FLAC column for `.flac` input, and
write the output with the matching extension. `-ar {sample_rate}` is **required**,
not optional: loudnorm resamples to 192 kHz internally and writes the output at
192 kHz unless the source rate is pinned back.

**Pass 3 (re-measure)** — the report must show the *achieved* loudness, not an
assumed -20. With `linear=true`, loudnorm falls back to dynamic mode when linear
gain would breach the -1 dBTP ceiling, so outputs drift (observed range roughly
-19.6 to -20.4). Re-run the loudness analysis on the output file and use its
`input_i` as the "Output LUFS" value:
```
ffmpeg -i ./processed/{filename}.wav -af loudnorm=I=-20:LRA=11:TP=-1:print_format=json -f null - 2>&1
```

### Processing Report Format
Write `./processed/processing_report.txt`:

```
PROCESSING REPORT
Generated: [timestamp]
Filters applied: [list]
Target: -20 LUFS / -1 dBTP
===========================================

File                  | Input LUFS | Input LRA | Input Peak | Output LUFS | Status
----------------------|------------|-----------|------------|-------------|-------
track_01.wav          | -28.3      | 14.2      | -2.1 dBTP  | -19.97      | OK
track_02.wav          | -24.1      | 9.8       | -0.3 dBTP  | -20.08      | OK

(Output LUFS are the re-measured Pass 3 values — expect small drift off -20, not a
perfect -20.0 on every row. If every row reads exactly -20.0, Pass 3 wasn't run.)

FLAGS
-----
⚠ [any files that need attention]
```

### Important Notes
- Process files one at a time, not in parallel
- If a file fails, log the error and continue with remaining files
- Do not modify any files in the input folder
- Print progress to terminal as each file completes: e.g. `[3/31] track_03.wav — done`
- Preserve original sample rate and bit depth — do not resample or change bit depth
