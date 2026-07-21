# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-22 · **Branch:** `main` — everything below is committed & pushed, deploy verified live on renedebos.com itself (not just green Action).

> Audio-processing session: reprocessed one show (`sean-19-broadway-unknown`)
> to the current engine, following the full publish runbook end to end,
> including two mid-run snags that needed fixing before it could ship clean.

## ✅ Done this session

### Reprocessed `sean-19-broadway-unknown` to workflow v7 (commits `86573ea`, `8bf72c2`)
An undated Sean Hannan show at 19 Broadway, previously normalized with an
older Audacity −16 LUFS pass (workflow v2, from 2026-06-30). Rene had hand-
edited a fresh set of tracks with light noise reduction (−6 dB reduction,
sensitivity 5) sitting in the Drive Work Folder's `Tracks Noise Reduction/`
export but no `notes.txt` — I wrote one with the NR settings and uploaded it
to Drive so `publish_show.py prepare` would pick it up as `pre_edits`
provenance, rather than falling back to the generic "noise reduction
(Audacity, whole show)" string.

**Diagnose came back clean** — 18 tracks, no clipping/drops/clicks. The only
flags were auto-handled types (`PRED_TP` → engine used each track's own
reduced linear target automatically; `HIGH_LRA` → informational, the
recording's own dynamics; `BANDWIDTH` → audience mic doesn't fill above
~20 kHz, expected for this source) — nothing needed to go back to Rene in
Audacity.

**Two snags hit during publish, both resolved:**
1. **R2 already held 3 stale FLACs from the old 2026-07-10 run** with
   slightly different filenames than today's fresh export (capitalization/
   wording drift in Rene's track exports: `Don't` vs `don't`, `Angel from
   Montgomery` vs `Angel of Montgomery`, `Ode to` vs `Ode To`). The
   `R2 FLAC incomplete: 21/18` count-mismatch safety check in
   `publish_show.py` caught it correctly — it isn't a bug, it's the check
   working as designed. `rclone delete` is hard-blocked for the agent by a
   `deny` rule in `.claude/settings.local.json` (guarding against exactly
   this kind of destructive R2 action), so Rene ran the 3 deletes himself.
   Same issue recurred on the MP3 side (old run's MP3s were still under the
   old names) — Rene deleted those too, then `publish` was re-run and
   resumed instantly from cached per-track output (the engine skips tracks
   whose processed output already exists).
2. **Two tracks in the fresh export used slightly different titles than the
   archive's established convention** for those songs (confirmed by
   grepping every other appearance of "Angel from Montgomery" and "Don't
   Think Twice It's All Right" across ~10 other shows) — fixed the `title`
   field in `recordings.json` for track 3 and track 14 without touching the
   already-uploaded R2 filenames (title display is independent of the R2
   key). This is the same class of issue Week eleven's history entry
   (jerry-19-broadway-1999-06-21) already documented — a fresh hand-edit
   pass drifting from the established title, restored rather than
   overwritten.

**Full runbook completed:** R2 upload MD5-verified (0 mismatches), Drive
`Processed/` backup confirmed 36/36 files, `draft_tracks.py` flags reviewed
(2 title fixes above; "Flag Decal" — genuinely new to the archive — and the
two "prior appearances disagree" flags on Long Black Veil/Elephant Shoes
were fine as auto-drafted), manual Updates note added, Week twelve History
entry added, `build.py --check` clean (no orphan pages), `status --write`
run and rebuilt, committed, pushed, GitHub Action green, spot-checked the
live show page/song pages/updates feed/download-zip metadata directly on
renedebos.com.

### Cleanup: untracked two stray files (commit `8bf72c2`)
The first commit used `git add -A` and accidentally swept in two
pre-existing untracked files that had nothing to do with this session:
`.claude/settings.json` and `codex-notes.md` (an external tool's
architecture-review doc — see project memory `codex_notes_doc.md`). Caught
it, `git rm --cached` both in a follow-up commit (kept on disk, just
untracked) rather than amending the prior commit.

## Gotchas learned this session
- **`rclone delete`/`purge`/`sync`/`move` are hard-denied in
  `.claude/settings.local.json`** — this is a deliberate guardrail, not a
  per-call prompt; no amount of retrying or user confirmation via
  AskUserQuestion bypasses a `deny` rule. When a reprocess needs a stale R2
  object removed, hand the exact `rclone delete` command to Rene to run
  himself.
- **`publish_show.py`'s `R2 {FLAC,MP3} incomplete: N/expected` check is a
  real safety net, not a flaky failure** — it fires whenever Rene's fresh
  track export uses different filenames than a prior run for the same
  track number (capitalization, wording), leaving old+new versions
  side-by-side in R2. Don't just re-run and hope; find the stale
  old-dated files (`rclone lsl` shows mtimes) and remove them first, on
  **both** the FLAC and MP3 sides — they don't necessarily go stale at the
  same time (this show's MP3s were still 100% on the old names even after
  the FLAC side was partly fixed).
- **A show with no `date` (`"date": null`, "Unknown date" display) can't be
  auto-located by `publish_show.py prepare`** — `find_work_folder()`
  matches Drive Work Folder names by the show's `date` field, so it always
  needs an explicit `--folder "<exact Drive folder name>"` for this kind of
  show.
- **A missing `notes.txt` for a noise-reduced show's pre-edits provenance
  can be supplied by writing and uploading one yourself** (`rclone copy` a
  small text file into the Drive `Tracks Noise Reduction/` folder) when
  Rene tells you the NR settings directly instead of leaving them in the
  folder — `find_tracks_source()` reads it the same way either way.
- **`git add -A` before a runbook commit needs a `git status` sanity check
  first** if there's any chance of stray untracked files in the repo root —
  it will happily stage and push anything sitting there, not just the
  files the current task touched.

## Durable facts (don't undo)
- Audio-processing policy (−20 LUFS, linear-only normalization, workflow
  v7, gdrive/R2 remote setup) is unchanged by this session — see CLAUDE.md
  → "Publishing a Split Show" for the canonical, current version.
- `sean-19-broadway-unknown` is now fully on workflow v7 — no longer a
  version-map outlier.
- `.claude/settings.local.json` has hard `deny` rules for
  `rclone delete/purge/sync/move` and `rm -rf/-r` — intentional guardrails,
  not something to work around by retrying or asking the user to "grant
  permission" (there's no session-level override for a `deny` rule; the
  action has to be done by Rene directly, or the rule edited deliberately).

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Owner's manual (all
tools, all four workflow phases, full version history): `PUBLISHING.md`
(also rendered at `/manual/`). Older phase-by-phase technical detail:
`AUDIO_PROCESSING.md`. Tag vocabulary: `TAGS.md`.
