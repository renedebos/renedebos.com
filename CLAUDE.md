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

## Known Gotchas

- **`rclone` uploads to `gdrive:` can stall mid-file** — `--timeout` won't catch it; prefer local→Drive (the gdrive-mount copy) over a direct rclone push when possible, and use a `--max-duration` retry loop if you must push large files directly.
- **Audacity's MCP tools are unreliable** — spaces in paths choke import, `success:false` is sometimes ambiguous, and it has lost a track before. Treat it as surgical hand-editing territory for Rene, not for unattended automation; ffmpeg is the dependable path for deterministic DSP.
- **`pgrep -f '<script>.py'` can self-match the watcher process** if the watcher's own command line contains the same script name — match on the full file path instead, or rely on the background-task completion notification rather than process-name polling.
- **`assets/site.css` is a build output, not a source file** — `scripts/build.py` overwrites it verbatim from `scripts/site.css` on every run. Edit `scripts/site.css`; editing `assets/site.css` directly gets silently discarded by the next `make build`. Same relationship for every generated HTML page (archive, songs, search, updates, contact, history, every `/shows/*/`): they come from `scripts/sitegen/fragments.py`'s `page_shell()` template plus per-page generators in `scripts/sitegen/pages.py`, not from hand-editable HTML — edit the template/generator, then rebuild.

## Site Styling & Templates

Three separate, deliberate design systems live in this repo — don't blend them without a reason:
- **`assets/home.css`** — homepage-only, hand-maintained, paired with the static `index.html` at the repo root. Not generated.
- **`scripts/site.css`** (→ built to `assets/site.css`) — the shared "Hannan Classic" system for every generated page (archive, songs, search, updates, contact, history, every show page): warm paper palette, `Cormorant Garamond`/`Karla`/`Space Mono`, tokens in `:root`. `header`, `.page-title`, and `main` all share a common `.wrap` (1080px, 28px side padding) so pages line up under the homepage's logo/nav (2026-07-18 flow pass) — don't reintroduce independent centering on one of these without doing the others.
- **`/process/` and `/manual/`** — self-contained pages with their own inline `<style>` block, a different accent (blue) and font stack (`system-ui`), deliberately separate from "Hannan Classic" since they're internal/dev-facing documentation, not part of the public browsing experience. Don't fold them into `site.css` without being asked — that's a bigger, separate decision.

## Common Commands

All common operations are in the `Makefile`:

```bash
make refresh                          # regenerate drive_names.txt and r2_names.txt
make diff                             # show files in Drive not yet in R2
make status                           # print counts for Drive, R2, and missing
make upload FILE="filename.wav"       # copy a file from Drive to R2
make edit                             # local metadata editor (recordings.json), http://127.0.0.1:8765
make build                            # python3 scripts/build.py
```

`make edit` opens a browser automatically; when running headless (no display),
start it with `--no-open` in the background instead and report the URL. Stop
the server (TaskStop / Ctrl-C) once Rene confirms he's done editing, then run
`make build` and commit/push.

To upload a local staging file from `~/` directly to R2:
```bash
rclone copy ~/"<filename>" r2:hannan-audio --progress --s3-no-check-bucket
```

## Publishing a Split Show (runbook)

When asked to "process/upload show X to the website," the show usually **already exists in `data/recordings.json` as a whole-show entry** (`tracks: null`, `processing_status: needs-processing`) — this upgrades it to track-listed. Rene's hand-edited tracks (fades + clip fixes, sometimes whole-show noise reduction) live in the show's Drive Work Folder: `Tracks/`, or `Tracks Noise Reduction/` when NR was applied. A `notes.txt` in the tracks folder (free text, e.g. NR settings) becomes the `pre_edits` provenance. Rene also exports the Audacity labels as `labels.txt` at the Work Folder root (raw-archive split recipe — remind him if missing). NR'd exports FLAC-compress ~2× larger (residual+dither entropy); normal, not a spec problem.

**1. Prepare (mechanical, one command):** `python3 scripts/publish_show.py prepare <slug>` — locates the Work Folder by show date (`--folder` if ambiguous), picks the tracks source (**NR folder wins; both populated = hard error, never guess**), reads `notes.txt` → pre-edits, copies tracks to `~/work/<slug>/tracks/` (local gdrive-mount copy preferred, else Drive), runs the **full diagnose** (always full — the clip-only mode decision is retired), and stops. Run in background (~5–10 min). State → `~/work/<slug>/publish.json`.

**2. Review the diagnose** — the only judgment gate: `CLIPPING` verdicts go back to Rene in Audacity; `benign`/`minor` and mild residual publish as-is; `HIGH_LRA` is informational. **`PRED_TP` is not informational** — see the linear-normalization policy below.

**3. Publish (mechanical, one command):** `python3 scripts/publish_show.py publish <slug>` — loudnorm to **−20 LUFS all artists** (with `--pre-edits` from notes), R2 upload (FLAC/MP3 under the Work Folder name, `--s3-no-check-bucket` handled), peaks, R2-MD5-vs-sidecar verify (aborts on mismatch), Drive `Processed/` backup (stall-aware retry loop), local tracks cleanup. Background, ~30–40 min for ~35 tracks. Benign LUFS-drift warnings (~0.5 dB) on very dynamic tracks are fine — don't reprocess. If Rene is at his computer and wants to do the Drive `Processed/` backup himself (manual copy is often faster than rclone there), pass `--manual-drive-backup`: it waits ~3 min polling the Drive count before falling back to the automated rclone copy — ask him first each time, since it's opt-in, not default. **The manual-copy poll only counts files, not content** — if the destination already holds same-named files from a prior run of the same show (e.g. a reprocess), the count can be satisfied instantly by stale files. After any reprocess, verify Drive content with `rclone hashsum md5` against the local `out/` files before trusting the backup, don't rely on the count alone.

**Linear normalization is permanent policy, not a preference (decided 2026-07-13).** These are acoustic live recordings with wide, intentional dynamics (fingerpicked verses next to strummed choruses, hand-drawn fade-outs) — the −20 LUFS target is chosen for comfortable listening, not competitive loudness, so there is no reason to fight a track's true peak to hit it exactly. ffmpeg's `loudnorm` filter only applies true linear gain (a single constant multiplier for the whole file) when the gain needed to hit the target keeps true peak under the −1 dBTP ceiling; otherwise it **silently falls back to dynamic (frame-adaptive) normalization** — a compressor-like mode that rides the gain up on quiet passages and flattens hand-drawn fades and natural dynamics, with zero warning in the logs (`-loglevel error` swallows it). `audio_process.py` (workflow v4+) detects this via the same math diagnose uses for `PRED_TP` (`I - TP - 1` = the track's own safe "max linear target") and processes that track at its own reduced target instead — landing a few dB quieter than the show's nominal target, never in dynamic mode. **Workflow v6 (2026-07-16) removed the reliance on loudnorm's render entirely**: linear and linear-reduced tracks now compute the gain from a measurement pass and apply it with a plain, unconditional `volume` filter (no fallback mode exists for `volume`), so a hidden dynamic-mode render is no longer possible in principle, not just unlikely in practice — loudnorm/ebur128 are measurement-only tools now, never the render step. **Never reintroduce a dynamic-mode fallback or a limiter/compressor on the music to buy more headroom for a hotter linear target** — a quieter individual track is inaudible as a defect; flattened dynamics are not. This is why the diagnose report computes `max linear target` per flagged track — the process step now uses that number automatically. See `WORKFLOW_VERSIONS[4]` and `WORKFLOW_VERSIONS[6]` in `audio_process.py` for the technical record, and `/process/`'s "linear gain only... the dynamics of the room stay intact" claim for the public-facing statement of this policy.

**One narrow, sanctioned exception (workflow v5): applause-only limiting.** On audience tapes, a loud clap right at a split boundary can occasionally out-peak the music itself, forcing the whole track quieter than the *music* ever needed. `audio_process.py`'s applause-limiter mode (`plan["mode"] == "applause-limiter"`) tells a clap from music by behavior (crest factor + position near a track's head/tail, not just volume) and caps only that isolated transient, with the music underneath still getting one constant, untouched linear gain — the policy above is about never limiting to squeeze more loudness out of the performance itself, not about this. Don't read the "never reintroduce a limiter" line as a mandate to remove or avoid the applause-limiter mode.

**4. Metadata:** `python3 scripts/draft_tracks.py <slug>` drafts `tracks[]` into `recordings.json` — durations/sizes from the processed files, songwriter+tags reused from the catalog, NEW/ambiguous titles FLAGGED (resolve the flags: originals = "Jerry Hannan & Sean Hannan", covers = writer, trad = "Traditional", unknown = omit; tags per `TAGS.md`; surface uncertain calls to Rene). Then by hand: neutral factual `description` (**list**, I write it by default), per-show `updates` note (`report: true`), and the **`/history/` narrative** (`scripts/content/history.html`).

**5. Build:** `python3 scripts/build.py` — fails on integrity problems (tag vocab, durations/R2 keys, missing peaks/sidecars, orphan `songs/` dirs with exact `git rm` commands) and **warns on rarity-tag drift** (rarity on songs with 3+ appearances — Rene's call, review don't auto-fix). `--check` = checks only; CI runs them before every deploy.

**6. Ship:** commit, push (auto-deploys via GitHub Action → `npx wrangler deploy` of the **`renedebos-site` Worker**, which serves renedebos.com: static assets + playlist short-link endpoints, config in `wrangler.jsonc`), watch the run, then **spot-check a URL only the new deploy can serve on renedebos.com itself** (green Action alone isn't proof). The `wav-download` Worker (`worker/index.js`) is a **separate** `wrangler deploy`. The old hannan-audio Pages project is retired — don't deploy to it.

Raw archive: whole-show WAV (untouched) + `labels.txt` = the raw per-song recipe; `python3 scripts/split_raw.py "<work folder>"` materializes raw unedited splits on demand — **never store them** (rule: store what hands made; derive what machines can remake). Pre-NR exports (hand edits minus NR) ARE stored: Drive-only, folder named `Tracks (pre-NR archive)/`.

Optional, after a batch of new shows: `python3 scripts/build_archive_zip.py` regenerates the site's "download the complete archive" snapshot (every curated FLAC, ~25 GB, into one R2 object) and rebuild afterward so `/archive/` picks up the new counts/date. Manual and occasional — not part of CI or the publish runbook above; needs ~50 GB free local disk and can take a long time on a slow connection.

Background jobs: pass a single command to `run_in_background: true` with **no** trailing `&`/`nohup` (double-backgrounding fires a false "completed"); poll for an explicit end-marker.

## A/B Audio Comparison Tool

`scripts/ab_compare.py <show-slug> <track-num> [--raw PATH] [--port N]` — reusable
local tool (added 2026-07-16) for hearing whether the current live audio (or an
older workflow version) actually differs from what today's engine would produce,
not just comparing numbers. Reprocesses the track's original unprocessed source
with the current `audio_process.py` engine, fetches the live R2 version (MD5-
verified against provenance), and serves both synced (same-position A/B switch,
no restart-on-switch) at `http://127.0.0.1:8767/` via `scripts/ab_server.py` —
a small Range-request-supporting static server (stdlib `http.server` doesn't
support `Range`, which breaks `<audio>` seeking on anything but tiny files).
Also renders a loudness-over-time comparison chart and a params-diff table.
Needs the track's original unprocessed audio (not derivable from the published
output) — for shows with an archived `Tracks/`/`Tracks Noise Reduction/` +
`labels.txt`, that's the raw split (`split_raw.py`); older shows need a fresh
export from the `.aup3` project onto `~/gdrive-mount`, or pass `--raw` directly.

## Archive-wide Visibility

Two ways to see workflow-version/spec data across the *whole* archive at once
(not just one show), for managing the version rollout:
- `python3 scripts/audio_process.py version-map [--only-mixed] [--version N]` —
  CLI: per-show version tally, flags shows whose tracks span more than one
  version (`⚠ MIXED`), or lists every track anywhere still on a given version.
- **`/archive-data/`** — the same data, browsable: every track with its full
  catalog + spec/provenance data, filterable/sortable/searchable (artist,
  processing version, treatment mode, damage flag, free text). Not in the
  main nav or sitemap (bookmark it directly) — linked from `/manual/` and
  `/search/`. Built from `assets/track-spec.json`.

## MCP Tools Available

The session has Google Drive and Cloudflare Developer Platform MCP tools available, useful for inspecting Drive files and R2 bucket contents without dropping to the shell.
