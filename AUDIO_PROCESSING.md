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
  add the appropriate Updates-page note, and mirror the processed files back to the
  Drive archive. Two sub-paths: re-processing a show already on the site, or adding
  a brand-new show.

Always run Phase 1 first and wait for user confirmation before Phase 2, and show
the publish plan before Phase 3.

### Lossless sources only — skip MP3
**Process only lossless sources: `*.flac` and `*.wav`.** Scan the input folder for
those; if it also contains `*.mp3`, **report them and skip them** — do not process
or upload an MP3 source. Three reasons:
1. You cannot make a lossless FLAC from an MP3, so an MP3 source can only update a
   track's streamed MP3 and leaves its gated FLAC at the old level — the two drift
   out of sync. (This is exactly what happened on the first test run.)
2. Decoding an MP3, filtering, and re-encoding to MP3 is generational quality loss.
3. The served MP3 is always **derived from the processed lossless master** (Phase
   2), so MP3 and FLAC can never drift by construction.

**Never let an MP3 source overwrite a track that has a FLAC on the site.** The only
allowed exception is a track whose lossless master is genuinely lost — and only
with the user's explicit opt-in for that specific track.

### Output container
The lossless processed output **mirrors the input container** — WAV in → WAV out,
FLAC in → FLAC out — so the archive stays lossless and FLAC sources keep their
~50% size advantage. For publishing, an MP3 is additionally derived from each
processed lossless file (see Phase 2 and Phase 3). All ffprobe/ffmpeg commands
below work identically on either container; only the Pass 2 output codec differs
(see "Bit depth" under Phase 2). Throughout this doc "WAV" in the example commands
stands in for "the input file," whatever its container.

### Keep the leading track number
Every step downstream — title parsing, `gen_peaks.py`, and especially
`update_tracks.py` — keys off the **leading track number** in each filename
(e.g. `01 State Trooper.flac`). Never rename files in a way that drops or changes
that number. Processed output keeps the same `NN Title.<ext>` name as its source.

### Keeping the source filenames in step with the catalog
Retitling a song in `make edit` changes `data/recordings.json` but **not** the
split file on Drive, and `batch_process.validate()` compares the two
positionally. Drift past `max(1, 0.15 x track_count)` positions in one show and
the next reprocess is **HELD** as `title-mismatch` — the gate cannot tell a
batch of deliberate renames from an off-by-one shift in the mapping.

`make build` warns about this, offline, from `data/source_names.json` — a
tracked cache of the Drive listings. It never touches the network (the build is
byte-reproducible in CI, which has no Drive credentials) and never fails on it.
The renaming is a separate, deliberate step:

```
make sync-titles                   # dry run: report drift, refresh the cache
make sync-titles APPLY=1           # rename the Drive sources to match
make sync-titles ONLY=<slug>       # one show
python3 scripts/sync_source_titles.py --refresh-only    # cache only, no report
```

It refuses to rename unless the listing is cleanly aligned (one file per track,
numbers a clean `1..N`), skips any rename whose target name already exists
(Drive permits same-name duplicates), and skips a show with a prepared
`~/work/<slug>/publish.json`, whose manifest and fingerprint are keyed on these
filenames — pass `--force` only after finishing or discarding that publish.

The comparison itself lives in `scripts/title_match.py`, shared by the gate, the
sync tool, and the build warning, so the threshold that warns is by construction
the threshold that holds.

---

## Prerequisites
Check the tools below before doing anything else:
```
ffmpeg -version      # if missing: sudo apt install ffmpeg
rclone version       # required for Phase 0 (Drive) and Phase 3 (R2)
```
ffmpeg covers every measurement (loudness, peak, DC offset via `astats`); no
`sox` needed. The repo's `gdrive:` and `r2:` rclone remotes must already be
configured (they are on this machine). Run all Python helpers from the repo root,
`~/renedebos.com`.

### Tooling — use the committed engine
Phases 1–2 are implemented in **`scripts/audio_process.py`** (with
`scripts/clipcheck.py` for the second-tier clipping check) so they're versioned
and reproducible rather than re-typed each run:
```
python3 scripts/audio_process.py diagnose <input-folder> --artist <id>     # Phase 1
python3 scripts/audio_process.py process  <input-folder> <output-folder> \
        --target <LUFS> [--hpf] [--lpf] [--notch] --slug <slug>            # Phase 2
python3 scripts/audio_process.py verify   <slug> [--drive <path>]          # Phase 3 integrity
```
The engine handles the lossless-only rule, the single −20 LUFS target shared by
every artist (`jerry`/`sean`/`seanjerry`/`mad` — Mad Hannans moved from −16 after
A/B testing showed no audible gain and it was forcing non-linear processing on
band masters), a loudnorm/ebur128 *measurement* pass followed by one fixed
linear gain (`volume`) at the measured value — loudnorm never renders, see
Pass 2 below — the derived 320k MP3, the audio MD5, output
verification (flags TP over ceiling / LUFS drift), and the provenance sidecar —
and is **resumable** (skips tracks whose outputs exist). The sections below
document the *why* and the underlying ffmpeg commands the engine runs; reach for
them when debugging or doing something off the beaten path.

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
rclone lsf "gdrive:DAT Tapes/Work Folder/" --dirs-only
rclone lsf "gdrive:DAT Tapes/Work Folder/<show>/" --dirs-only
```

### Download to a local working folder
Use a per-show working directory under `~/`. Keep the original filenames:
```
mkdir -p ~/work/<slug>/input
rclone copy "gdrive:DAT Tapes/Work Folder/<show>/Tracks" \
  ~/work/<slug>/input --progress
```
Then confirm what landed and that every file has a leading track number:
```
ls -1 ~/work/<slug>/input
```
- Watch for **trailing spaces** in Drive filenames (e.g. `03 Galway Shawl .flac`)
  — they ride through verbatim and will drift from the clean R2 keys. Flag any.
- **List any `*.mp3` files separately and report them as "skipped (lossy source)"**
  per the lossless-only rule above. The folder is often a mixed dumping ground;
  only the `*.flac`/`*.wav` files go forward. If the user wants an MP3-only track
  processed anyway, that's an explicit per-track opt-in (and never overwrites a
  FLAC).

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
scale. Use `astats` as a fast **screen**:
- If `Peak level dB` < -0.1 → **no clipping** (peak isn't at the ceiling). Done.
- Else the peak is at full scale → run the **second-tier run-length check** below
  to decide whether it's real clipping or just isolated transient peaks.

**Second-tier check — `scripts/clipcheck.py` (run only on files the screen flags).**
A raw count can't tell an isolated transient peak (benign, inaudible) from real
clipping; the *longest consecutive run* of full-scale samples can. Run it on the
flagged file(s) — or the whole input folder, it self-skips clean files:
```
python3 scripts/clipcheck.py "input.flac"        # or a folder
```
It prints one of four verdicts per file (and exits non-zero if any is CLIPPING):
- `NONE` — peak never actually reaches full scale.
- `benign` — isolated full-scale samples, longest run < 0.1 ms → **inaudible, do
  not warn.**
- `minor` — short clips (longest run 0.1–1 ms) → probably inaudible; note for
  review only.
- `CLIPPING` — sustained flat tops (≥ 1 ms, or repeated clip events) → **likely
  audible; flag for review/declip in Audacity.**

Report the verdict (and the longest-run figure) in the diagnostic, not a bare
count. Real audible clipping is many consecutive samples pinned at the ceiling
(milliseconds of flattened waveform); a handful of samples touching it for
microseconds is just a transient and is left alone.

Note: `input_tp > 0 dBTP` from the loudness check (step 3) is **inter-sample true
peak**, not digital clipping. It is resolved by the -1 dBTP output ceiling in
Phase 2 and must not be reported as clipping.

**5. DC offset**
```
ffmpeg -i input.wav -af "astats=measure_perchannel=0" -f null - 2>&1 | grep "DC offset"
```
Flag any file where the `DC offset` (fraction, -1..1) is above 0.01 or below -0.01.

**6. Frequency energy** — check how much energy is below 80Hz and above 16kHz
```
ffmpeg -i input.wav -af "lowpass=f=80,volumedetect" -f null - 2>&1
ffmpeg -i input.wav -af "highpass=f=16000,volumedetect" -f null - 2>&1
```
Report mean volume of low-end (<80Hz) and high-end (>16kHz) energy per file

### Choosing the loudness target (per show)
**Permanent policy (decided 2026-07-13): every artist targets −20 LUFS.** Mad
Hannans previously defaulted to −16 for their denser full-band sound, but A/B
testing found no audible benefit and it was routinely forcing band masters into
dynamic (non-linear) processing to hit the ceiling — see the linear-only rule
below. There is no more per-artist table; `jerry`/`sean`/`seanjerry`/`mad` all
process at −20 LUFS, −1 dBTP ceiling.

**Linear normalization is permanent policy, not a preference.** These are live
recordings with wide, intentional dynamics (fingerpicked verses next to
strummed choruses, hand-drawn fade-outs) — never insert a limiter or compressor
to buy headroom for a hotter target. ffmpeg's `loudnorm` only applies true
linear gain (a single constant multiplier) when the gain needed to hit −20 LUFS
keeps true peak under −1 dBTP; otherwise it silently falls back to dynamic
(frame-adaptive) normalization, which flattens hand-drawn fades and natural
dynamics with no warning in the logs. For each file, predict the peak at −20:
```
predicted_TP = input_tp + (−20 − input_i)
```
- `predicted_TP ≤ −1 dBTP` → −20 is reachable transparently (linear). Good.
- `predicted_TP > −1 dBTP` → −20 is **not reachable without taming peaks**. The
  engine (workflow v4+) automatically computes the highest target that still
  fits under the ceiling and processes that track at its own reduced level
  instead — never a limiter or compressor:
  ```
  max_linear_target = input_i − input_tp − 1
  ```
  A track landing a few dB quieter than −20 is inaudible as a defect; a
  flattened fade or squeezed dynamic range is not. See `WORKFLOW_VERSIONS[4]`
  in `scripts/audio_process.py` and CLAUDE.md for the full record.

### Other flagged conditions (recommend-only)
Phase 1 also flags conditions the engine does not auto-remediate — Phase 2
applies only the filters the user explicitly approves:

| Symptom (from the checks above)                | Recommended remediation (manual)                                                                                                                                              |
|------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Sustained `CLIPPING` (>500 full-scale samples) | The source is already clipped — normalization cannot restore lost peaks, and lowering gain won't help. Review in Audacity; only mild cases benefit from Audacity's Clip Fix.   |
| `LRA > 15` (very dynamic / uneven set)         | This is the recording's own dynamics, not a defect — accept it. Do not compress to "even out" a set; see the linear-normalization policy above. |
| DC offset flagged                              | Handled in Phase 2 (high-pass 20 Hz or `dcshift`).                                                                                                                            |
| High <80 Hz energy                             | Handled in Phase 2 (high-pass 80 Hz).                                                                                                                                         |
| Audible 60 Hz hum                              | Handled in Phase 2 (notch filter).                                                                                                                                            |

### Diagnostic Report Format
Write `./diagnostic_report.txt` with the following:

```
DIAGNOSTIC REPORT
Generated: [timestamp]
Files analyzed: [n]
Loudness target: −20 LUFS / −1 dBTP
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
e.g. "Target −20 LUFS; tracks 04 and 12 predict TP > -1 — will process at their own reduced max linear target instead."
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
⚠ 02 ….flac — predicted TP -0.2 dBTP > -1 at -20 target. Will use -20.7 max linear target instead.
⚠ 11 ….flac — LRA > 15 (very dynamic). This is the recording's own dynamics — no remediation.
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
Apply a high-pass filter (if recommended) and loudness normalize all files to
**−20 LUFS integrated** (or a track's own reduced `max_linear_target` where
Phase 1 flagged `predicted_TP > -1`) with a **-1 dBTP true peak ceiling**. Write
processed files to `~/work/<slug>/processed/` without modifying originals.
`{target_lufs}` below is −20, or the per-track override.

### Ask the user before processing:
1. "Confirm the loudness target: {target_lufs} LUFS? (yes / change)"
2. "The diagnostic recommended a high-pass filter at 80Hz. Apply it? (yes/no)"
3. "Apply a low-pass filter at 18kHz? (yes/no — optional, mild benefit)"
4. "Apply 60Hz hum notch filter? (yes/no — only if hum was audible)"

(**Never add a limiter or compressor to buy headroom for a hotter target** — see
the linear-normalization policy above. A track that can't hit −20 transparently
processes at its own reduced `max_linear_target` instead.)

### Processing chain per file (two-pass loudness normalization):

Build the ffmpeg audio filter chain based on user answers:
- If high-pass: add `highpass=f=80`
- If low-pass: add `lowpass=f=18000`
- If hum notch: add `equalizer=f=60:width_type=o:width=2:g=-20,equalizer=f=120:width_type=o:width=2:g=-10,equalizer=f=180:width_type=o:width=2:g=-6`
- DC offset removal: **only if Phase 1 flagged it.** Note `dcshift=0` is a no-op —
  it shifts by zero and removes nothing. To actually remove DC, either apply a
  gentle high-pass `highpass=f=20`, or shift by the measured mean
  `dcshift={-mean}` using the DC offset from the Phase 1 `astats` check. If an 80 Hz
  high-pass is already in the chain, DC (0 Hz) is already removed — skip a
  separate DC step.
- Always end with loudnorm — no limiter or compressor stage, ever (see policy above)

**Pass 1** — measure loudness (apply filters in measurement too):
```
ffmpeg -i input.wav -af "{filters},loudnorm=I={target_lufs}:LRA=11:TP=-1:print_format=json" -f null - 2>&1
```
Parse JSON for: `input_i`, `input_lra`, `input_tp`, `input_thresh`, `target_offset`

**Pass 2 (workflow v6+) — explicit gain, not a second loudnorm pass.** Earlier
versions handed Pass 1's measurement back into a second `loudnorm` call with
`linear=true` and trusted ffmpeg to render it linearly. That trust was
misplaced: `linear=true` is only a *request* — if the requested gain would
push true peak past the ceiling, ffmpeg silently falls back to dynamic
(frame-adaptive) normalization with no warning in the logs (see the
linear-normalization policy above). v6 removes that reliance structurally:
the gain is computed directly from Pass 1's measurement —
```
gain_db = target_lufs − input_i        # (or the track's own max_linear_target, see below)
```
— and applied with a plain, unconditional `volume` filter, which has no
fallback mode:
```
ffmpeg -i input.wav -af "{filters},volume={gain_db}dB:precision=double" -ar {sample_rate} -c:a {pcm_codec} ~/work/<slug>/processed/{filename}.wav
```
`loudnorm`/`ebur128` remain measurement-only tools throughout the pipeline;
they never perform the render. `target_lufs` here is either the show's
nominal target (`linear` mode) or the track's own `max_linear_target` from
the reduced-target math above (`linear-reduced` mode) — same two modes as
before, just rendered without a second normalization pass. The one exception
is **applause-limiter** tracks (workflow v5+): those still use
`volume={gain}dB,alimiter=limit=<amp>:attack=5:release=100:level=false:latency=1`,
gain sized to the music peaks, limiter reaching only the classified applause
transients — see `scripts/audio_process.py`'s `limiter_chain()`/`plan_track()`.

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
assumed target. Since v6's `volume` render is one constant multiply, the
achieved LUFS should land almost exactly on target (well under 0.1 LU off —
if you see the old ~±0.4 LU drift, something upstream is still routing through
a loudnorm render, not the current engine). Re-run the loudness analysis on
the output file and use its `input_i` as the "Output LUFS" value:
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
**MP3 true-peak trim loop (workflow v6+).** Lossy encoding can itself overshoot
the FLAC master's true peak (decoder reconstruction adds a bit of inter-sample
energy loudnorm/volume never saw). After encoding, measure the MP3's true peak;
if it's over the −1 dBTP ceiling, re-encode with a small extra `volume={trim}dB`
applied on top (the FLAC master is never touched — only the MP3 gets the trim),
up to 3 attempts total:
```
ffmpeg -hide_banner -loglevel error -y -i {filename}.flac -af "volume={trim}dB:precision=double" \
  -b:a 320k {filename}.mp3
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
- **QA gate (workflow v6+): output LRA must match source LRA within tolerance on
  every track**, not just applause-limiter ones — a silent dynamics change (e.g.
  a dynamic-mode render sneaking back in) shows up as an LRA shift regardless of
  which mode produced it, so the check now runs universally.

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

> **This phase (both paths below) predates `scripts/publish_show.py`, which is
> now the preferred way to actually publish** — its `prepare`/`publish` two-step
> is documented end-to-end in `PUBLISHING.md` and handles a new show or a
> reprocess of an existing one the same way (it's what produced every
> reprocess on record — see `PUBLISHING.md` Part 5). It additionally
> MD5-verifies the R2 upload against the provenance sidecar and backs the
> files up to Drive, neither of which the manual steps below do on their own.
> The detail below stays accurate for what's actually happening under the
> hood, for `batch_process.py`'s scope (Phases 0–2 only, see its docstring),
> and for a narrow manual fix — but for a normal publish, use `publish_show.py`.

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

### Save the processing provenance (both paths) — do NOT discard the reports
The diagnostic/processing reports are not throwaway: persist the per-track
measurements as a provenance sidecar at `data/processing/<slug>.json`. `build.py`
renders this into a collapsible **"Technical data"** table on the show page and
the Updates "view data" link (below) deep-links to it. Write it from the Phase 1/2
measurements:
```json
{
  "slug": "<slug>",
  "target_lufs": -20,
  "tp_ceiling": -1,
  "source": "24-bit / 48 kHz FLAC",
  "filters": "none",
  "tool": "ffmpeg loudnorm",
  "workflow_version": 1,
  "ffmpeg": "7.1.3-0+deb13u1",
  "date": "YYYY-MM-DD",
  "tracks": {
    "19": { "ver": 1, "chain": "loudnorm=I=-20:LRA=11:TP=-1:linear=true",
            "in_lufs": -22.3, "lufs": -20.00, "tp": -3.50, "lra": 6.50,
            "md5": "85806ec71afbe1ea6d2471af6620980b" }
  }
}
```
Field notes:
- **Top level** — `source` is the lossless master spec (bit depth / sample rate /
  container, from the Phase 1 ffprobe; render as a header line since it's usually
  uniform). `filters` is the Phase 2 chain of the *most recent run*. `workflow_version`
  / `ffmpeg` / `date` record that last run's context — but they are **only a summary**;
  the per-track `ver`/`chain` below are the authoritative record for a show whose
  tracks were processed across different workflow generations.
- **Per track** (keys are track-number strings):
  - `ver` — the **workflow version** that produced this track (see the
    `WORKFLOW_VERSIONS` registry in `scripts/audio_process.py`; decode it with
    `audio_process.py versions`). Bump `WORKFLOW_VERSION` whenever processing
    functionality changes and add a registry entry describing it.
  - `chain` — the **literal ffmpeg process chain applied to this specific track**
    (filters + the loudnorm step), e.g.
    `"afftdn=nr=12:nf=-45,loudnorm=I=-20:LRA=11:TP=-1:linear=true"` for a track that
    later got a noise-floor pass. This is the self-contained ground truth of exactly
    what was done to the track — readable without any version lookup.
  - `in_lufs` — input integrated LUFS (Phase 1, *before* processing).
  - `lufs` / `tp` / `lra` — **achieved** values from the Pass 3 re-measure of the
    output (not assumptions). `build.py` shows `In LUFS`, `Out LUFS`, and a derived
    `Gain` column, plus `True Pk` and `LRA`.
  - `plr` (workflow v6+) — true peak minus integrated loudness (peak-to-loudness
    ratio). `max_m` / `max_s` — the peak momentary (400 ms window) / short-term
    (3 s window) loudness from a single `ebur128` pass. Two tracks can share the
    same integrated LUFS while one has a much hotter chorus the average smooths
    over — `plr`/`max_m`/`max_s` are what actually predict "sounds louder in a
    playlist," which `lufs` alone can't.
  - `md5` — audio fingerprint of the processed FLAC for integrity / Drive↔R2 drift
    checks, and the **proof of which version's output is live**. Capture it
    (container-uniform, works for WAV too) with:
    ```
    ffmpeg -i "NN Title.flac" -map 0:a -f md5 -    # prints MD5=<hex>
    ```
    Stored only; **not displayed** — it's data to diff later, not a column.
- **Merge, don't overwrite.** Each `process` run loads the existing sidecar and
  updates only the tracks it touched, preserving the rest. This is what lets one
  show hold a mix of versions — e.g. re-running a single track later on a newer
  workflow updates *its* `ver`/`chain`/`md5` and leaves the other tracks' v1 records
  intact. The engine does this automatically.
- **Tracking what's been processed and with what.** The presence of a track entry =
  that track has been through the engine; its `ver` = which generation; its `chain` =
  the exact processes. `audio_process.py history <slug> [--chains]` prints this
  per-track (and a version tally) for a show; `audio_process.py versions` describes
  what each version did. A track-listed show with *no* sidecar (or missing track
  entries) is one that still needs processing.
- **Archive-wide version view (across all shows at once).**
  `audio_process.py version-map` lists every show with a sidecar, its per-track
  version tally, and flags any show whose tracks span more than one version
  (`⚠ MIXED`) — the case `history` can't show you because it only looks at one
  show at a time. `--only-mixed` filters to just those; `--version N` lists
  every track archive-wide still on version `N` (e.g. `--version 1` to find
  every track-listed-show that predates the v4 silent-fallback fix, as
  reprocessing candidates). A show being "mixed" is not a bug — it's the
  normal, expected shape after a partial re-run — but it's the thing to check
  before deciding a show is fully caught up to the current engine.
  For a browsable, filterable equivalent (by version, treatment mode, damage
  flag, artist, or free text) rather than a CLI listing, see the unlisted
  `/archive-data/` page — every track in the archive with its full spec/
  provenance data, built from `assets/track-spec.json`
  (`build_track_spec_catalog()` in `scripts/sitegen/feeds.py`), not linked
  from the nav (bookmark it directly; linked from `/manual/` and `/search/`).
- **Per-show status, persisted.** `audio_process.py status` reports every show's
  `processing_status` computed from the sidecars; `status --write` persists it into
  `recordings.json` (per show) plus a per-track `processed: true` flag. **Run
  `status --write` after every publish** so the data stays current (it's idempotent
  and drift-free — recomputed from the sidecars each time, never hand-edited).
  Statuses: `done` (all tracks have a sidecar entry) · `partial` (some do) ·
  `needs-processing` (none yet — this includes the whole-show-only shows, which have
  no split tracks for the engine to act on, so they need splitting first) · `redo`
  (normalized off the books — old manual pass at the wrong target, no provenance;
  listed in `REDO_SLUGS`, sticky until a real sidecar exists, then auto-upgrades).
- On a partial pass, only the tracks you processed are written/updated — `build.py`
  shows `—` for the loudness columns of untouched tracks while still listing their
  time/size.
- It's a build *source* (`data/` is `.assetsignore`'d → not served); the data
  reaches the browser only via the rendered HTML.

---

### Path A — Re-processing a show already on the site (manual/legacy route — see the note above)

1. **Upload + refresh metadata in one step.** `update_tracks.py` matches your
   processed files to the show's existing tracks by leading number, overwrites the
   matching MP3/FLAC keys in R2, and refreshes each track's `size_mb`/`duration`
   in `recordings.json`. It does **not** touch the provenance sidecar.
   ```
   python3 scripts/update_tracks.py <slug> ~/work/<slug>/processed
   ```
   Partial sets are fine — only tracks present in the folder are touched.
   **The R2 stream URL is not `Cache-Control: no-store`** — the Worker sets
   `public, max-age=31536000, immutable` when the URL carries a `v=`
   cache-buster (the provenance sidecar's MD5 prefix, appended by `build.py`
   from `data/processing/<slug>.json`), or a 1-hour TTL when it doesn't. The
   new audio only becomes reachable at a *new* URL once you've updated the
   provenance sidecar's `md5` for the changed tracks (see above) and rebuilt
   — do that before calling the upload "live," not just the R2 copy finishing.

2. **Regenerate waveform peaks** (the waveform changed):
   ```
   python3 scripts/gen_peaks.py --slug <slug>
   ```

3. **Add a manual Updates note.** The show's `added` date is old, so nothing is
   auto-generated. Add one entry to the top-level `updates` array in
   `data/recordings.json`:
   ```json
   { "date": "YYYY-MM-DD", "ts": "YYYY-MM-DDTHH:MM:SS", "slug": "<slug>",
     "report": true,
     "text": "Re-normalized all tracks to −20 LUFS for a more even, comfortable listening level, using the automated audio engineering workflow with ffmpeg" }
   ```
   - State the **actual target** used and name the tracks if it was a partial pass
     (don't say "all tracks" unless it was). End workflow-generated notes with
     "…using the automated audio engineering workflow with ffmpeg" so they're
     filterable from hand-written ones.
   - `"report": true` makes `updates_list()` append a **"view data"** link that
     deep-links to the show's `#technical-data` table (and auto-opens it).
   - Alternatively use `make edit` → the show's "Update note" field for the text.
   - **Do not** rely on auto-generation here — that only fires for newly-added shows.

4. **Rebuild, commit, deploy:**
   ```
   python3 scripts/build.py
   git add -A && git commit -m "Re-normalize <slug> tracks to {target} LUFS" && git push
   ```
   Pushing `main` deploys via the GitHub Action (`npx wrangler deploy` of the
   `renedebos-site` Worker).

---

### Path B — Adding a new show (manual/legacy route — see the note above)

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

4. **Do NOT add a manual Updates entry.** `stamp_added_dates()`
   (`scripts/sitegen/core.py`, run by `build.py`) auto-stamps `added`/`added_ts`
   for any show that has tracks but no `added`, and `updates_list()`
   (`scripts/sitegen/fragments.py`) then auto-generates an "Added … N split
   tracks" feed event. A manual entry on top would duplicate it. (The auto
   "Added" event has no "view
   data" link, but the **Technical data** table still renders on the show page from
   the `data/processing/<slug>.json` you wrote above — reachable directly there.)

5. **Generate peaks, rebuild, commit, deploy:**
   ```
   python3 scripts/gen_peaks.py --slug <slug>
   python3 scripts/build.py
   git add -A && git commit -m "Add <slug> (N split tracks)" && git push
   ```

---

### Mirror to the Drive archive (both paths)
Publishing puts the processed files on R2 (the live site) but leaves Google Drive
holding the originals, so the site and the Drive archive drift apart. Push the
processed files back to Drive so the archive stays in sync — into a **`Processed/`
subfolder alongside `Tracks/`, never overwriting the originals**:
```
rclone copy ~/work/<slug>/processed \
  "gdrive:DAT Tapes/Work Folder/<show>/Processed" --progress
```
- This keeps both: `Tracks/` = un-normalized masters, `Processed/` = the
  normalized versions that match R2. (The provenance `md5` lets you later confirm
  the Drive `Processed/` copy and the R2 copy are byte-identical audio:
  `ffmpeg -i <file> -map 0:a -f md5 -`.)
- Skip the `processing_report.txt` if you don't want it in the archive
  (`--exclude "*.txt"`), or leave it for a self-documenting folder.
- **Gotcha:** write through the `gdrive:` remote as above. Do **not** drop files
  into `~/gdrive-mount` expecting them to sync — that path is a stale *local copy*,
  not a live mount, so files left there never reach real Drive.
- Run this **before** the local cleanup that removes `~/work/<slug>/`.

### Post-publish check
- Confirm the show page renders tracks with waveforms and the Updates page shows
  the expected (auto or manual) entry.
- Confirm the processed files landed in the Drive `Processed/` subfolder and the
  originals in `Tracks/` are untouched.
- Confirm the **Technical data** table renders on the show page with the right
  LUFS/peak values, and (Path A) that the Updates "view data" link opens it.
- **Verify upload integrity:** `python3 scripts/audio_process.py verify <slug>`
  re-reads each published R2 copy, recomputes its audio MD5, and confirms it
  matches the provenance sidecar (exits non-zero on any mismatch).
- **Refresh the status flags:** `python3 scripts/audio_process.py status --write`
  recomputes `processing_status` (per show) and `processed` (per track) in
  `recordings.json` from the sidecars, then rebuild/commit so the data reflects the
  new work. A freshly-published show should flip to `done` (or `partial`).
- **Update the History page** (`build_history()` in `scripts/sitegen/pages.py`). It's a
  hand-written, visitor-facing narrative organized by week — NOT auto-generated. Add
  each newly processed/re-mastered show into the current `<h2>Week …</h2>` section
  (or start a new dated week as time moves on), in the same plain-language voice
  (no jargon dumps). This is a standing request from the user: extend the History as
  shows are processed.
- Spot-check one track streams and that the FLAC download is gated while the MP3
  is free.
