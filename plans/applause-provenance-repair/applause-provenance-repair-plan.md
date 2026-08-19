# Applause-limiter provenance repair: scoped proposal

Status: **not started.** Written 2026-08-18, immediately after the *code* half
of this defect was fixed and shipped (`1035c7e`, "Prove the applause render's
chain instead of inferring it"). That commit stops the archive producing any
more bad records. This document covers the other half: **the records already
written are still wrong, and nobody has measured how many.**

Nothing here is urgent. No audio is affected. Read §4 before deciding to do it
at all.

## 1. What is already fixed, and what is not

**Fixed (shipped).** When a publish *resumed* over an existing
applause-limiter render, it did not know what gain had produced those bytes,
so it inferred one — `round(out_I - in_I, 2)` — and wrote that into the
provenance `chain`. For a limiter track that subtraction is systematically
wrong: the limiter has already pulled the applause transients down, so output
loudness is not input + gain, and the inferred figure understates the gain
actually applied. `audio_process.py` now persists the real gain/limit in a
`.v8state.json` beside the output (the file the transient cap already used,
now carrying a `"mode"` key) and refuses to resume without it.

**Not fixed.** Every applause chain written by a resume *before* that commit
is still an estimate sitting in `data/processing/<slug>.json`, and is surfaced
publicly on `/archive-data/`. The recorded chain does not reproduce the bytes
it claims to describe.

**The one measured case**, `jerry-19-broadway-1999-10-25` track 14 ("Johnny
McEldoo"):

| | value |
|---|---|
| what the sidecar records | `volume=2.65dB` |
| what the render actually applied | `2.67 dB` |
| how 2.65 arose | `round(-20.35 - -23.0, 2)` — the old inference, exactly |

Track 20 of the same show has the same shape. That the old formula reproduces
the wrong number *on its own* is what confirms the diagnosis rather than
merely matching it.

## 2. Scope: 42 tracks across 16 shows

Every track in applause-limiter mode. Regenerate with:

```bash
python3 - <<'EOF'
import json, glob, os
for p in sorted(glob.glob('data/processing/*.json')):
    n = [k for k, t in json.load(open(p))['tracks'].items()
         if t.get('mode') == 'applause-limiter']
    if n: print(os.path.basename(p)[:-5], sorted(n, key=int))
EOF
```

As of 2026-08-18:

| show | tracks |
|---|---|
| `jerry-19-broadway-1999-02-01` | 15 |
| `jerry-19-broadway-1999-03-29` | 15, 24, 27, 30, 34 |
| `jerry-19-broadway-1999-06-07` | 27 |
| `jerry-19-broadway-1999-07-19` | 9, 23 |
| `jerry-19-broadway-1999-08-23` | 3 |
| `jerry-19-broadway-1999-10-25` | 14, 20 |
| `jerry-19-broadway-2001-01-08` | 23, 28 |
| `jerry-19-broadway-2001-01-15` | 30 |
| `jerry-cafe-java-1999-03-25` | 2, 4, 5, 13, 17 |
| `mad-cafe-java-1999-09-09` | 8, 16 |
| `mad-marin-brewing-co-1998-04-01` | 7 |
| `mad-sweetwater-1999-05-18` | 18 |
| `sean-19-broadway-1999-11-29` | 18, 21 |
| `sean-19-broadway-2000-01-24` | 5, 10, 16, 28, 29, 31 |
| `sean-19-broadway-unknown` | 2, 13 |
| `seanjerry-19-broadway-1999-12` | 3, 5, 6, 9, 16, 17, 18, 30 |

**42 is the upper bound, not the count of bad records.** The bad chain is
written only on a *resume*; a track rendered once, cleanly, recorded its true
gain. The real number could be 5 or 35. **Sizing that is step 1 and is most of
the value in this document.**

## 3. Method

### Step 1 — scope it cheaply (do this before anything else, ~20 min)

The detection recipe is the one the 1999-10-25 audit already proved (see
HANDOFF.md, "Reusable audit"): **re-render locally from the staged source with
the sidecar's recorded `chain`, on the same ffmpeg build, and compare decoded
md5 against the sidecar's `md5`.** A match proves the chain is a real recipe; a
mismatch is an inferred gain.

Run it first on whatever is **already staged locally** — no download, no cost.
If `~/work/jerry-19-broadway-1999-10-25/tracks/` still exists, that is tracks
14 and 20 for free, and they are already known-bad, so they serve as the
positive control that the detection works.

Then pick **one** other show, pull just its applause tracks from Drive with
`--files-from` (never `rclone lsf` — see CLAUDE.md on orphaned duplicates), and
measure. The mismatch fraction across those two shows is the number that
decides §4.

### Step 2 — repair, only if step 1 justifies it

Per affected track: re-render from the source, read the true gain off the fresh
render's `.v8state.json`, and patch `chain` (and `applause_limiter.gain_db`) in
`data/processing/<slug>.json`. Then `python3 scripts/build.py` and confirm
`/archive-data/` shows the corrected figures.

**Do not re-upload any audio.** The published FLAC/MP3 are correct and
unchanged — this repairs the *description* of how they were made. Re-uploading
would be a pointless 42-track R2 write and would churn `MP3-14/` derivation
proofs for no reason.

**Do not run `publish_show.py prepare`** against these shows to obtain sources.
`prepare` hard-deletes `~/work/<slug>/tracks/` — it destroyed Rene's fade-edit
work on 2026-08-11. Pull the specific files with `rclone` directly.

### Step 3 — record it

A single `updates` note covering the batch, plain and factual: the recorded
gain on N tracks was an estimate rather than the gain actually applied, the
audio was never affected, the records now match the files.

## 4. Cost, and the honest case against doing it

**Estimated ~1.5–2 h wall clock** for the full 42, mostly unattended:

| | |
|---|---|
| download ~2 GB of sources from Drive | 15–40 min (dominates) |
| re-render 42 tracks (~2 min each, ~5-way parallel) | ~20 min |
| patch sidecars, rebuild, verify | ~15 min |

Step 1 alone is ~20 min and needs almost no download.

**The case against:** the error measured so far is **0.02 dB**. No audio
changes. Nothing a listener can hear, and nothing that affects a download. The
only thing it buys is that `/archive-data/` stops publishing a gain that does
not reproduce the file.

**The case for:** this project's own stated rule is *"provenance must never
describe a chain it merely guesses"* (`audio_process.py`, the transient-cap
resume path). The archive's value is that its records are true. A figure that
is quietly an estimate is worse than a missing one, because nothing marks it.

**Recommendation:** do step 1 whenever there is a spare 20 minutes. Let the
mismatch count decide step 2. If it comes back small, consider annotating the
affected tracks rather than re-rendering them.

## 5. Traps

- **`~/work/_applause_test` is gone** (deleted 2026-08-18 in the disk cleanup).
  It was the −20 regression fixture for the applause-precedence change. Build
  fixtures from a staged show's `tracks/` instead.
- **Keep `~/work/jerry-19-broadway-1999-10-25/` until step 1 is done** — it is
  the only staged source left, and it holds both known-bad tracks.
- **The ffmpeg build must match** the one in the sidecar's `ffmpeg` field, or a
  byte-comparison proves nothing. 1999-10-25 was rendered on `7.1.3-0+deb13u1`.
- **`--slug` merges into `data/processing/<slug>.json`.** For any experimental
  render, pass `--provenance-out` to a scratch path or use a throwaway slug, or
  the test overwrites the very records being repaired.
- **An empty result is not evidence of absence** (CLAUDE.md). Sanity-check any
  "no mismatches found" against track 14, which is known bad.
