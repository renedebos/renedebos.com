# Archive-wide hum & hiss detection

Status: **planned, not started.** Parked 2026-08-23 at Rene's request
("table the hum detecting process for now, revisit later"). Everything below
was measured in that session, not estimated — the numbers are the reason this
is cheap, so don't re-derive them.

## 1. The question this answers

Nobody knows which shows carry **mains hum** (a steady 60 Hz buzz from a bad
ground at the venue) or how much **hiss** (mic/preamp/room noise) each track
has. A read-only screen over all 680 curated tracks produces a ranked list.

Secondary win: it **verifies the noise reduction Rene already hand-applied**
in Audacity actually made those shows quieter, which nothing checks today.

Note on vocabulary: these are **DAT-sourced**, so "tape hiss" is not tape.
It is mic self-noise, preamp noise, room and audience — which matters because
it is not the flat, programme-independent spectrum a denoiser's noise-profile
model assumes.

## 2. Method (validated, with a positive control)

**Hum.** A narrow 2 Hz `bandpass` centred on each candidate frequency, then
`astats` RMS. **Compare against the shoulders (±3–6 Hz), never the absolute
level** — bass guitar and kick drum make absolute low-frequency energy
meaningless. Music spreads smoothly across neighbouring bands; hum is a
needle in one.

Verified on `01 Model Family Man.flac` (19 Broadway 1999-07-19):

| | 54 Hz | 57 Hz | **60 Hz** | 63 Hz | 66 Hz |
|---|---|---|---|---|---|
| clean | −66.57 | −65.34 | **−64.76** | −64.78 | −64.77 |

Flat — that track has no hum. Then a **positive control**, because a detector
that has never fired has not been tested:

| | 60 Hz band | |
|---|---|---|
| clean | −64.76 | flat with shoulders |
| + 60 Hz tone @ −56 dBFS (30 dB below programme) | **−58.01** | fires, +6.75 dB |
| …after a 2 Hz `bandreject` | −66.24 | removed |
| + 60 Hz tone @ −71 dBFS (45 dB below programme) | −64.29 | **+0.5 dB — below reliable detection** |

**Honest limit: this is a smoke alarm, not a diagnosis.** It catches hum at a
level worth caring about and may stay quiet about hum nobody would hear.

**Hiss.** High-band RMS in quiet windows. Measured on the same track (avg /
quietest): 2–4 kHz −36.6/−58.2 · 4–8 kHz −40.5/−63.7 · 8–16 kHz −47.0/−71.3.

## 3. Three gotchas that cost time — do not rediscover them

- **`astats`' own "Noise floor dB" is useless here.** It read −108.6 dB on a
  real track: that is the digital silence inside a hand-drawn fade, not room
  noise. Measure a high-passed band in quiet *musical* windows instead.
- **lavfi's `sine` source is not full scale** — it peaks at −18.06 dBFS
  (RMS −21.07). Scale test tones against that or the positive control is
  18 dB weaker than intended. This produced one wrong intermediate result
  ("injection didn't register") before it was caught.
- **A 2 Hz `bandpass` needs ~2 s to settle.** Stats taken from t=0 measure
  the filter, not the audio. `atrim=start=2` after the filter.

## 4. The performance trick (14× — do not skip it)

Do **not** decode each track once per frequency. One decode feeds every band
through a split filtergraph:

```
[0:a]asplit=N[b0]…[bN-1];
[b0]bandpass=f=…:width_type=h:w=2,astats=measure_perchannel=none,anullsink;
… ;
[bN-1]bandpass=…,astats=…[out]          # ffmpeg refuses a graph with zero outputs —
                                        # leave the last branch mapped to -f null -
```

Verified to return values **identical** to the slow per-band method. Parse by
the `[Parsed_astats_N]` index, which increments by 3 per branch and is
deterministic.

## 5. Measured cost

| | |
|---|---|
| Archive | 680 tracks, **39.8 h** of audio, 25.1 GB FLAC |
| Scan speed | **27.5× realtime** (a 215 s track in 7.8 s, 25 bands) |
| Compute, 1 core | ~1.5 h |
| Compute, 8 cores (~5 jobs) | **~20 min** |
| R2 download | 8.2 MB/s single stream → ~50 min sequential, overlaps compute |
| **Realistic total** | **30–60 min** |

Disk is no longer a constraint (36 GB free as of 2026-08-23), but
fetch → analyse → delete per track is still the right shape: peak footprint a
few hundred MB, and it makes the run resumable.

## 6. Build notes

- Standalone **resumable** script writing JSONL incrementally, skipping
  tracks already done, so a stop costs one track.
- **Do not run it as an agent background task.** One died on 2026-08-23 when
  the session ended, leaving no output. For unattended runs it must be
  launched with `nohup` from Rene's own terminal.
- Drive the track list from `recordings.json` (`--files-from` discipline),
  **never** `rclone lsf` over the R2 prefix — the archive holds orphaned
  duplicates under superseded filenames.

## 7. What this does NOT do

It **changes no audio**. It reads and reports. Fixing is a separate decision,
and the two noises are different risk classes:

- **Hum removal is nearly free.** One pitch, one notch. Measured collateral:
  applying the 2 Hz notch to a clean track and nulling against the original
  left a residual at −64.76 dB RMS — **38 dB below programme**. Inaudible.
- **Hiss removal is not.** It is smeared across the same frequencies as the
  music, so any removal takes music with it. This is exactly why it has
  stayed Rene's hand-work in Audacity (`Tracks Noise Reduction/`, settings in
  `notes.txt` → `pre_edits`) and must not become automated on a "sounds fine"
  A/B. See **Loudness policy** in CLAUDE.md: the measurement is the guardrail,
  the ear is the veto, not the licence. Pre-NR exports are archived on Drive
  (`Tracks (pre-NR archive)/`), so experiments are reversible, and
  `scripts/ab_compare.py` already exists for the listening test —
  loudness-matched, MP3, both sides re-encoded identically, with null **and**
  positive controls.

## 8. essentia

Genuinely better for this — `HumDetector`, `SNR`, `NoiseBurstDetector`,
`ClickDetector`, `GapsDetector` are purpose-built, and `HumDetector` would
find the −71 dBFS case this method misses, with start/end times.

**Not installable here as things stand:** no `pip` on the box, and system
Python is 3.13, past essentia's last manylinux wheels (cp38–cp311). It would
mean a 3.11 venv or a source build. **`librosa` + `numpy` would get ~90% of
the detection value for a fraction of the install pain** — a real FFT and
percentile statistics is most of what the ffmpeg-only method lacks.
