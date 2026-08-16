---
name: publish-show
description: Publish a split show to the Hannan archive on renedebos.com — the prepare → diagnose-review → publish → metadata → build → ship runbook driven by scripts/publish_show.py. Use this whenever Rene asks to process, publish, upload, ship, or "do" a show or a show slug/date, when he asks to reprocess or re-render tracks under a newer workflow version, or when a show's hand-edited tracks are ready in a Drive Work Folder — even if he doesn't name the scripts or say the word "publish". Also use when troubleshooting a stuck or aborted prepare/publish run, a fingerprint mismatch, a title-drift flag, or a transient-cap (v8) decision.
---

# Publishing a split show

A show almost always **already exists** in `data/recordings.json` as a
whole-show entry (`tracks: null`, `processing_status: needs-processing`).
Publishing upgrades it to track-listed. Rene's hand-edited tracks (fades,
clip fixes, sometimes whole-show noise reduction) live in the show's Drive
Work Folder.

Two commands do nearly all the mechanical work. **Your value is the gates
between them**, not the typing — `prepare` and `publish` are deliberately
split so a human reads the diagnose before anything renders or uploads.

## The six steps

| # | Step | Who |
|---|---|---|
| 1 | `publish_show.py prepare <slug>` | mechanical |
| 2 | **Review the diagnose** | judgment — the real gate |
| 3 | `publish_show.py publish <slug>` | mechanical |
| 4 | `draft_tracks.py <slug>` + hand-written prose | mixed |
| 5 | `build.py` | mechanical, fails loudly |
| 6 | Commit, push, verify the deploy | mechanical + one real check |

### 1. Prepare

```bash
python3 scripts/publish_show.py prepare <slug>          # --folder "<name>" if the date search is ambiguous
```

Locates the Work Folder by show date, picks the tracks source, reads
`notes.txt` into the pre-edits provenance, copies tracks to
`~/work/<slug>/tracks/`, runs the full diagnose, and stops. Takes ~5–10 min
— run it in the background and poll for an end marker.

**`Tracks Noise Reduction/` wins over `Tracks/`. Both populated is a hard
error — never guess which one Rene meant.** State lands in
`~/work/<slug>/publish.json`.

Rene also exports Audacity labels as `labels.txt` at the Work Folder root.
That's the raw-archive split recipe — if it's missing, remind him, because
it can't be reconstructed later.

### 2. Review the diagnose — the only real judgment gate

Read `references/diagnose-verdicts.md` for what each verdict means and how
to act on it. In brief:

- **`CLIPPING` / `DROPOUT` / `BALANCE` / `PHASE`** hard-block the publish.
  These go back to Rene in Audacity. The per-finding override
  (`--accept-diagnostic 12:CLIPPING`) exists for findings a human reviewed
  and accepted — it is not a way to get past a verdict you'd rather not
  deal with.
- **`HIGH_LRA`** is informational. Very dynamic material, which is normal
  for this archive.
- **`PRED_TP` is not informational.** It drives the linear-normalization
  policy below; the engine handles it automatically, but understand what
  it's telling you.
- **`TITLE CHANGED`** needs cross-referencing *every* prior appearance of
  that title in the archive, not just the fresh filename, before you can
  tell a typo from a real correction.

If the answer is "keep the established spelling," fix it **before the first
publish call**:

```bash
python3 scripts/publish_show.py rename-track <slug> --track-num N --new-title "Correct Title"
```

Renaming by hand with `mv` leaves `publish.json`'s fingerprint pointing at
the old filename, so the next `publish` correctly aborts on a fingerprint
mismatch. `rename-track` updates the file, the manifest, and the fingerprint
in one step. Run it as soon as the call is made — not as recovery after a
failed publish, because a first publish under the wrong name still uploads
under that name and leaves a stray R2 object only a human can delete.

### 3. Publish

```bash
python3 scripts/publish_show.py publish <slug>
```

Loudness-normalizes to **−20 LUFS for all artists**, uploads FLAC+MP3 to R2,
generates peaks, verifies R2 MD5s against the provenance sidecar (aborts on
any mismatch), backs up to Drive `Processed/`, cleans up the local copy.
~30–40 min for ~35 tracks — background it.

Benign LUFS-drift warnings around 0.5 dB on very dynamic tracks are expected.
Don't reprocess for those.

Flags worth knowing:
- `--tracks 3,7,14` — scope to specific tracks on an already-prepared show.
  For a show where most tracks already sit at target under an older workflow
  version, this is the difference between touching 3 tracks and re-rendering
  all 30 for no audible benefit. Still needs a full `prepare` first.
- `--manual-drive-backup` — Rene copies to Drive by hand (often faster than
  rclone). **Opt-in; ask him each time**, don't assume.
- `--transient-cap` — see `references/transient-cap.md`. Per-show, Rene's
  call, never a default.
- `--eq` — corrective EQ for restoration shows only, not the default path.

### 4. Metadata

```bash
python3 scripts/draft_tracks.py <slug>
```

Drafts `tracks[]` with durations/sizes from the processed files and
songwriter+tags reused from the catalog. **New or ambiguous titles come back
FLAGGED** — resolve them: originals → "Jerry Hannan & Sean Hannan", covers →
the actual writer, trad → "Traditional", genuinely unknown → omit the field.
Tags follow `TAGS.md`. Surface uncertain calls to Rene rather than guessing.

Then by hand: a neutral factual `description` (a list — Claude writes this by
default), a per-show `updates` note with `report: true`, and the `/history/`
narrative in `scripts/content/history.html`.

### 5. Build

```bash
python3 scripts/build.py        # --check for checks only
```

Fails on integrity problems (tag vocabulary, durations, R2 keys, missing
peaks/sidecars, orphan `songs/` dirs — with exact `git rm` commands). It
also *warns* on rarity-tag drift; that's Rene's editorial call to review,
not something to auto-fix.

### 6. Ship

Commit and push. A GitHub Action deploys the `renedebos-site` Worker. Watch
the run, then **spot-check a URL on renedebos.com that only the new deploy
could serve** — a green Action alone isn't proof the site actually changed.

## The policy you must not break

**Linear normalization is permanent policy, not a preference.** These are
acoustic live recordings with intentionally wide dynamics. The −20 LUFS
target is for comfortable listening, not competitive loudness, so there is
never a reason to fight a track's true peak to hit it exactly.

The banned thing is **gain that follows the music** — frame-adaptive
normalization riding up on quiet passages over a timescale of seconds, which
flattens hand-drawn fades and squashes fingerpicked verses against strummed
choruses. ffmpeg's `loudnorm` silently falls back to that mode when the
needed gain would breach −1 dBTP, with no warning in the logs. Since
workflow v6 the engine never renders through `loudnorm` at all — it measures,
then applies a plain `volume` filter, which has no fallback mode. Keep it
that way; `loudnorm`/`ebur128` are measurement-only tools here.

A track landing a few dB quieter than nominal is inaudible as a defect.
Flattened dynamics are not.

Two sanctioned exceptions, both narrow: the **applause-limiter** (v5), which
caps an isolated clap that out-peaks the music near a split boundary, and the
opt-in **sparse-transient-cap** (v8) — see `references/transient-cap.md`.
Neither is a licence to reintroduce dynamic-mode gain. Frequent or sustained
limiting of repeatedly-loud material (a dominant snare on every backbeat) has
no listening evidence behind it and stays unbuilt.

## Running the long steps

`prepare` and `publish` are long. Pass a single command with
`run_in_background: true` and **no** trailing `&` or `nohup` — double-
backgrounding fires a false completion — then poll for an explicit end
marker.

A local UI wraps the same commands: `python3 scripts/tcap_ui.py [--no-open]`
serves a control panel on `http://127.0.0.1:8769/` with archive-wide scan,
per-show analyze, and a streaming-log reprocess. Same code path and same
safety gates as the CLI — a convenience layer, not a bypass. Use either.

## When something goes wrong

See `references/troubleshooting.md` — fingerprint mismatches, stalled Drive
uploads, stale R2/Drive objects after a reprocess, and resuming a partial run.
