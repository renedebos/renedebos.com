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
- **R2 show folders can hold orphaned duplicates under superseded filenames** — when a reprocess renames a track, the old key is left behind (measured 2026-08-17: 4 across the archive, e.g. a pre-rename `01 Highway Patrolman.flac` beside the published `01 State Trooper.flac`). **Never drive a batch job off `rclone lsf <prefix>`** — pull exactly the filenames `recordings.json` names (`--files-from`), or the job renders files that are not in the archive and mis-numbers the show. Drive `Processed/` accumulates the same way, plus clearly-labelled `... (superseded)` folders.
- **An empty result from a shell pipeline is not evidence of absence** — a mis-parsed path makes `rclone lsf` return nothing, which looks identical to "the file isn't there". Two false findings this project (a "all 31 work folders are missing labels.txt" that was a `sed` bug, and a `labels pt1.txt`/`labels pt2.txt` pair missed by an over-strict `grep`). Sanity-check a negative against something you know is true before reporting it.
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

When asked to "process/upload show X to the website," the show usually **already exists in `data/recordings.json` as a whole-show entry** (`tracks: null`, `processing_status: needs-processing`) — this upgrades it to track-listed. Rene's hand-edited tracks (fades + clip fixes, sometimes whole-show noise reduction) live in the show's Drive Work Folder: `Tracks/`, or `Tracks Noise Reduction/` when NR was applied. A `notes.txt` in the tracks folder (free text, e.g. NR settings) becomes the `pre_edits` provenance. Rene also exports the Audacity labels as `labels.txt` at the Work Folder root (raw-archive split recipe — remind him if missing; may be split as `labels pt1.txt`/`labels pt2.txt` when a show spans two `.aup3` projects). As of 2026-08-18 every show has them except `MadHannans - New Georges 1999-10-13`, which has no `.aup3` to export from — known and accepted. NR'd exports FLAC-compress ~2× larger (residual+dither entropy); normal, not a spec problem.

**A local UI exists for the transient-cap (v8) parts of this runbook** — `python3 scripts/tcap_ui.py [--port 8769] [--no-open]` serves a control panel at `http://127.0.0.1:8769/` (never deployed — `scripts/` is `.assetsignore`'d). It wraps the same underlying commands below (`publish_show.py prepare`/`publish`, `audio_process.py plan`), not a separate code path: **scan** the whole archive offline for cap candidates (loudness gap to target, no audio read), **analyze** a show per-track against either the published R2 audio (preliminary) or the prepared canonical source (after step 1 below — the analysis that actually supports publishing), and **reprocess** — streams `prepare`/`publish` logs live, with per-track accept/exclude/listen-first decisions persisted to `~/work/tcap-ui/<slug>/decisions.json` and passed through as `--transient-cap-accept`/`--transient-cap-exclude`. The engine's own gates (hard-blocking listen-flags, strict −1 dBTP check, 6 dB attenuation cap) remain the real safety barrier either way — the UI is a convenience layer on top, not a bypass. Editorial judgment (is a flagged title a typo or a real correction, does a capped moment sound right) is still a human/Claude call either way. Use the UI or the raw CLI commands below interchangeably — same state, same safety gates.

**1. Prepare (mechanical, one command):** `python3 scripts/publish_show.py prepare <slug>` — locates the Work Folder by show date (`--folder` if ambiguous), picks the tracks source (**NR folder wins; both populated = hard error, never guess**), reads `notes.txt` → pre-edits, copies tracks to `~/work/<slug>/tracks/` (local gdrive-mount copy preferred, else Drive), runs the **full diagnose** (always full — the clip-only mode decision is retired), and stops. Run in background (~5–10 min). State → `~/work/<slug>/publish.json`.

**2. Review the diagnose** — the only judgment gate: `CLIPPING` verdicts go back to Rene in Audacity; `benign`/`minor` and mild residual publish as-is; `HIGH_LRA` is informational. **`PRED_TP` is not informational** — see **Loudness policy** below, which is the controlling document for anything that changes a sample. **A `TITLE CHANGED` flag needs cross-referencing** (every prior appearance of that title anywhere in the archive, not just the fresh filename) before deciding typo-vs-real-correction. The moment that's decided as "keep the established spelling," run `python3 scripts/publish_show.py rename-track <slug> --track-num N --new-title "Correct Title"` immediately — **before** the first `publish` call, not after a failed one. Renaming by hand (`mv`) leaves `publish.json`'s fingerprint pointing at the old filename, so the very next `publish` correctly aborts with a fingerprint mismatch; `rename-track` updates the manifest/fingerprint to match in one step instead of requiring manual JSON surgery.

**3. Publish (mechanical, one command):** `python3 scripts/publish_show.py publish <slug>` — loudnorm to **−20 LUFS all artists** (with `--pre-edits` from notes), R2 upload (FLAC/MP3 under the Work Folder name, `--s3-no-check-bucket` handled), peaks, R2-MD5-vs-sidecar verify (aborts on mismatch), Drive `Processed/` backup (stall-aware retry loop), local tracks cleanup. Background, ~30–40 min for ~35 tracks. Benign LUFS-drift warnings (~0.5 dB) on very dynamic tracks are fine — don't reprocess. If Rene is at his computer and wants to do the Drive `Processed/` backup himself (manual copy is often faster than rclone there), pass `--manual-drive-backup`: it waits ~3 min polling Drive before falling back to the automated rclone copy — ask him first each time, since it's opt-in, not default. **The poll checks content, not just file count (fixed 2026-07-22)** — `drive_backup_matches()` runs `rclone check` (FLAC/MP3 hashes) plus a `processing_report.txt` presence check, so stale same-named leftovers from a prior run of the same show (e.g. a reprocess) can no longer satisfy it by count alone; a stale leftover now fails the check and triggers a real re-copy. Note this only overwrites/adds — it does not delete old-named orphans left behind by a prior run's stale files (e.g. a title that changed between runs), so after a reprocess still check Drive `Processed/` by eye (or `rclone lsl`) for old-dated duplicates under the previous filename and clean them up with `rclone delete` (same as R2 stale-file cleanup below — `rclone delete` against the `r2:` remote is agent-executable and pre-approved since 2026-08-11; still confirm with Rene before deleting anything on `gdrive:`, the source of truth). **`--tracks 3,7,14` scopes publish to just those track numbers** (added 2026-08-10) — for a show where most tracks already sit at target under an older workflow version and only a few are genuine v8 candidates (gap ≥1 dB), this avoids re-rendering/re-uploading the whole show for no audible benefit. Still requires a full `prepare` (and its diagnose review) first — only the render/upload/draft/backup stage is scoped.

**4. Metadata:** `python3 scripts/draft_tracks.py <slug>` drafts `tracks[]` into `recordings.json` — durations/sizes from the processed files, songwriter+tags reused from the catalog, NEW/ambiguous titles FLAGGED (resolve the flags: originals = "Jerry Hannan & Sean Hannan", covers = writer, trad = "Traditional", unknown = omit; tags per `TAGS.md`; surface uncertain calls to Rene). Then by hand: neutral factual `description` (**list**, I write it by default), per-show `updates` note (`report: true`), and the **`/history/` narrative** (`scripts/content/history.html`).

**5. Build:** `python3 scripts/build.py` — fails on integrity problems (tag vocab, durations/R2 keys, missing peaks/sidecars, orphan `songs/` dirs with exact `git rm` commands) and **warns on rarity-tag drift** (rarity on songs with 3+ appearances — Rene's call, review don't auto-fix). `--check` = checks only; CI runs them before every deploy.

**6. Ship:** commit, push (auto-deploys via GitHub Action → `npx wrangler deploy` of the **`renedebos-site` Worker**, which serves renedebos.com: static assets + playlist short-link endpoints, config in `wrangler.jsonc`), watch the run, then **spot-check a URL only the new deploy can serve on renedebos.com itself** (green Action alone isn't proof). The `wav-download` Worker (`worker/index.js`) is a **separate** `wrangler deploy`. The old hannan-audio Pages project is retired — don't deploy to it.

Raw archive: whole-show WAV (untouched) + `labels.txt` = the raw per-song recipe; `python3 scripts/split_raw.py "<work folder>"` materializes raw unedited splits on demand — **never store them** (rule: store what hands made; derive what machines can remake). Pre-NR exports (hand edits minus NR) ARE stored: Drive-only, folder named `Tracks (pre-NR archive)/`.

Optional, after a batch of new shows: `python3 scripts/build_archive_zip.py` regenerates the site's "download the complete archive" snapshot (every curated FLAC, ~25 GB, into one R2 object) and rebuild afterward so the homepage's download line picks up the new counts/date. Manual and occasional — not part of CI or the publish runbook above; needs ~50 GB free local disk and can take a long time on a slow connection.

Background jobs: pass a single command to `run_in_background: true` with **no** trailing `&`/`nohup` (double-backgrounding fires a false "completed"); poll for an explicit end-marker.

## Loudness policy (read this before touching any render path)

This is the most-amended part of the project and the easiest to get wrong.
It is stated as a rule rather than a preference for one reason: **the
over-processed version reliably sounds better in a short A/B.** That is a
property of human hearing, not a fact about the audio, and it is exactly why
a listening test alone must never be what authorises more compression. The
measurement is the guardrail; the ear is the veto, not the licence.

### The rule

**Never let gain follow the music.** The prohibited thing is frame-adaptive
normalization riding up on quiet passages over a timescale of **seconds** —
that is what flattens a hand-drawn fade or squashes a fingerpicked verse
against a strummed chorus. A quieter track is inaudible as a defect;
flattened dynamics are not.

These are acoustic live recordings with wide, intentional dynamics. The
**-20 LUFS** archive target is chosen for comfortable listening, not
competitive loudness, so there is never a reason to fight a track's true peak
to hit it exactly.

### Why loudnorm is a measurement tool only

ffmpeg's `loudnorm` applies true linear gain **only** when the gain needed
keeps true peak under the -1 dBTP ceiling. Otherwise it **silently falls back
to dynamic (frame-adaptive) normalization**, with zero warning in the logs
(`-loglevel error` swallows it). Workflow v4 detects this via the same math
diagnose uses for `PRED_TP` (`I - TP - 1` = the track's own safe "max linear
target") and renders at that reduced target instead.

**Workflow v6 (2026-07-16) removed the reliance on loudnorm's render
entirely.** Linear and linear-reduced tracks compute the gain from a
measurement pass and apply it with a plain, unconditional `volume` filter — no
fallback mode exists for `volume`, so a hidden dynamic-mode render is
impossible in principle, not merely unlikely. **loudnorm/ebur128 are
measurement-only. Never make either the render step again.** See
`WORKFLOW_VERSIONS[4]` and `[6]`.

### Sanctioned exception 1 — applause-limiting (v5)

On audience tapes a loud clap at a split boundary can out-peak the music,
forcing the whole track quieter than the *music* ever needed.
`plan["mode"] == "applause-limiter"` tells a clap from music by behaviour
(crest factor + position near head/tail, not volume alone) and caps only that
isolated transient; the music underneath still gets one constant linear gain.
The ban is about gain following the *performance* — this is not that.

### Sanctioned exception 2 — sparse transient-cap (v8, opt-in)

A **millisecond-scale true-peak cap on isolated transients** acts three orders
of magnitude below the fade/phrase timescale and cannot do the harm the ban
exists to prevent. Sanctioned 2026-08-08 on loudness-matched blind A/Bs across
two independent shows (`mad-cafe-java-1999-09-09`, `mad-sweetwater-1999-05-18`
— five tracks including a hand-drawn fade): inaudible at up to 5.9 dB of
recovery, **LRA moved <= 0.3 LU**.

Recorded in provenance as mode `sparse-transient-cap` — the sparsity is the
point, and the name stays distinct from any future repeated-drum treatment.
Strictly opt-in per show (`--transient-cap`, never default). Gated per track
in three tiers, on **engagement, not near-peak density** (revised 2026-08-08
after the Hear Me case — engagement is what the A/B evidence actually
sampled):

| tier | density | engagement | longest event |
|---|---|---|---|
| **auto** | <= 2% | <= 1% | <= 0.2 s |
| **review** (capped, hard-blocked until Rene listens) | <= 5% | <= 2% | <= 0.5 s |
| **declined** | beyond that | | |

Plus: >= 1 dB and <= 6 dB of recovery; applause-limiter takes precedence;
`--transient-cap-exclude` is Rene's per-track veto, `--transient-cap-force`
his after-listening override.

The **6 dB cap is enforced on the limiter's actual instantaneous
attenuation** (Rene's 2026-08-08 disambiguation) — a track needing more shave
gets its gain trimmed and lands <= ~0.5 dB shy of nominal, never over-shaved.
A track needing > 6 dB stays linear-reduced unless opted into
`--transient-cap-partial` per track — never automatic.

Non-negotiable safety: a post-render true-peak assertion against a **strict
-1.00 dBTP** (no QA tolerance in this mode) that **deletes the output and
aborts**; render state persisted beside each output so a resume proves its
chain; "listen before shipping" flags that **hard-block the run** until
accepted (`--transient-cap-accept`) or excluded; full guardrail provenance
(max/p95 reduction, engaged %, event count, longest event and its timestamp,
source LRA) surfaced in `/archive-data/`. See `WORKFLOW_VERSIONS[8]`.

### Amended 2026-08-18 — the -14 loud variant ships up to 3.1 LU

The loud-variant campaign (`plans/loudness-variants/`) rendered **all 680
tracks at -14 LUFS**, forced past the engagement and attenuation gates on
Rene's explicit instruction. This is a real widening of the policy and must
not be quietly reverted:

- The v8 sanction above was written around **<= 0.3 LU** of LRA movement.
  The -14 variant moves LRA by a **median 0.50 LU, worst 3.10 LU**.
- 673 of 680 tracks are capped; 67% engage the limiter for longer than 0.5 s,
  23% for longer than 1 s, worst single event **1.95 s**.
- Validated by blind, loudness-matched listening on 2026-08-18: the **eight
  worst tracks in the archive plus two null controls** (`linear` tracks, where
  matching makes both sides the same audio). Rene heard no difference on any
  of the ten.
- Sensitivity was then verified with a **graded positive control** on one
  track (`Open Door`, the -3.10 LU worst case): null / real variant (-3.2 LU) /
  moderate 4:1 (-6.1 LU) / extreme 20:1 (-13.1 LU). Rene detected the extreme
  and the moderate, not the real variant.

**State the conclusion honestly, because it is bounded:** the cap is
*inaudible to Rene on his monitoring at up to 3.1 LU*, with detection
demonstrated at 6.1 LU. The threshold is bracketed between 3.2 and 6.1 LU. It
is **not** "measurably inaudible", and nothing here licenses going further.

Note also that on the moderate control Rene described the **compressed** side
as sounding *more* dynamic. That is the classic short-A/B effect and the
reason this section opens the way it does. **Do not treat a future "sounds
fine" as authorisation to shave harder.** If more aggression is ever
proposed, test it over a full track, twice through, on separate days — not
with an A/B switch.

### What is NOT changed: the -20 archive

`--transient-cap-over-applause` belongs to the loud-variant campaign **only**.
Ordinary publishes never pass it. Left automatic it would move `Truck` from
-23.65 to -20.0 and `Anna May` to -20.3 **in the archive itself**. The archive
remains -20 LUFS, linear-first, and is still the default and the download
default.

Two measured corrections to older wording: applause does **not** top Truck's
file (music peak -0.0 dB, no applause regions — its drums hit full scale in
the source), so the old "12.3% near-peak" figure came from an already-limited
copy; and near-peak density is not what decides a track — engagement is.

### Still banned, no exceptions

- loudnorm dynamic mode, or any equivalent seconds-scale gain riding.
- Frequent/sustained limiting of repeatedly-loud material **in the -20
  archive**. A `drum-control` proposal exists in `codex-notes.md` and is
  deliberately **not built** — it needs its own decision and its own evidence.

## The -14 loud variant (`MP3-14/`)

A second, louder render of every curated track, added 2026-08-18. The -20
archive is unchanged and remains **the master and the download**, but is no
longer what the player streams by default.

**Rene's decision 2026-08-18: Loud is the DEFAULT playback variant**, sticky
site-wide via `localStorage` (`hannanVariant`). This reverses
`plans/loudness-variants` §1, which had the archive as default — the reversal
is deliberate, because -20 LUFS is too quiet on phone speakers and in a car,
and most visitors never touch a toggle. **The trade is disclosure:** every page
with a player states in plain words which version is playing, and `/process/`
explains the cost. Do not remove that note while Loud remains the default, and
do not quietly flip the default back. The variant is MP3-only.

**Amended 2026-08-19: the -14 variant is downloadable too**, on Rene's
request. It is **never the default** — the password modal's version chooser
opens on Archive every time, deliberately not remembering the last choice,
because the two are different *formats* (lossless FLAC vs 320 kbps MP3), not
just different levels, and a sticky preference would quietly hand out lossy
files for the rest of a session. The chooser hides itself where no -14 render
exists (whole-show recordings), and a ZIP offers the loud option only when
**every** file in it has a variant — a silently mixed archive is
indistinguishable from a correct one once unpacked. A loud ZIP renames its
own folder and info file and appends a provenance note, so an unpacked copy
can never be mistaken for the master. Policy and evidence: **Loudness policy**
above.

**Rolled out on every player surface (2026-08-18).** One preference module
(`scripts/variant-pref.js`) is the single source of truth; show pages, song
pages, `/songs/` and `/playlist/` all read it, as does
the legacy `player.js` fallback engine (via the `window.HannanVariant` bridge
and the `hannanvariantchange` DOM event, since classic scripts cannot import).
`data-src` in the markup stays the **archive** URL on every row — the variant
URL rides in `data-item`'s `loudUrl` — so any page whose module fails to mount
degrades to the master, never to a key that may not exist. Whole-show recording
cards have no -14 render and always play the archive.

**Derived from the published -20 archive FLACs, never re-staged from Drive.**
This is a correctness decision, not a cost one: re-staging is the operation
that destroyed hand-edited fades on 2026-08-11 and caused the "Hear Me" ->
"I Need a Lover" drift. Deriving from the archive makes variant-vs-archive
disagreement structurally impossible — same edits, same NR, same fades — and
makes the variant reproducible by anyone from public files.

**That derivation is enforced, not assumed.** Every variant track records
`src_md5` (the decoded audio md5 of its input); the archive sidecar's `md5` is
the same quantity for the published FLAC. The runner asserts
**`variant.src_md5 == archive.md5`** per track and fails the show on any
mismatch. Keep that assertion.

- **R2 keys:** `MP3-14/<Work Folder>/NN Title.mp3`, filename byte-identical to
  its `MP3/` counterpart, so the variant key is a one-token swap from the
  archive key. A parallel top-level prefix (like `FLAC/`, `MP3/`) keeps it
  listable, checkable and deletable as one unit.
- **No Worker change is needed.** `handleStream()` in `worker/index.js` takes
  an arbitrary key and refuses only `.wav`/`.flac`. Verified against
  production: a `MP3-14/` key returns 206 `audio/mpeg`; a `FLAC/` key still
  returns 403.
- **Variant provenance lives in `data/processing/variants/loud-14/<slug>.json`,
  never the archive's sidecar.** `audio_process.py process --slug X` *merges
  into* `data/processing/<slug>.json`, so a variant render using the default
  path would silently overwrite the -20 archive's provenance with -14 numbers.
  Always pass `--provenance-out`. `version-map` reads the archive sidecars and
  must not be pointed at the variants tree.

### Tooling

```bash
python3 scripts/render_variant.py --list           # plan, touch nothing
python3 scripts/render_variant.py --jobs 5         # render (resumable)
python3 scripts/render_variant.py --upload         # push to R2 + rclone check
python3 scripts/variant_outliers.py --top 15       # rank by LRA delta
python3 scripts/variant_listen.py --top 8 --controls 2   # blind A/B set
```

**Rank listening candidates by LRA delta, not engagement.** On archive input
the near-peak/engagement screens measure against a yardstick the first limiter
pass already lowered, so every track reads artificially dense. LRA is what
says whether the dynamics survived.

**Always build listening tests loudness-matched, as MP3, with both sides
re-encoded identically**, and include null controls (`linear` tracks, where
matching makes the two sides the same audio). A null control catches false
positives only — to catch a false negative you need a **positive** control,
i.e. a deliberately over-compressed version you *should* hear. A test without
one cannot detect its own insensitivity.

Costs, measured: ~5.7 GB in R2; ~81 s per track to render (CPU-bound, roughly
serial per show — parallelise across shows); ~3.2 h for 680 tracks at 5-way
concurrency; R2 transfer is ~36 MB/s down, ~11 MB/s up and is **not** the
bottleneck.

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
