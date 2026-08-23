# How an archive track is processed — the exact commands

Written 2026-08-22 for an outside analyst (Codex) asking what has been done to
a published archive file before it analyses one. Everything below is read out
of the engine source, not from prose: `scripts/audio_process.py` plus
`scripts/engine_{analysis,planning,rendering,constants,catalog}.py`. Where a
number appears it is the literal constant the code uses.

**Short version for an analyst:** a published archive track is the
hand-edited studio export with **one constant gain applied by ffmpeg's
`volume` filter**, encoded to FLAC. No compression, no EQ, no loudnorm at
render time, no resampling, no bit-depth change.

**But check the track before assuming that.** 62% of the archive is that
plain path; the other **38% also went through a peak limiter** — 32%
transient-capped, 6% applause-limited (census in §3). Per-track provenance
settles it: `mode` names the path and **`chain` is the literal ffmpeg filter
string that produced the file**. If `chain` is a bare `volume=…`, nothing
dynamic touched it.

---

## 1. What the input is

The source is **not** a raw tape transfer. It is a per-song WAV/FLAC exported
from Audacity by hand, from the show's Work Folder:

- `Tracks/` — normal case: song splits with hand-drawn fades and clip fixes.
- `Tracks Noise Reduction/` — when whole-show noise reduction was applied
  first. The two are mutually exclusive; both populated is a hard error.

Hand edits made **before** the engine ever sees the file are recorded as
free text in the provenance's `source`/`pre_edits` (from a `notes.txt` in the
tracks folder, e.g. noise-reduction settings). The engine does not know what
they were beyond that string.

The whole-show WAV and the Audacity `labels.txt` are kept as the raw archive;
the engine is never run on them directly.

## 2. Measurement (never the render)

Every decision starts with one ffmpeg analysis pass:

```
ffmpeg -hide_banner -i <src> \
  -af "loudnorm=I=-20:LRA=11:TP=-1.0:print_format=json" \
  -f null -
```

The JSON block is parsed for `input_i` (integrated LUFS), `input_tp` (true
peak), `input_lra`. A second pass collects the momentary/short-term maxima:

```
ffmpeg -hide_banner -i <src> -af ebur128 -f null -
```

**`loudnorm` is used only to measure.** It is never in a render command. The
reason is specific: ffmpeg's `loudnorm` applies true linear gain only while
the required gain keeps true peak under the ceiling, and otherwise silently
falls back to frame-adaptive (dynamic) normalization with no warning at
`-loglevel error`. That fallback would flatten hand-drawn fades. Since
workflow v6 the render is a plain `volume` multiply, for which no such
fallback exists.

## 3. The decision

From the measurement:

```
pred   = input_tp + (target - input_i)      # true peak after a full-target gain
maxlin = input_i - input_tp + (-1.0)        # the track's own max linear target
```

with `target = -20` for every artist (`ARTIST_TARGET`, all four map to −20)
and the true-peak ceiling `TP_CEILING = -1.0` dBTP.

| condition | mode | what happens |
|---|---|---|
| `pred <= -1.0` | **`linear`** | one constant gain to −20 LUFS |
| `pred` overshoots | **`linear-reduced`** | one constant gain to `maxlin` — quieter than −20, dynamics untouched |
| applause at a split boundary sets the peak | **`applause-limiter`** | opt-in-free, v5; see §5 |
| brief musical transients set the peak | **`sparse-transient-cap`** | **opt-in only** (`--transient-cap`); see §5 |

### How common each is — counted across all 680 archive tracks (2026-08-22)

| mode | tracks | share |
|---|---|---|
| `linear` | 313 | 46% |
| **`sparse-transient-cap`** | **215** | **32%** |
| `linear-reduced` | 110 | 16% |
| `applause-limiter` | 42 | 6% |

**Do not assume a given archive track is untouched by a limiter.** The
transient cap is opt-in *per show*, but it has in practice been opted into
for most shows since 2026-08-08, so roughly a third of the archive has been
through it. Check `mode` on the specific track.

`linear` and `linear-reduced` (62% together) are the paths where the music is
multiplied by a single scalar and nothing else is done to it.

Workflow version, same census: **v8** 547 tracks, **v7** 110, **v6** 23.
Versions differ in how the gain was decided, not in the fact that the render
is a `volume` multiply — that has held since v6. Anything older has been
re-rendered.

## 4. The render — common path

```
ffmpeg -hide_banner -loglevel error -y -i <src> \
  -af "volume=<G>dB:precision=double" \
  -ar <source sample rate> \
  <codec args> <metadata args> <out.flac>
```

where `G = round(plan_target - input_i, 2)`.

- **Sample rate is preserved** (`-ar` is the source's own rate). No
  resampling on this path.
- **Bit depth is preserved** — `output_codec()`: 16-bit → `-c:a flac
  -sample_fmt s16`; 24-bit → `-c:a flac -sample_fmt s32
  -bits_per_raw_sample 24`; otherwise `-sample_fmt s32`.
- No filter precedes `volume` unless a corrective filter was explicitly
  requested for that run (`--eq`, `--hpf`, `--lpf`, `--notch`). **These are
  off by default** and their use is recorded in the sidecar's `filters`. If
  present they are prepended to the chain, and the measurement in §2 is taken
  *through* them so the gain stays correct.

Then the output is measured again (same `loudnorm` command) and the achieved
`lufs`/`tp`/`lra` are recorded. A warning fires if LUFS drifts more than
`LUFS_TOL = 0.5` dB or TP exceeds the ceiling by more than `TP_TOL = 0.1` dB.

### The MP3 proxy

The published MP3 is encoded **from the finished FLAC**, not from the source:

```
ffmpeg -hide_banner -loglevel error -y -i <out.flac> \
  [-af "volume=<trim>dB:precision=double"] \
  -b:a 320k -id3v2_version 3 <metadata args> <out.mp3>
```

`trim` is normally absent. Lossy encoding can reconstruct inter-sample peaks
above the FLAC's true peak, so the MP3 is measured after encoding and, if it
would clip on decode, a small **MP3-only** gain trim is applied and it is
re-encoded (up to 3 attempts). **The FLAC master's gain is never touched for
this.**

Note for an analyst: the trim, when it happens, is **not recorded** in
provenance — there is no field for it. `mp3_tp` is the measured true peak of
the shipped MP3, so an MP3 whose level sits slightly below the FLAC's implied
level has been trimmed. If you want the untrimmed, authoritative signal, use
the FLAC.

## 5. The two limiter modes (know whether you are looking at one)

Both are visible in provenance: `mode` names them and `chain` is the literal
filter string used.

**`applause-limiter` (v5).** For audience tapes where a clap at a split
boundary out-peaks the music, forcing the whole track quieter than the
*music* ever needed. Only edge windows (within `min(30 s, dur/6)` of head or
tail) can qualify, and only on a crest signature (peak ≥ 27 dB over window
RMS) or an edge peak ≥ 2 dB above the loudest body window. The gain is sized
so the limiter **cannot engage on anything classified as music**:

```
volume=<G>dB,alimiter=limit=<amp>:attack=5:release=100:level=false:latency=1
```

**`sparse-transient-cap` (v8, `--transient-cap`, never default).** A
millisecond-scale true-peak cap on isolated musical transients (close-miked
drum hits). Runs the limiter at 4× the source rate so inter-sample peaks
become real samples:

```
volume=<G>dB:precision=double,aresample=<sr*4>,
alimiter=limit=<amp>:attack=1:release=50:level=false:latency=1,
aresample=<sr>
```

Gated on engagement, not loudness: auto only at ≤ 2% near-peak density, ≤ 1%
engagement, ≤ 0.2 s longest event; a review band up to 5% / 2% / 0.5 s that
is hard-blocked until a human has listened; beyond that it declines. The
limiter's actual instantaneous attenuation is hard-capped at **6 dB**. A
post-render true-peak assertion against a strict −1.00 dBTP **deletes the
output and aborts** rather than shipping.

## 6. What is never done

- No compression, no EQ, no de-noising, no de-clicking by this engine. Any
  such treatment happened by hand in Audacity beforehand and is described
  only by the free-text `pre_edits`.
- No `loudnorm` at render time, hence no frame-adaptive gain (see §2).
- No resampling and no bit-depth change on the common path.
- No normalisation to a peak target — the target is loudness (LUFS), with
  true peak only as a ceiling.

## 7. Reading the provenance for a specific track

`data/processing/<show-slug>.json`. Top level: `target_lufs`, `tp_ceiling`,
`source`, `filters`, `workflow_version`, `ffmpeg` (the exact binary version),
`date`. Then `tracks` keyed by track number. A real entry:

```json
{
  "ver": 8,
  "chain": "volume=0.38dB:precision=double",
  "in_lufs": -20.6,
  "lufs": -20.27,
  "tp": -1.0,
  "mp3_tp": -0.98,
  "max_m": -12.6,
  "max_s": -15.7,
  "lra": 9.0,
  "plr": 19.27,
  "md5": "defaef483394eca794d9bf4ee98d1ba7",
  "mp3_md5": "7e773b7651cdf1b80b9c56fc882ee9d4",
  "src_md5": "00939febb2a27cfa4b575c36b3eb57ee",
  "target_lufs": -20.27,
  "mode": "linear-reduced",
  "note": "gain to -20 LUFS would overshoot the TP ceiling by 0.3 dB — small enough to simply take the track's own max linear target; dynamics untouched"
}
```

- **`chain`** is the ground truth — the literal `-af` string. If it is a bare
  `volume=…`, nothing dynamic touched that track.
- **`in_lufs` → `lufs`** is the whole transformation on the common path.
- **`md5`** is the *decoded audio* md5 of the published FLAC
  (`ffmpeg -i … -map 0:a -f md5 -`), not the file hash — comparable across
  containers.
- **`ver`** is the workflow version that rendered it; see
  `engine_versioning.py` for what each version changed. `python3
  scripts/audio_process.py version-map` reports versions across the archive.

## 8. The −14 variant is a different file

`MP3-14/` holds a second, louder render of every curated track at −14 LUFS.
It is **derived from the published −20 FLAC**, never re-staged from the
source, and its provenance lives separately in
`data/processing/variants/loud-14/<slug>.json`. It is heavily transient-capped
(673 of 680 tracks) and is **not** the archive. If you are analysing what was
done to the archive, use the FLAC. Metadata comment on every file states which
target it was normalised to.

## 9. Metadata written into every output

```
-metadata title=…  -metadata artist=…  -metadata album_artist=…
-metadata album=…  -metadata track=<n>/<total>  -metadata date=<year>
-metadata comment="The Hannan Tapes (renedebos.com) — loudness-normalized to <N> LUFS"
```

The `comment` is the quickest in-file check of which target a given file was
rendered to.

---

## Log — 2026-08-22 23:00 PDT — "Black Is The Color", and why §5 is not optional reading

Codex, having read §1–§4 above, proposed a conditional:

> If its chain is just something like `volume=XdB:precision=double`, then the
> FFmpeg stage cannot have introduced dynamic compression or limiter
> distortion. Every sample was simply multiplied by the same constant. In
> that case, any roughness/distortion we're hearing was already present in
> the Audacity-exported source (or earlier) […] For a bare-volume track, the
> last question is essentially eliminated.

The reasoning is right. **The premise does not hold for this track**, which
is exactly why the per-track check matters more than the engine's general
design.

**Track: `jerry-19-broadway-2001-01-08`, track 02, "Black Is The Color"**
(the only track 02 of that title in the archive; nine other performances
exist at other positions).

```json
"mode":  "sparse-transient-cap",
"chain": "volume=7.73dB:precision=double,aresample=192000,
          alimiter=limit=0.841395:attack=1:release=50:level=false:latency=1,
          aresample=48000",
"in_lufs": -27.7,  "lufs": -20.03,
"tp": -1.5,        "mp3_tp": -1.44,
"lra": 14.2,       "plr": 18.53,
"max_m": -10.2,    "max_s": -13.1,
"md5": "81c1493369678d01fed63f204beaf9dc",
"transient_cap": {
  "gain_db": 7.73, "limit_db": -1.5,
  "gr_db": 2.06,   "p95_gr_db": 1.69,
  "engaged_pct": 0.34, "events": 6, "longest_s": 0.2,
  "near_peak_pct": 0.7, "in_lra": 14.2
}
```

A limiter **did** run, so "did archive processing introduce artifacts" is not
eliminated here. What the record bounds it to: **2.06 dB** maximum
instantaneous attenuation, engaged for **0.34%** of the track — about 0.65 s
of 3:13 — across **6 discrete events**, longest **0.20 s**.

Three readings worth keeping:

- **`in_lra` 14.2 → `lra` 14.2.** The loudness range is unchanged. That is
  the strongest single indicator the dynamics survived the cap.
- **The repeated peaks at −1.50 dBFS are the limiter's threshold, not a
  coincidence.** `TCAP_LIMIT_DB = -1.5`, deliberately 0.5 dB under the
  archive's −1.0 dBTP ceiling because downsampling from 4× reconstructs some
  overshoot. An analyst seeing a flat ceiling at exactly −1.50 on a v8 track
  is seeing the engine, not the tape.
- **+7.73 dB of gain was applied** (source measured −27.7 LUFS). Any
  pre-existing overload is 7.7 dB louder in the published file than it was on
  the source. A quiet source is not a clean one.

**Show context:** soundboard, 24-bit/48 kHz FLAC, `filters: none`, ffmpeg
7.1.3, workflow v8. Not an audience tape. Of its 30 tracks, 17 are capped and
the shave runs 1.69 dB to **8.65 dB** (track 8); track 02's 2.06 dB is
second-lowest, so it is on the gentle end for this show.

### The general lesson, for whoever reads this next

**Do not generalise from the engine's design to a specific file.** §1–§4
describe what the engine does; only `mode` and `chain` in
`data/processing/<slug>.json` say what happened to *one track*. 38% of the
archive has been through a peak limiter (§3's census). Asking for the
provenance entry first, as Codex did, is the correct move — and the reason
this document leads with "check the track before assuming that".

### How to settle it rather than infer it

Two tools already exist, and between them they separate the three questions
Codex correctly identified (was the tape already distorted / did the Audacity
edits change it / did we):

- **`python3 scripts/split_raw.py "<work folder>"`** materialises the raw,
  unedited split of a song from the whole-show WAV plus the Audacity
  `labels.txt` — the signal *before* any hand editing. This answers the first
  question directly.
- **`python3 scripts/ab_compare.py <slug> <track>`** re-renders the track
  from its unprocessed source with the current engine and serves both synced
  at `http://127.0.0.1:8767/`, with a loudness-over-time chart and a
  params diff.

For this track the analysis Codex proposed — flat-topped or asymmetric
segments, harmonic generation at vocal peaks, crest-factor collapse, whether
distortion tracks amplitude — should be run against the **raw split**, not
the published FLAC. On the published file, six known limiter events sit in
the data and would have to be excluded by hand; on the raw split they do not
exist.
