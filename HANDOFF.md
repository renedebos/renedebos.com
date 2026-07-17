# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-16 · **Branch:** `main` (all work committed & pushed, deploy verified live)

> This session built a **reusable local A/B audio comparison tool**, then
> reviewed a ChatGPT-authored critique of the v5 audio engine and shipped the
> subset of its suggestions worth doing as **workflow v6** (explicit-gain
> rendering, universal LRA QA, richer provenance, MP3 true-peak trim loop).
> Everything is live; no open blockers.

## ✅ Done this session

### 1. A/B comparison tool — `scripts/ab_compare.py` / `ab_server.py` / `ab_template.html` (commit `5f5e014`)
- Reusable tool: given `<slug> <track-num>`, reprocesses the track's original
  source with the current engine, fetches the live R2 version (MD5-verified),
  and serves both synced for instant A/B switching at the exact same playback
  position, plus a loudness-over-time chart and a params-diff table.
- **Bug fixed:** switching A→B mid-playback restarted the track from 0.
  Root cause: stdlib `python -m http.server` doesn't support HTTP Range
  requests (always `200 OK` with the full file, confirmed via `curl -H
  "Range: ..."`), which breaks `<audio>` seeking. Fixed with a small
  Range-aware server (`ab_server.py`), verified via header comparison and a
  byte-level `cmp` against a `dd`-extracted slice, not just headers.
- Documented in `CLAUDE.md` under "A/B Audio Comparison Tool" so it doesn't
  need re-coding next time it's wanted.

### 2. Workflow v6 — explicit-gain rendering, broader QA — `audio_process.py` (commit `bec16a2`)
Reviewed the ChatGPT v5 critique on its merits rather than wholesale: agreed
with Rene's existing per-song (not per-show) constraint, found several
suggestions already effectively implemented (reduced-target overshoot
handling, the measure-and-correct true-peak loop, the three-layer archival
model), declined the multi-feature spectral applause classifier and rigid
numeric "processing budgets" as over-engineered for this archive's scale, and
found one genuine gap by reading the code directly: the LRA-preservation QA
check only ran for applause-limiter tracks, not linear/linear-reduced ones.
Shipped as `WORKFLOW_VERSION = 6`:
- **Explicit-gain rendering.** linear/linear-reduced tracks now compute gain
  from a measurement pass and apply it with a plain `volume=<gain>dB` filter
  instead of a second `loudnorm` call with `linear=true` — removes the last
  reliance on ffmpeg's own linear/dynamic fallback decision at render time.
  `loudnorm`/`ebur128` are measurement-only now, never the render step.
  Validated on a real track (Plastic Lemons): new render hits TP exactly at
  the −1.00 dBTP ceiling vs. the old render's −1.42 dBTP (0.42 dB of unused
  headroom left on the table) for the same target LUFS.
- **Universal LRA QA gate** — the dynamics-preservation check now runs on
  every track, not just applause-limiter ones.
- **Richer provenance** — `plr` (true peak − integrated LUFS) and `max_m`/
  `max_s` (peak momentary/short-term loudness) per track; these predict
  "sounds louder in a playlist" in a way flat integrated LUFS can't.
- **MP3 true-peak trim loop** — up to 3 attempts, FLAC master never touched,
  for when lossy re-encoding pushes the MP3's true peak over the ceiling.
- Verified byte-identical output on the unchanged applause-limiter path (MD5
  matched exactly before/after) before committing.
- `PUBLISHING.md` (rendered at `/manual/`) updated: Loudness-normalization
  section, new "QA gates (workflow v6)" paragraph, Part 5 version-history
  table + subsection. Deploy confirmed live via direct `curl` of `/manual/`
  for the new anchor/content (GitHub's API had a brief 503 outage right after
  push; retried until it recovered rather than guessing at deploy status).
- Docs pass (this note): `CLAUDE.md`'s linear-normalization policy section
  and `AUDIO_PROCESSING.md`'s Phase 2 processing-chain section updated to
  describe the explicit-gain render (they still described the old
  loudnorm-linear-mode-trust approach) — same pattern as the July 14 doc
  cleanup that keeps these two in sync with the actual code.

## 🟥 Tooling gotchas (still real, from CLAUDE.md — unchanged this session)
- `rclone` uploads to `gdrive:` can stall mid-file — prefer local→Drive over a
  direct push; `--max-duration` retry loop if you must push directly.
- Audacity's MCP tools are unreliable — surgical hand-editing territory for
  Rene, not unattended automation.
- `pgrep -f '<script>.py'` can self-match the watcher process — match on the
  full path, or rely on the background-task notification instead.

## ⏭️ What's next (not started, just planned)
- **Continuous player popup** (`/player/` + `sendToPlayer()` + Media Session
  action handlers) — full plan exists (see "Phase 7" in `PLAYLIST FEATURE.md`)
  but no code written. Pick this up when Rene wants "keep playing while
  browsing anything else."
- No other open items from this session.

## Durable facts (don't undo)
- **All artists → −20 LUFS, −1 dBTP ceiling. Linear normalization only —
  never a limiter/compressor on the music itself** (applause-only limiting on
  audience tapes is the one sanctioned exception, unchanged). See CLAUDE.md.
- **Workflow v6: render is explicit `volume=<gain>dB`, not a second loudnorm
  pass.** Don't reintroduce a loudnorm-linear-mode render — that's exactly the
  silent-fallback risk v6 eliminated structurally.
- `gdrive:` = owner account `renedebos@hotmail` (5 TB). No
  `--drive-shared-with-me` anywhere.
- Engine: `audio_process.py` (diagnose/process/verify/status/versions/history/
  plan); `scripts/ab_compare.py` for A/B listening tests, reusable going
  forward — don't recreate it.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Technical detail:
`AUDIO_PROCESSING.md`. Playlist/player feature spec (incl. the planned popup
player): `PLAYLIST FEATURE.md`.
