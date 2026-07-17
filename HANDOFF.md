# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-17 · **Branch:** `main` (all work committed & pushed, deploy verified live)

> This run investigated two candidate shows for reprocessing onto the current
> engine, reprocessed the one that actually needed it (Sean Hannan, 19
> Broadway, Nov 29 1999), and in the process found and fixed a real bug in
> the applause-limiter true-peak safety loop — formalized as workflow v7.
> Everything is live; no open blockers.

## ✅ Done this session

### 1. Evaluated two v3/v5 shows as reprocessing candidates
- **`jerry-19-broadway-1999-08-23` (v5)** — checked, not reprocessed. Its
  provenance already shows targets engineered precisely to the −1 dBTP
  ceiling by design; nothing to gain.
- **`sean-19-broadway-1999-11-29` (v3)** — checked and reprocessed. A
  `diagnose` dry run confirmed 13 of 21 tracks predicted a true-peak
  overshoot under v3's naive −20 LUFS target (no ceiling-aware fallback
  existed yet), meaning `loudnorm` most likely silently rendered them in
  dynamic (compressor-like) mode instead of linear, with nothing in the
  original logs to show it.

### 2. Reprocessed `sean-19-broadway-1999-11-29` to the current engine (commit `4000739`)
Full `publish_show.py prepare`/`publish` runbook, 21 tracks. Track 7 ("The
Rodeo Song") came back with genuine sustained clipping in the source tape —
per Rene's call, published as-is (normalization can't undo clipping) and
flagged with the `dropouts` damage badge rather than hidden.

### 3. Found and fixed a real bug in the applause-limiter safety loop (commit `4000739`)
Track 21 ("Houses of the Holy") landed at −0.79 dBTP — over the −1 dBTP
ceiling — after the true-peak safety loop's full 4 retry attempts, every one
measuring the *identical* peak. Root cause: the retry only backed off
`gain_db` (the pre-limiter gain), but when applause — not music — sets the
ceiling, `alimiter` clamps to a fixed `limit_db` threshold regardless of how
much pre-gain feeds it, so the retry never touched the actual overshoot
source. Fixed by backing off `limit_db` and `gain_db` together, preserving
the invariant that the limiter can never reach anything classified as music.
Track 21 re-rendered clean at −1.15 dBTP; re-verified byte-identical on R2
and Drive `Processed/` (whole-file MD5, not just a file-count check).

### 4. Formalized the fix as workflow v7 (commit `d1b7e0c`)
Bumping the version (not just patching the behavior) matters because the fix
had already shipped under `WORKFLOW_VERSION = 6` — leaving it there would
mean two different safety-loop behaviors both read "ver: 6" in provenance,
distinguishable only by the `chain` field and run date, not the version
number the whole registry exists to make legible. Added the
`WORKFLOW_VERSIONS[7]` entry, retagged track 21's already-shipped provenance
to `ver: 7` (audio/MD5 unchanged), and updated `PUBLISHING.md`: a new v7
narrative subsection matching the v1–v6 style, an updated version table row,
and a correction to Part 1's "True-peak safety loop" description, which
still described the pre-fix gain-only backoff.

### 5. Metadata + publish, both reprocessing threads
Set the `dropouts` flag on track 7, caught and reverted an unwanted
side-effect (`draft_tracks.py` had auto-corrected track 2's title from
"The Kiss / Da Da Da…" to "The Kiss - Da Da Da…" to match the filename
separator — reverted per Rene), wrote the Updates note, added a bullet to
`/history/`'s "Week ten" section, rebuilt, committed, pushed, and spot-checked
both the show page and `/manual/` live.

## 🟥 Tooling gotchas (durable, still real)
- `rclone` uploads to `gdrive:` can stall mid-file — prefer local→Drive over
  a direct push; `--max-duration` retry loop if you must push directly.
- Audacity's MCP tools are unreliable — surgical hand-editing territory for
  Rene, not unattended automation.
- `pgrep -f '<script>.py'` can self-match the watcher process — match on the
  full path, or rely on the background-task notification instead.
- A Drive fix doesn't propagate to the cached `~/gdrive-mount` copy
  automatically, and `prepare`'s `fetch_tracks()` prefers that cache when
  the file count matches — always re-verify actual filenames in
  `~/work/<slug>/tracks/` after a last-minute Drive correction, don't trust
  the count alone.
- An R2 filename-casing fix must be applied in **all four** places (local
  `tracks/` input, local `out/` output, R2, Drive source) or a retry
  regenerates the bug from the stale input.
- `rclone hashsum md5` (whole file) and `ffmpeg -f md5` (audio stream only)
  are **not** directly comparable — hashing the same audio via both methods
  will legitimately differ once tags are embedded. Compare like for like
  (whole-file to whole-file, or stream to stream) when verifying a Drive
  backup against a local render.
- `json.dump(..., ensure_ascii=True)` (the default) re-escapes every
  existing non-ASCII character (em dashes, etc.) in a JSON file on any
  write, producing a huge noisy diff for a one-field edit. Always pass
  `ensure_ascii=False` when hand-patching a provenance sidecar, matching
  `audio_process.py`'s own convention.

## ⏭️ What's next
- No open items from this session's explicit requests.
- Still not raised with Rene (carried over, unresolved): whether
  `/archive-data/` should ever be mentioned in the public `/history/`
  narrative — left out so far as a judgment call to stay consistent with its
  "not prominently displayed" design intent, not something Rene has weighed
  in on directly.

## Durable facts (don't undo)
- **All artists → −20 LUFS, −1 dBTP ceiling. Linear normalization only —
  never a limiter/compressor on the music itself** (applause-only limiting on
  audience tapes is the one sanctioned exception). See `CLAUDE.md`.
- **Workflow v7: render is explicit `volume=<gain>dB`, not a second loudnorm
  pass.** Don't reintroduce a loudnorm-linear-mode render. On the
  applause-limiter true-peak retry, `limit_db` and `gain_db` must be backed
  off **together** — backing off gain alone doesn't move an overshoot that
  the limiter, not the gain, is actually causing.
- `gdrive:` = owner account `renedebos@hotmail` (5 TB). No
  `--drive-shared-with-me` anywhere.
- **R2 filename-casing must match the show's existing canonical key exactly**
  when re-processing — `rclone copy` matches by filename, not content; a
  mismatch duplicates instead of overwriting. Fix all four locations (see
  gotchas above), not just the output.
- Engine: `audio_process.py` (diagnose/process/verify/status/versions/
  version-map/history/plan). `scripts/ab_compare.py` for A/B listening
  tests. `/archive-data/` is the browsable, whole-archive counterpart to
  `version-map` — check it before assuming a show is fully caught up to the
  current engine.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Owner's manual (all
tools, all four workflow phases, full version history): `PUBLISHING.md`
(also rendered at `/manual/`). Older phase-by-phase technical detail:
`AUDIO_PROCESSING.md`. Playlist/player feature spec: `PLAYLIST FEATURE.md`.
