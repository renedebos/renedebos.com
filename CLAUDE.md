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
- **`assets/site.css` is a build output, not a source file** — `scripts/build.py` overwrites it verbatim from `scripts/site.css` on every run. Edit `scripts/site.css`; editing `assets/site.css` directly gets silently discarded by the next `make build`. Same relationship for every generated HTML page (songs, search, updates, contact, history, every `/shows/*/`): they come from `scripts/sitegen/fragments.py`'s `page_shell()` template plus per-page generators in `scripts/sitegen/pages.py`, not from hand-editable HTML — edit the template/generator, then rebuild.

## Site Styling & Templates

Three separate, deliberate design systems live in this repo — don't blend them without a reason:
- **`scripts/home.css`** (→ built to `assets/home.css`) — the homepage's own "tape deck" look, generated (via `build_home()`/`HOME_SHELL` in `scripts/sitegen/pages.py`) rather than hand-authored HTML, but deliberately a different layout system from the rest of the site per the 2026-07-10 redesign. Since 2026-07-19 it also absorbs the full show listing (formerly the separate `/archive/` page, now `/archive/` &rarr; `/` redirects) — sortable by date/artist/venue, rendered client-side by `scripts/home.js` from `assets/home-shows.json`. Shares `site.css`'s color tokens and fonts (different CSS variable names, same values — keep the two in sync) so the page doesn't look like a different site once you click through, but keeps its own card/layout vocabulary, including a from-scratch port of the password-download-modal CSS (`.pw-overlay` etc.) since `player.js`'s download gating is shared sitewide.
- **`scripts/site.css`** (→ built to `assets/site.css`) — the shared "Hannan Classic" system for every other generated page (songs, search, updates, contact, history, every show page): warm paper palette, `Cormorant Garamond`/`Karla`/`Space Mono`, tokens in `:root`. `header`, `.page-title`, and `main` all share a common `.wrap` (1080px, 28px side padding) so pages line up under the homepage's logo/nav (2026-07-18 flow pass) — don't reintroduce independent centering on one of these without doing the others.
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

**A local UI exists for the transient-cap (v8) parts of this runbook** — `python3 scripts/tcap_ui.py [--port 8769] [--no-open]` serves a control panel at `http://127.0.0.1:8769/` (never deployed — `scripts/` is `.assetsignore`'d). It wraps the same underlying commands below (`publish_show.py prepare`/`publish`, `audio_process.py plan`), not a separate code path: **scan** the whole archive offline for cap candidates (loudness gap to target, no audio read), **analyze** a show per-track against either the published R2 audio (preliminary) or the prepared canonical source (after step 1 below — the analysis that actually supports publishing), and **reprocess** — streams `prepare`/`publish` logs live, with per-track accept/exclude/listen-first decisions persisted to `~/work/tcap-ui/<slug>/decisions.json` and passed through as `--transient-cap-accept`/`--transient-cap-exclude`. The engine's own gates (hard-blocking listen-flags, strict −1 dBTP check, 6 dB attenuation cap) remain the real safety barrier either way — the UI is a convenience layer on top, not a bypass. Editorial judgment (is a flagged title a typo or a real correction, does a capped moment sound right) is still a human/Claude call either way. Use the UI or the raw CLI commands below interchangeably — same state, same safety gates.

**1. Prepare (mechanical, one command):** `python3 scripts/publish_show.py prepare <slug>` — locates the Work Folder by show date (`--folder` if ambiguous), picks the tracks source (**NR folder wins; both populated = hard error, never guess**), reads `notes.txt` → pre-edits, copies tracks to `~/work/<slug>/tracks/` (local gdrive-mount copy preferred, else Drive), runs the **full diagnose** (always full — the clip-only mode decision is retired), and stops. Run in background (~5–10 min). State → `~/work/<slug>/publish.json`.

**2. Review the diagnose** — the only judgment gate: `CLIPPING` verdicts go back to Rene in Audacity; `benign`/`minor` and mild residual publish as-is; `HIGH_LRA` is informational. **`PRED_TP` is not informational** — see the linear-normalization policy below. **A `TITLE CHANGED` flag needs cross-referencing** (every prior appearance of that title anywhere in the archive, not just the fresh filename) before deciding typo-vs-real-correction. The moment that's decided as "keep the established spelling," run `python3 scripts/publish_show.py rename-track <slug> --track-num N --new-title "Correct Title"` immediately — **before** the first `publish` call, not after a failed one. Renaming by hand (`mv`) leaves `publish.json`'s fingerprint pointing at the old filename, so the very next `publish` correctly aborts with a fingerprint mismatch; `rename-track` updates the manifest/fingerprint to match in one step instead of requiring manual JSON surgery.

**3. Publish (mechanical, one command):** `python3 scripts/publish_show.py publish <slug>` — loudnorm to **−20 LUFS all artists** (with `--pre-edits` from notes), R2 upload (FLAC/MP3 under the Work Folder name, `--s3-no-check-bucket` handled), peaks, R2-MD5-vs-sidecar verify (aborts on mismatch), Drive `Processed/` backup (stall-aware retry loop), local tracks cleanup. Background, ~30–40 min for ~35 tracks. Benign LUFS-drift warnings (~0.5 dB) on very dynamic tracks are fine — don't reprocess. If Rene is at his computer and wants to do the Drive `Processed/` backup himself (manual copy is often faster than rclone there), pass `--manual-drive-backup`: it waits ~3 min polling Drive before falling back to the automated rclone copy — ask him first each time, since it's opt-in, not default. **The poll checks content, not just file count (fixed 2026-07-22)** — `drive_backup_matches()` runs `rclone check` (FLAC/MP3 hashes) plus a `processing_report.txt` presence check, so stale same-named leftovers from a prior run of the same show (e.g. a reprocess) can no longer satisfy it by count alone; a stale leftover now fails the check and triggers a real re-copy. Note this only overwrites/adds — it does not delete old-named orphans left behind by a prior run's stale files (e.g. a title that changed between runs), so after a reprocess still check Drive `Processed/` by eye (or `rclone lsl`) for old-dated duplicates under the previous filename and clean them up with `rclone delete` (same as R2 stale-file cleanup below — `rclone delete` against the `r2:` remote is agent-executable and pre-approved since 2026-08-11; still confirm with Rene before deleting anything on `gdrive:`, the source of truth). **`--tracks 3,7,14` scopes publish to just those track numbers** (added 2026-08-10) — for a show where most tracks already sit at target under an older workflow version and only a few are genuine v8 candidates (gap ≥1 dB), this avoids re-rendering/re-uploading the whole show for no audible benefit. Still requires a full `prepare` (and its diagnose review) first — only the render/upload/draft/backup stage is scoped.

**Linear normalization is permanent policy, not a preference (decided 2026-07-13).** These are acoustic live recordings with wide, intentional dynamics (fingerpicked verses next to strummed choruses, hand-drawn fade-outs) — the −20 LUFS target is chosen for comfortable listening, not competitive loudness, so there is no reason to fight a track's true peak to hit it exactly. ffmpeg's `loudnorm` filter only applies true linear gain (a single constant multiplier for the whole file) when the gain needed to hit the target keeps true peak under the −1 dBTP ceiling; otherwise it **silently falls back to dynamic (frame-adaptive) normalization** — a compressor-like mode that rides the gain up on quiet passages and flattens hand-drawn fades and natural dynamics, with zero warning in the logs (`-loglevel error` swallows it). `audio_process.py` (workflow v4+) detects this via the same math diagnose uses for `PRED_TP` (`I - TP - 1` = the track's own safe "max linear target") and processes that track at its own reduced target instead — landing a few dB quieter than the show's nominal target, never in dynamic mode. **Workflow v6 (2026-07-16) removed the reliance on loudnorm's render entirely**: linear and linear-reduced tracks now compute the gain from a measurement pass and apply it with a plain, unconditional `volume` filter (no fallback mode exists for `volume`), so a hidden dynamic-mode render is no longer possible in principle, not just unlikely in practice — loudnorm/ebur128 are measurement-only tools now, never the render step. **Never reintroduce a dynamic-mode fallback — and never let any limiter/compressor ride sustained musical material.** A quieter individual track is inaudible as a defect; flattened dynamics are not. This is why the diagnose report computes `max linear target` per flagged track — the process step now uses that number automatically. See `WORKFLOW_VERSIONS[4]` and `WORKFLOW_VERSIONS[6]` in `audio_process.py` for the technical record, and `/process/`'s "linear gain only... the dynamics of the room stay intact" claim for the public-facing statement of this policy.

**What the ban means precisely — amended 2026-08-08 after Rene approved the `transient-cap` mode (workflow v8).** The prohibited thing is *gain that follows the music*: frame-adaptive normalization riding up on quiet passages over a timescale of **seconds** — that is what flattens a hand-drawn fade or squashes a fingerpicked verse against a strummed chorus. The original wording ("never a limiter/compressor on the music") over-reached: it also read as banning a **millisecond-scale true-peak cap on isolated transients**, which acts three orders of magnitude below the fade/phrase timescale and measurably cannot do the harm the ban exists to prevent. Evidence: loudness-matched blind A/Bs on **two independent shows** (`mad-cafe-java-1999-09-09`: Rocky Road, The Kiss / Da Da Da incl. its hand-drawn fade; `mad-sweetwater-1999-05-18`: Blahana, Smoke in Heaven, The Kiss / Da Da Da) — Rene could not hear the cap on any of the five at up to 5.9 dB of recovery; measured LRA moved ≤ 0.3 LU. So: **`transient-cap` (v8) is sanctioned** — recorded in provenance as mode `sparse-transient-cap` (the sparsity is the point; the name keeps it unmistakably distinct from any future repeated-drum treatment) — strictly opt-in per show (`publish_show.py --transient-cap`, never default), gated per track in **three tiers** (revised same day after the Hear Me case: engagement, not near-peak density, is what the A/B evidence actually sampled — **auto** when density ≤ 2%, predicted engagement ≤ 1%, longest event ≤ 0.2 s; **review** up to 5%/2%/0.5 s — capped but hard-blocked until Rene listens; beyond that **declined**; plus ≥ 1 dB and ≤ 6 dB of recovery; applause-limiter takes precedence; `--transient-cap-exclude` is Rene's per-track veto, `--transient-cap-force` his after-listening override), with the **6 dB cap enforced on the limiter's actual instantaneous attenuation** (Rene's 2026-08-08 disambiguation — a track needing more shave gets its gain trimmed and lands ≤ ~0.5 dB shy of nominal, never over-shaved; a track needing > 6 dB of recovery stays linear-reduced unless Rene opts it into **partial capping** per track — `--transient-cap-partial`, full 6 dB shave, lands honestly short — never automatic), a post-render true-peak assertion against a **strict −1.00 dBTP** (no QA tolerance for this mode) that **deletes the output and aborts** on failure, render state persisted beside each output so a resume can prove its chain or re-renders, "listen before shipping" flags that **hard-block the run** until explicitly accepted (`--transient-cap-accept`) or excluded after listening, and full guardrail provenance (max/p95 reduction, engaged %, event count, longest event, source LRA) surfaced in `/archive-data/`. **Still banned, no exceptions:** loudnorm dynamic mode or any equivalent seconds-scale gain riding; and frequent/sustained limiting of repeatedly-loud material (a dominant snare on every backbeat — `Truck` on Cafe Java, 12.3% near-peak, is the canonical counterexample). That regime has **no listening evidence**; a `drum-control` proposal for it exists in `codex-notes.md` but is deliberately **not built** — it needs its own explicit decision from Rene, with its own A/B evidence, if it ever happens. See `WORKFLOW_VERSIONS[8]` for the full technical record.

**Amended 2026-08-16 — the Truck exception, scoped to the loud variant.** The loudness-variants work (`plans/loudness-variants/`) adds a second render of every track at **−14 LUFS**, and `--transient-cap-over-applause` makes tracks the applause-limiter would otherwise keep **eligible** for the cap — including `Truck`, the counterexample named above. Rene accepted this on 2026-08-16 after listening to 20 tracks of that same Cafe Java tape at −14 (5.8% median engagement, 10.4% max, events to 0.70 s) and hearing no difference loudness-matched; Truck measures **8.7% engaged, longest event 0.15 s** — inside that envelope, and its longest event is shorter than the 0.2 s *auto* threshold.

**Eligible is not the same as accepted — be precise about this.** The flag only removes applause-limiter's precedence; every normal per-track gate still applies afterwards, and at −14 all four applause tracks measured **decline on their own**, at two gates in sequence. First the 6 dB attenuation ceiling: −14 needs 9.5 dB of capping on Truck and 11.8 dB on Anna May, both past `TCAP_MAX_GR`. Then, once a `--transient-cap-max-gr` override lifts that, engagement against `TCAP_REJECT_ENGAGE_PCT = 2.0` (Truck ~9%/0.15 s, Anna May ~4.7%/0.55 s, Plastic Lemons 3.9%/0.40 s, Kilkelly 3.2%/0.45 s — the percentage moves with the allowance, so read it from the run's log). Reaching −14 on them therefore needs **`--transient-cap-max-gr` and `--transient-cap-force` per track on top of the flag** — the same treatment the other 20 Cafe Java tracks got in that render, and the reason Rene's listening test is what sanctions it rather than the gate. Running the campaign with the flag alone leaves these tracks quiet, not capped. (At the −20 target the gains are far smaller and Truck does pass unforced — which is exactly why the flag must never be on for an ordinary publish; see below.)

Two measured corrections to the text above: applause does **not** top Truck's file (music peak −0.0 dB, no applause regions — its drums hit full scale in the source), so the 12.3% figure came from an already-limited copy, not from the applause skewing the screen; and the near-peak number is not what decides this — engagement is, exactly as this section already says.

**What is NOT changed:** the −20 archive. `--transient-cap-over-applause` is opt-in and belongs to the loud-variant campaign only; ordinary publishes never pass it, and Truck still renders at −23.65 through the applause path. Left automatic it would have moved Truck to −20.0 and Anna May to −22.26→−20.3 in the archive itself — caught and gated before shipping. The ban on frequent/sustained limiting of repeatedly-loud material therefore still stands for the archive; the exception is the loud variant alone, and `drum-control` remains unbuilt.

Note `/process/`'s public "linear gain only" claim needs a caveat sentence once a transient-capped show actually ships — don't let the public page contradict the archive's real provenance.

**The first sanctioned exception (workflow v5): applause-only limiting.** On audience tapes, a loud clap right at a split boundary can occasionally out-peak the music itself, forcing the whole track quieter than the *music* ever needed. `audio_process.py`'s applause-limiter mode (`plan["mode"] == "applause-limiter"`) tells a clap from music by behavior (crest factor + position near a track's head/tail, not just volume) and caps only that isolated transient, with the music underneath still getting one constant, untouched linear gain — the policy above is about never letting gain follow the performance itself, not about this. Don't read the ban as a mandate to remove or avoid the applause-limiter (v5) or transient-cap (v8, opt-in — see the amendment above) modes.

**4. Metadata:** `python3 scripts/draft_tracks.py <slug>` drafts `tracks[]` into `recordings.json` — durations/sizes from the processed files, songwriter+tags reused from the catalog, NEW/ambiguous titles FLAGGED (resolve the flags: originals = "Jerry Hannan & Sean Hannan", covers = writer, trad = "Traditional", unknown = omit; tags per `TAGS.md`; surface uncertain calls to Rene). Then by hand: neutral factual `description` (**list**, I write it by default), per-show `updates` note (`report: true`), and the **`/history/` narrative** (`scripts/content/history.html`).

**5. Build:** `python3 scripts/build.py` — fails on integrity problems (tag vocab, durations/R2 keys, missing peaks/sidecars, orphan `songs/` dirs with exact `git rm` commands) and **warns on rarity-tag drift** (rarity on songs with 3+ appearances — Rene's call, review don't auto-fix). `--check` = checks only; CI runs them before every deploy.

**6. Ship:** commit, push (auto-deploys via GitHub Action → `npx wrangler deploy` of the **`renedebos-site` Worker**, which serves renedebos.com: static assets + playlist short-link endpoints, config in `wrangler.jsonc`), watch the run, then **spot-check a URL only the new deploy can serve on renedebos.com itself** (green Action alone isn't proof). The `wav-download` Worker (`worker/index.js`) is a **separate** `wrangler deploy`. The old hannan-audio Pages project is retired — don't deploy to it.

Raw archive: whole-show WAV (untouched) + `labels.txt` = the raw per-song recipe; `python3 scripts/split_raw.py "<work folder>"` materializes raw unedited splits on demand — **never store them** (rule: store what hands made; derive what machines can remake). Pre-NR exports (hand edits minus NR) ARE stored: Drive-only, folder named `Tracks (pre-NR archive)/`.

Optional, after a batch of new shows: `python3 scripts/build_archive_zip.py` regenerates the site's "download the complete archive" snapshot (every curated FLAC, ~25 GB, into one R2 object) and rebuild afterward so the homepage's download line picks up the new counts/date. Manual and occasional — not part of CI or the publish runbook above; needs ~50 GB free local disk and can take a long time on a slow connection.

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
