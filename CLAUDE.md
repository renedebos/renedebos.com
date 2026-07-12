# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is the renedebos.com website, which hosts the Hannan audio archive — live music recordings by Jerry Hannan, Mad Hannans, and Sean Hannan. Audio files are stored in Cloudflare R2 and sourced from Google Drive.

The two large WAV files in `~/` are local staging copies for direct rclone uploads. Most files are accessed via the `gdrive:` remote, authenticated as the owner account (renedebos@hotmail) of the DAT Tapes Google Drive folder.

## rclone Remotes

- **`gdrive:`** — Google Drive, authenticated as the **owner** account `renedebos@hotmail` (5 TB) that owns the DAT Tapes folder. Source of truth for all recordings.
  - Primary path: `gdrive:DAT Tapes/DAT Tapes WAV Files/Hannans`
  - Reach content by path with **no** flag. Do **not** pass `--drive-shared-with-me` — it filters to shared-with-me items and now excludes the owned content. (Earlier the remote used a separate gmail account that accessed DAT Tapes as shared-with-me; that's been switched to the owner account.)
- **`r2:`** — Cloudflare R2. Archive destination.
  - Bucket: `r2:hannan-audio`
  - Requires `--s3-no-check-bucket` flag for all operations

## Common Commands

All common operations are in the `Makefile`:

```bash
make refresh                          # regenerate drive_names.txt and r2_names.txt
make diff                             # show files in Drive not yet in R2
make status                           # print counts for Drive, R2, and missing
make upload FILE="filename.wav"       # copy a file from Drive to R2
```

To upload a local staging file from `~/` directly to R2:
```bash
rclone copy ~/"<filename>" r2:hannan-audio --progress --s3-no-check-bucket
```

## Publishing a Split Show (runbook)

When asked to "process/upload show X to the website," the show usually **already exists in `data/recordings.json` as a whole-show entry** (`tracks: null`, `processing_status: needs-processing`) — this upgrades it to track-listed. Rene's hand-edited tracks (fades + clip fixes, sometimes whole-show noise reduction) live in the show's Drive Work Folder: `Tracks/`, or `Tracks Noise Reduction/` when NR was applied. A `notes.txt` in the tracks folder (free text, e.g. NR settings) becomes the `pre_edits` provenance. Rene also exports the Audacity labels as `labels.txt` at the Work Folder root (raw-archive split recipe — remind him if missing). NR'd exports FLAC-compress ~2× larger (residual+dither entropy); normal, not a spec problem.

**1. Prepare (mechanical, one command):** `python3 scripts/publish_show.py prepare <slug>` — locates the Work Folder by show date (`--folder` if ambiguous), picks the tracks source (**NR folder wins; both populated = hard error, never guess**), reads `notes.txt` → pre-edits, copies tracks to `~/work/<slug>/tracks/` (local gdrive-mount copy preferred, else Drive), runs the **full diagnose** (always full — the clip-only mode decision is retired), and stops. Run in background (~5–10 min). State → `~/work/<slug>/publish.json`.

**2. Review the diagnose** — the only judgment gate: `CLIPPING` verdicts go back to Rene in Audacity; `benign`/`minor` and mild residual publish as-is; PRED_TP/HIGH_LRA flags are informational (loudnorm's −1 dBTP ceiling handles them).

**3. Publish (mechanical, one command):** `python3 scripts/publish_show.py publish <slug>` — loudnorm to **−20 LUFS all artists** (with `--pre-edits` from notes), R2 upload (FLAC/MP3 under the Work Folder name, `--s3-no-check-bucket` handled), peaks, R2-MD5-vs-sidecar verify (aborts on mismatch), Drive `Processed/` backup (stall-aware retry loop), local tracks cleanup. Background, ~30–40 min for ~35 tracks. Benign LUFS-drift warnings (~0.5 dB) on very dynamic tracks are fine — don't reprocess. If Rene is at his computer and wants to do the Drive `Processed/` backup himself (manual copy is often faster than rclone there), pass `--manual-drive-backup`: it waits ~3 min polling the Drive count before falling back to the automated rclone copy — ask him first each time, since it's opt-in, not default.

**4. Metadata:** `python3 scripts/draft_tracks.py <slug>` drafts `tracks[]` into `recordings.json` — durations/sizes from the processed files, songwriter+tags reused from the catalog, NEW/ambiguous titles FLAGGED (resolve the flags: originals = "Jerry Hannan & Sean Hannan", covers = writer, trad = "Traditional", unknown = omit; tags per `TAGS.md`; surface uncertain calls to Rene). Then by hand: neutral factual `description` (**list**, I write it by default), per-show `updates` note (`report: true`), and the **`/history/` narrative** (`scripts/content/history.html`).

**5. Build:** `python3 scripts/build.py` — fails on integrity problems (tag vocab, durations/R2 keys, missing peaks/sidecars, orphan `songs/` dirs with exact `git rm` commands) and **warns on rarity-tag drift** (rarity on songs with 3+ appearances — Rene's call, review don't auto-fix). `--check` = checks only; CI runs them before every deploy.

**6. Ship:** commit, push (auto-deploys via GitHub Action → `npx wrangler deploy` of the **`renedebos-site` Worker**, which serves renedebos.com: static assets + playlist short-link endpoints, config in `wrangler.jsonc`), watch the run, then **spot-check a URL only the new deploy can serve on renedebos.com itself** (green Action alone isn't proof). The `wav-download` Worker (`worker/index.js`) is a **separate** `wrangler deploy`. The old hannan-audio Pages project is retired — don't deploy to it.

Raw archive: whole-show WAV (untouched) + `labels.txt` = the raw per-song recipe; `python3 scripts/split_raw.py "<work folder>"` materializes raw unedited splits on demand — **never store them** (rule: store what hands made; derive what machines can remake). Pre-NR exports (hand edits minus NR) ARE stored: Drive-only, folder named `Tracks (pre-NR archive)/`.

Background jobs: pass a single command to `run_in_background: true` with **no** trailing `&`/`nohup` (double-backgrounding fires a false "completed"); poll for an explicit end-marker.

## MCP Tools Available

The session has Google Drive and Cloudflare Developer Platform MCP tools available, useful for inspecting Drive files and R2 bucket contents without dropping to the shell.
