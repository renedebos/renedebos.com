# Audio Processing Instructions for Claude Code

## Overview
This is an end-to-end workflow for taking live-concert song files from Google
Drive, loudness-normalizing them, and publishing them to renedebos.com. Sources
are the per-song split tracks of a show — usually **FLAC**, sometimes **WAV**
(both lossless); a folder may contain a mix.

The pipeline has four phases:

- **Phase 0 — Pull from Google Drive.** Download a show's track files to a local
  working folder. No processing.
- **Phase 1 — Diagnostic analysis.** Probe every file (loudness, peak level,
  clipping, dynamics, DC, frequency balance), choose the loudness target, and —
  in **recommend-only** mode — print a suggested remediation flow for any problem
  files. Generates a report. No files are modified.
- **Phase 2 — Processing.** Apply filters and loudness normalization based on
  Phase 1, writing processed files to a `./processed/` subfolder. Run only after
  the user reviews the diagnostic report.
- **Phase 3 — Publish to the website.** Upload the processed tracks to Cloudflare
  R2, update `data/recordings.json`, regenerate waveform peaks, rebuild the site,
  and add the appropriate Updates-page note. Two sub-paths: re-processing a show
  already on the site, or adding a brand-new show.

Always run Phase 1 first and wait for user confirmation before Phase 2, and show
the publish plan before Phase 3.

### Input formats and output container
Process both `*.wav` and `*.flac` in the input folder. The lossless processed
output **mirrors the input container** — WAV in → WAV out, FLAC in → FLAC out —
so the archive stays lossless and FLAC sources keep their ~50% size advantage.
For publishing, an MP3 is additionally derived from each processed lossless file
(see Phase 2 and Phase 3). All ffprobe/ffmpeg commands below work identically on
either container; only the Pass 2 output codec differs (see "Bit depth" under
Phase 2). Throughout this doc "WAV" in the example commands stands in for "the
input file," whatever its container.

### Keep the leading track number
Every step downstream — title parsing, `gen_peaks.py`, and especially
`update_tracks.py` — keys off the **leading track number** in each filename
(e.g. `01 State Trooper.flac`). Never rename files in a way that drops or changes
that number. Processed output keeps the same `NN Title.<ext>` name as its source.

---

## Prerequisites
Check the tools below before doing anything else:
```
ffmpeg -version      # if missing: sudo apt install ffmpeg
sox --version        # if missing: sudo apt install sox
rclone version       # required for Phase 0 (Drive) and Phase 3 (R2)
```
The repo's `gdrive:` and `r2:` rclone remotes must already be configured (they
are on this machine). Run Python helpers (`build.py`, `update_tracks.py`,
`gen_peaks.py`) from the repo root, `~/renedebos.com`.

---

## Phase 0 — Pull from Google Drive

### Goal
Download a show's split-track files from Drive to a local working folder so the
later phases operate on local copies. **Source of truth is real Google Drive via
the `gdrive:` remote — not `~/gdrive-mount`, which is only a stale local copy.**

### Find the show's track folder
Split tracks live under the Work Folder. The folder may or may not carry an `SBD`
suffix, and tracks are usually in a `Tracks` subfolder (sometimes
`Tracks/Normalized` for an earlier pass):
```
rclone lsf "gdrive:DAT Tapes/Work Folder/" --drive-shared-with-me --dirs-only
rclone lsf "gdrive:DAT Tapes/Work Folder/<show>/" --drive-shared-with-me --dirs-only
```

### Download to a local working folder
Use a per-show working directory under `~/`. Keep the original filenames:
```
mkdir -p ~/work/<slug>/input
rclone copy "gdrive:DAT Tapes/Work Folder/<show>/Tracks" \
  ~/work/<slug>/input --drive-shared-with-me --progress
```
Then confirm what landed and that every file has a leading track number:
```
ls -1 ~/work/<slug>/input
```
Watch for **trailing spaces** in Drive filenames (e.g. `03 Galway Shawl .flac`) —
they ride through verbatim and will drift from the clean R2 keys. Flag any to the
user before processing.

All subsequent phases use `~/work/<slug>/input` as the input folder and
`~/work/<slug>/processed` as the output folder.

---

## Phase 1 — Diagnostic Analysis

### Goal
Analyze all input files, choose the loudness target, and produce a diagnostic
report so the user can make informed decisions. **Do not modify any files.**

### Run the following checks on every file:

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
ffmpeg -i input.wav -af loudnorm=I=-18:LRA=11:TP=-1:print_format=json -f null - 2>&1
```
Parse JSON for: `input_i` (integrated LUFS), `input_lra` (loudness range),
`input_tp` (true peak). The `I=` value here only affects the measurement pass's
suggested offset, not the measured inputs — the real per-show target is chosen
below.

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

### Choosing the loudness target (per show)
These recordings vary in dynamics by performer, so the integrated target is **not
fixed**. Pick a default by artist, then let the measurements override it.

**Default by artist.** Solo acoustic sets are very dynamic and sound best left
that way; a full band is denser and wants to read louder:

| Artist (`recordings.json` id) | Performer            | Default target |
|-------------------------------|----------------------|----------------|
| `jerry`                       | Jerry Hannan (solo)  | **−20 LUFS**   |
| `sean`                        | Sean Hannan (solo)   | **−20 LUFS**   |
| `seanjerry`                   | Sean & Jerry (duo)   | **−20 LUFS**   |
| `mad`                         | Mad Hannans (band)   | **−16 LUFS**   |

The output true-peak ceiling is always **−1 dBTP**. For a show already in
`recordings.json`, read its `artist` id. For a new show, infer from the source
folder/filename prefix (`JerryHannan`→jerry, `SeanHannan`→sean, `MadHannans`→mad,
`Sean & Jerry`/`SeanJerry`→seanjerry); if ambiguous, ask the user.

**Override from the measurements (predicted true peak).** Linear normalization
just applies a constant gain, so it raises true peak by exactly the gain applied.
For each file predict the peak at the chosen target:
```
predicted_TP = input_tp + (target_LUFS − input_i)
```
- `predicted_TP ≤ −1 dBTP` → the target is reachable transparently (linear). Good.
- `predicted_TP > −1 dBTP` → the target is **not reachable without taming peaks**.
  loudnorm would silently switch to dynamic mode and compress the performance.
  The most transparent fix is to lower the target to the highest value that still
  fits under the ceiling:
  ```
  max_linear_target = input_i − input_tp − 1
  ```
  Report this. If most files in a solo show fall here, the −20 default is already
  doing its job; if a band show repeatedly overshoots −16, recommend backing it
  down toward −18. Conversely, if a "−20" solo show is tame (low LRA, predicted_TP
  well under −1 across the board), note that −18 would be safe if more level is
  wanted.

### Suggested processflow for problem files (recommend-only)
**For now the workflow only recommends — it does not auto-apply** limiter or
compressor steps. Phase 2 applies only the filters + normalization the user
approves. For each flagged file, print the matching recommendation so the user
can see how many files actually need hands-on work before deciding whether to
automate later.

| Symptom (from the checks above)                | Recommended remediation (manual)                                                                                                                                              |
|------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Sustained `CLIPPING` (>500 full-scale samples) | The source is already clipped — normalization cannot restore lost peaks, and lowering gain won't help. Review in Audacity; only mild cases benefit from Audacity's Clip Fix.   |
| `predicted_TP > −1 dBTP` at target             | Either (a) drop the target to `max_linear_target` (fully transparent), or (b) insert a brickwall limiter *before* loudnorm to shave the few transient peaks and keep the louder target: `alimiter=limit=0.9:attack=5:release=50` (≈ −0.9 dBFS). Use (b) when only a handful of rogue transients are the obstacle. |
| `LRA > 15` (very dynamic / uneven set)         | Gentle compression before normalizing to even out the set, e.g. `acompressor=threshold=0.1:ratio=2:attack=20:release=250` (threshold ≈ −20 dBFS), or just accept it and use the lower (−20) target. Audacity equivalent: Compressor effect, ~2:1. |
| DC offset flagged                              | Handled in Phase 2 (high-pass 20 Hz or `dcshift`).                                                                                                                            |
| High <80 Hz energy                             | Handled in Phase 2 (high-pass 80 Hz).                                                                                                                                         |
| Audible 60 Hz hum                              | Handled in Phase 2 (notch filter).                                                                                                                                            |

If the user later wants auto-apply, the limiter/compressor snippets above slot
into the Phase 2 filter chain *before* `loudnorm` (limiter last, just ahead of
loudnorm). Until then, treat them as advisory only.

### Diagnostic Report Format
Write `./diagnostic_report.txt` with the following:

```
DIAGNOSTIC REPORT
Generated: [timestamp]
Files analyzed: [n]
Loudness target: [−20 or −16] LUFS / −1 dBTP  ([artist] default)
===========================================

SUMMARY
-------
Sample rate:        [e.g. 48000 Hz]
Bit depth:          [e.g. 16-bit]
Stereo/Mono:        [e.g. TRUE STEREO / DUAL MONO]
Avg integrated LUFS:[e.g. -26.4]
Avg LRA:            [e.g. 13.2]
Files with clipping:[e.g. 3]
Files needing peak taming to hit target (predicted_TP > -1): [e.g. 2]
Files with DC offset:[e.g. 0]
Low-end energy (<80Hz): [e.g. -42 dBFS mean — HIGH-PASS FILTER RECOMMENDED]
High-end energy (>16kHz): [e.g. -68 dBFS mean — LOW-PASS FILTER OPTIONAL]

RECOMMENDATIONS
---------------
[List specific filter, target, and remediation recommendations based on findings]
e.g. "High-pass filter at 80Hz recommended — significant low-end energy detected"
e.g. "Target −16 LUFS (Mad Hannans); tracks 04 and 12 predict TP > -1 — limiter or back off to −18 for those."
e.g. "3 files have clipping — review tracks 04, 11, 22 in Audacity before processing"
e.g. "All files confirmed TRUE STEREO — process as stereo"

PER-FILE DETAILS
----------------
File                  | LUFS   | LRA  | True Peak | Pred.TP@tgt | Clipping | DC Offset | Stereo     | Duration
----------------------|--------|------|-----------|-------------|----------|-----------|------------|----------
01 State Trooper.flac | -28.3  | 14.2 | -2.1 dBTP | -10.4 dBTP  | NONE     | OK        | TRUE STEREO| 5:15
02 Crystal Rose.flac  | -24.1  | 9.8  | -0.3 dBTP | -0.2 dBTP ⚠ | NONE     | OK        | TRUE STEREO| 3:50
...

FLAGS
-----
[List any files that need attention, e.g.:]
⚠ 04 ….flac — CLIPPING DETECTED. Review in Audacity before processing.
⚠ 02 ….flac — predicted TP -0.2 dBTP > -1 at -16 target. Limiter, or use -17.3 max linear target.
⚠ 11 ….flac — LRA > 15 (very dynamic). Consider gentle compression or the -20 target.
⚠ 22 ….flac — DUAL MONO detected. Consider converting to mono.
```

After writing the report, tell the user:
- Where the report was saved
- The chosen target and why (artist default + any per-file overrides)
- Summary of key findings and the count of problem files in plain language
- Ask the user to review and confirm before proceeding to Phase 2

---

## Phase 2 — Processing

### Only run after user confirms they have reviewed the diagnostic report.

### Goal
Apply a high-pass filter (if recommended) and loudness normalize all files to the
**Phase 1 target** (−20 or −16 LUFS integrated) with a **-1 dBTP true peak
ceiling**. Write processed files to `~/work/<slug>/processed/` without modifying
originals. `{target_lufs}` below is the value chosen in Phase 1.

### Ask the user before processing:
1. "Confirm the loudness target: {target_lufs} LUFS? (yes / change)"
2. "The diagnostic recommended a high-pass filter at 80Hz. Apply it? (yes/no)"
3. "Apply a low-pass filter at 18kHz? (yes/no — optional, mild benefit)"
4. "Apply 60Hz hum notch filter? (yes/no — only if hum was audible)"

(Limiter/compressor are **recommend-only** — do not apply them automatically. If
the user explicitly asks to apply one from the Phase 1 recommendations, insert it
into the chain just before `loudnorm`.)

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
- (Optional, only if user opted in) limiter/compressor from Phase 1, placed last
  before loudnorm.
- Always end with loudnorm

**Pass 1** — measure loudness (apply filters in measurement too):
```
ffmpeg -i input.wav -af "{filters},loudnorm=I={target_lufs}:LRA=11:TP=-1:print_format=json" -f null - 2>&1
```
Parse JSON for: `input_i`, `input_lra`, `input_tp`, `input_thresh`, `target_offset`

**Pass 2** — apply filters + normalization (lossless output):
```
ffmpeg -i input.wav -af "{filters},loudnorm=I={target_lufs}:LRA=11:TP=-1:measured_I={input_i}:measured_LRA={input_lra}:measured_tp={input_tp}:measured_thresh={input_thresh}:offset={target_offset}:linear=true:print_format=summary" -ar {sample_rate} -c:a {pcm_codec} ~/work/<slug>/processed/{filename}.wav
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
assumed target. With `linear=true`, loudnorm falls back to dynamic mode when
linear gain would breach the -1 dBTP ceiling, so outputs drift (expect roughly
±0.4 LU off the target). Re-run the loudness analysis on the output file and use
its `input_i` as the "Output LUFS" value:
```
ffmpeg -i ~/work/<slug>/processed/{filename}.wav -af loudnorm=I={target_lufs}:LRA=11:TP=-1:print_format=json -f null - 2>&1
```

**Derive the publish MP3 (only for the website pipeline).** The site serves a
320 kbps MP3 per track (streamed + free download) alongside the gated FLAC, so
encode an MP3 **from the processed lossless file** (not the original) into the
same folder, preserving the `NN Title` name:
```
ffmpeg -hide_banner -loglevel error -y -i ~/work/<slug>/processed/{filename}.flac \
  -b:a 320k ~/work/<slug>/processed/{filename}.mp3
```
After this, `~/work/<slug>/processed/` holds a matched `NN Title.flac` +
`NN Title.mp3` per track — exactly what Phase 3 publishes.

### Processing Report Format
Write `~/work/<slug>/processed/processing_report.txt`:

```
PROCESSING REPORT
Generated: [timestamp]
Filters applied: [list]
Target: {target_lufs} LUFS / -1 dBTP
===========================================

File                  | Input LUFS | Input LRA | Input Peak | Output LUFS | Status
----------------------|------------|-----------|------------|-------------|-------
01 State Trooper.flac | -28.3      | 14.2      | -2.1 dBTP  | -19.97      | OK
02 Crystal Rose.flac  | -24.1      | 9.8       | -0.3 dBTP  | -16.08      | OK

(Output LUFS are the re-measured Pass 3 values — expect small drift off the
target, not a perfect round number on every row. If every row reads exactly the
target, Pass 3 wasn't run.)

FLAGS
-----
⚠ [any files that need attention]
```

### Important Notes
- Process files one at a time, not in parallel
- If a file fails, log the error and continue with remaining files
- Do not modify any files in the input folder
- Print progress to terminal as each file completes: e.g. `[3/31] 03 ….flac — done`
- Preserve original sample rate and bit depth — do not resample or change bit depth

---

## Phase 3 — Publish to the website

### Only run after the user has reviewed the processing report.

### Goal
Get the processed tracks live on renedebos.com: upload to R2, update
`data/recordings.json`, regenerate waveform peaks, rebuild, add the right Updates
note, and deploy. Run all Python helpers from the repo root `~/renedebos.com`.

This phase covers the **split-song tracks** only. Whole-show lossless downloads
and their stream proxies are a separate concern (`scripts/make_stream_mp3.py`) and
are out of scope here.

### First decide: is this show already on the site?
```
python3 - <<'PY'
import json
M=json.load(open("data/recordings.json"))
slug="<slug>"
s=next((x for x in M["shows"] if x["slug"]==slug), None)
print("EXISTING with tracks" if s and s.get("tracks") else "NEW (or stub without tracks)")
PY
```
- **Existing with tracks → Path A** (re-processing). Overwrite in place; add a
  manual Updates note.
- **New / stub → Path B** (new show). Create the entry; the Updates note is
  generated automatically.

Both paths assume `~/work/<slug>/processed/` holds matched `NN Title.mp3` +
`NN Title.flac` files with intact leading track numbers.

---

### Path A — Re-processing a show already on the site

1. **Upload + refresh metadata in one step.** `update_tracks.py` matches your
   processed files to the show's existing tracks by leading number, overwrites the
   matching MP3/FLAC keys in R2, and refreshes each track's `size_mb`/`duration`
   in `recordings.json`:
   ```
   python3 scripts/update_tracks.py <slug> ~/work/<slug>/processed
   ```
   Partial sets are fine — only tracks present in the folder are touched. Because
   the site streams from R2 with `Cache-Control: no-store`, the new audio is
   **live the moment the upload finishes**; the rest is to refresh displayed sizes
   and the changelog.

2. **Regenerate waveform peaks** (the waveform changed):
   ```
   python3 scripts/gen_peaks.py --slug <slug>
   ```

3. **Add a manual Updates note.** The show's `added` date is old, so nothing is
   auto-generated. Add one entry to the top-level `updates` array in
   `data/recordings.json`:
   ```json
   { "date": "YYYY-MM-DD", "ts": "YYYY-MM-DDTHH:MM:SS", "slug": "<slug>",
     "text": "Re-normalized all tracks to −16 LUFS for a more even, comfortable listening level" }
   ```
   Match the phrasing style of existing entries; state the actual target used.
   (Alternatively use `make edit` → the show's "Update note" field, which posts
   the same entry.) **Do not** also rely on auto-generation here — that only fires
   for newly-added shows.

4. **Rebuild, commit, deploy:**
   ```
   python3 scripts/build.py
   git add -A && git commit -m "Re-normalize <slug> tracks to {target} LUFS" && git push
   ```
   Pushing `main` deploys via Cloudflare Pages.

---

### Path B — Adding a new show

1. **Establish naming.** Pick the artist id (`jerry`/`sean`/`mad`/`seanjerry`),
   venue, and date. Conventions:
   - **slug**: `<artist>-<venue-short>-<date>`, e.g. `jerry-19-broadway-2001-01-15`
   - **R2 folder**: `<ArtistCamel> - <Venue> <date>` with **no** `SBD`/subtitle
     suffix, e.g. `JerryHannan - 19 Broadway 2001-01-15`

2. **Upload to new R2 keys** (MP3 streamed/free, FLAC gated):
   ```
   FOLDER="JerryHannan - 19 Broadway 2001-01-15"
   rclone copy ~/work/<slug>/processed "r2:hannan-audio/MP3/$FOLDER" \
     --include "*.mp3" --s3-no-check-bucket --progress
   rclone copy ~/work/<slug>/processed "r2:hannan-audio/FLAC/$FOLDER" \
     --include "*.flac" --s3-no-check-bucket --progress
   ```
   Final keys: `MP3/<folder>/NN Title.mp3` and `FLAC/<folder>/NN Title.flac`.

3. **Add the show entry to `data/recordings.json`.** Add an object to `shows[]`.
   Critical schema points (see also the project memory notes):
   - `artist` is an **id** from `artists[]` (not a name); a bad id crashes the build.
   - `description` **must be a list** of paragraph strings, never a bare string.
   - Per-track schema: `{num, title, duration "M:SS", size_mb, file (MP3 key),
     flac (FLAC key), flac_size_mb}` plus optional `tags`, per-track `artist`
     (guest singer display name), `dropouts: true`.
   - Derive `duration`/`size_mb`/`flac_size_mb` from the processed files:
     ```
     ffprobe -v quiet -show_entries format=duration -of csv=p=0 "NN Title.mp3"  # → M:SS
     ```
   Skeleton:
   ```json
   {
     "slug": "<slug>", "artist": "jerry",
     "venue": "19 Broadway, Fairfax", "venue_short": "19 Broadway",
     "date": "2001-01-15", "date_display": "January 15, 2001",
     "subtitle": null, "source": "SBD",
     "recordings": [],
     "tracks": [
       { "num": 1, "title": "State Trooper", "duration": "5:15", "size_mb": 12,
         "file": "MP3/JerryHannan - 19 Broadway 2001-01-15/01 State Trooper.mp3",
         "flac": "FLAC/JerryHannan - 19 Broadway 2001-01-15/01 State Trooper.flac",
         "flac_size_mb": 58 }
     ],
     "description": ["First paragraph…", "Second paragraph…"]
   }
   ```
   Editorial fields (titles, description, tags) are easiest to fill via `make edit`
   after the entry exists. Leave `recordings[]` empty unless you are also adding
   whole-show files (out of scope here).

4. **Do NOT add a manual Updates entry.** `build.py`'s `stamp_added_dates()`
   auto-stamps `added`/`added_ts` for any show that has tracks but no `added`, and
   `updates_list()` then auto-generates an "Added … N split tracks" feed event. A
   manual entry on top would duplicate it.

5. **Generate peaks, rebuild, commit, deploy:**
   ```
   python3 scripts/gen_peaks.py --slug <slug>
   python3 scripts/build.py
   git add -A && git commit -m "Add <slug> (N split tracks)" && git push
   ```

---

### Post-publish check
- Confirm the show page renders tracks with waveforms and the Updates page shows
  the expected (auto or manual) entry.
- Spot-check one track streams and that the FLAC download is gated while the MP3
  is free.
- Optional follow-up (open decision): sync the louder versions back to the Drive
  Work Folder so the site and archive don't drift.
