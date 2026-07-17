# Publishing a Show — Owner's Manual

*How a show gets from a whole-show WAV to renedebos.com, what you do
by hand, what Claude runs, and what every tool in `scripts/` is for.*
*Last updated: 2026-07-16 (matches workflow v6 — explicit-gain rendering,
LRA QA on every track, PLR/max-loudness provenance, MP3 true-peak trim; see
Part 5 for the full version history).*

---

## Part 1 — Your steps, in order

### Stage A · Audacity (all you, all judgment)

1. **Set up the Work Folder** on Google Drive:
   `DAT Tapes/Work Folder/<Artist> - <Venue> <date>/`
   (e.g. `JerryHannan - 19 Broadway 1999-03-29`). Put the whole-show WAV
   there. Work on the local copy under `~/gdrive-mount/`.

2. **Import the WAV into Audacity** and do the whole show in one project:
   - a **label** at every song's boundaries (this is the most valuable thing
     you make — see step 4);
   - **fade-in** at each song start, **studio fade-out** on the applause;
   - **clip repairs** on the loudest peaks where needed.

3. **Noise reduction — only when the tape needs it.** Apply NR across the
   **whole show** (one noise profile for the whole tape), ideally before the
   fade-outs, or check the faded tails after.

> **Before you apply NR:** export the untreated tracks once into
> **`Tracks (pre-NR archive)/`**. Hand edits without NR can't be regenerated
> later — this is the only chance to keep them.

4. **Export the labels**: *File → Export → Labels* → save as **`labels.txt`**
   in the Work Folder root, next to the WAV. It's a 2 KB text file and it is
   the raw archive's split recipe: WAV + labels can regenerate untouched
   per-song files forever, even if Audacity or `.aup3` files are long gone.
   The pipeline checks for this file at both of its stages and nags until it
   exists — it never blocks a publish, but don't let the nag scroll by.

5. **Export the tracks**: *File → Export → Export Multiple*, split by labels,
   **FLAC**, numbered filenames (`01 Title.flac`, `02 Title.flac`, …) into:
   - **`Tracks/`** — the normal case;
   - **`Tracks Noise Reduction/`** — if and only if you applied NR.

> **Rule:** exactly one of those two folders may contain audio. The pipeline
> refuses to run if both do — it never guesses which set is canonical.

6. **If you treated the tape** (NR or anything else non-standard), drop a
   one-line **`notes.txt`** inside the tracks folder with the settings, e.g.
   `noise reduction 6 dB, sensitivity 5`. That exact text flows automatically
   into the show's provenance record and the Technical data table on the site
   — nobody has to remember or retype it.

7. **Save the `.aup3` project** in the Work Folder and **copy everything up
   to Google Drive** via the ChromeOS Files app (your usual way). Drive is
   the source of truth; Claude verifies against it, not against your local
   copy.

8. **Tell Claude:** *"process/publish show X to the website."* That's the
   handoff.

### Stage B · The pipeline (Claude, automatic — you just answer questions)

| Step | What happens | Your involvement |
|---|---|---|
| `publish_show.py prepare` | Finds the Work Folder, picks `Tracks/` vs `Tracks Noise Reduction/`, reads `notes.txt`, copies tracks, runs the **full diagnose** (loudness, true peak, dynamics, DC offset, clipping scan, DAT dropout scan, digital click/discontinuity scan — defects reported with exact timestamps — bandwidth-vs-sample-rate check, channel balance/phase on every track; `--spectrograms` adds a PNG per track for visual inspection of suspect tapes) | none |
| Diagnose review | Claude reads the verdicts | **Only if real clipping is found**: Claude sends the track list back to you — fix in Audacity, re-export those tracks, re-copy to Drive, say go. Benign/minor residual publishes as-is. |
| `publish_show.py publish` | Loudness-normalize every track to **−20 LUFS / −1 dBTP**: plain linear gain when the track allows it, one constant linear boost sized to the *music* with only applause transients gently capped when applause (not the music) is what's loudest, or an honest quieter linear target when neither applies — never a compressor-style squash (see [Loudness normalization](#loudness-normalization) below). Make FLAC master + 320k MP3 with **embedded metadata tags** (title/artist/show/track/year) and an MP3 true-peak check, upload to R2, generate waveform peaks, verify R2 MD5s against the provenance record, back up processed files to Drive `Processed/`, clean up | none |
| `draft_tracks.py` | Drafts the track list into `recordings.json`: durations, sizes, and each song's established songwriter + tags reused from the catalog | **Answer the flags**: titles new to the archive need your songwriter/tags call |
| Words | Claude writes the show description, the Updates note, and the `/history/` paragraph | edit afterwards if you want (`make edit`) |
| Build + ship | `build.py` (fails on integrity problems, warns on stale `rarity` tags), commit, push, watch the deploy, spot-check the live page | none |

### Stage C · Afterwards (optional, whenever)

- **Review drafted tags/songwriters** in the metadata editor (`make edit` or
  the "Hannan Metadata Editor" launcher), save, then tell Claude to rebuild
  and push.
- **Rarity drift warnings** from the build (a song tagged `rarity` that now
  has 3+ appearances) are yours to adjudicate — untag or keep.
- If you kept a pre-NR archive: the **Drive copy stays forever**, the local
  copy gets deleted after publish.
- **Reclaim disk space**: `python3 scripts/publish_show.py cleanup <slug>`
  deletes the local working copies — but only after verifying the show is
  live on the site, complete on R2, and backed up on Drive. It refuses
  otherwise.

### Loudness normalization

**Policy: linear gain only, never dynamic (compressor-style) processing —
no exceptions.** These are acoustic live recordings with wide, intentional
dynamics (quiet fingerpicked verses next to loud strummed choruses,
hand-drawn fade-outs); the −20 LUFS target is chosen for comfortable
listening, not competitive loudness, so there's never a reason to squash a
track's dynamics to hit it exactly. `process` decides per track, in order:

1. **Plain linear** — the show's nominal target (−20 LUFS for every artist)
   fits under the −1 dBTP ceiling with a single constant gain. Most tracks.
2. **Linear, reduced target** — the nominal target would push true peak past
   the ceiling by a small margin (≤ 2 dB). Instead the track takes its own
   honest "max linear target" (the same number `diagnose` reports as
   `PRED_TP`'s max linear target) — a few dB quieter than its neighbors,
   always still one constant gain, dynamics untouched. (Workflow v6: the gain
   for both of these cases is computed once from a measurement pass and
   applied with ffmpeg's plain `volume` filter, never `loudnorm` at render
   time — earlier versions asked `loudnorm` for the target and trusted its
   own linear/dynamic decision, which past this margin would silently fall
   back to dynamic normalization and flatten a hand-drawn fade with nothing
   in the logs to show it. v6 removes that decision from the render step
   entirely, so it can't happen no matter how close to the margin a track
   sits.)
3. **Applause-limited** — some audience tapes had the mic close to the
   crowd, and a clap can peak louder than anything in the music itself,
   forcing option 2 several dB quieter than the music needs. When the
   overshoot is large, the loudest moments are located and classified by
   *behavior*, not loudness: a window counts as applause only if it sits
   within `min(30s, track-length/6)` of the very start or end (tracks are
   split from one continuous tape — applause lives at those boundaries,
   never mid-song) **and** either towers ≥ 27 dB over its own local average
   (a clap's signature — sustained music measures 19–22 dB) or beats the
   loudest moment in the song's body by ≥ 2 dB (catches a final chord ringing
   out under the applause, which would otherwise hide the clap signature).
   If applause is what's eating the headroom, the music gets one constant
   gain sized to the music's own peaks — the limiter is mathematically
   incapable of touching anything classified as music — with a lookahead
   limiter engaging only on the applause. Ambiguous cases (a loud moment
   mid-song, or where limiting would barely help) fall back to option 2 and
   are flagged for a listen.
4. **True-peak safety loop** (applause-limited tracks only) — the limiter
   caps *sample* peaks, but the archive's −1 dBTP ceiling is a *true*
   (oversampled) peak; on hot transients the two can disagree by a few
   tenths of a dB. So the applause-limited render is measured after the
   fact, and if the real output overshoots, the gain is backed off and
   re-rendered (up to 5 attempts) — the ceiling is never trusted to the
   limiter's math alone.

Every track's processing sidecar (`data/processing/<slug>.json`) records
which of the above it got and *why*, in plain language — that's the
Treatment column (hover for the reasoning) in each show's Technical data
table. A `python3 scripts/audio_process.py plan <folder> --artist <name>`
dry run shows every decision for a folder of tracks without writing any
audio — useful before committing to a reprocess.

**QA gates (workflow v6):** output loudness range (LRA) is compared against
the source's on *every* track, not just applause-limited ones — a linear
gain can't change dynamic range at all, so any drift is the one thing that
would reveal a hidden dynamics change regardless of which mode produced it.
The provenance sidecar also records `plr` (true peak minus integrated
loudness) and `max_m`/`max_s` (peak momentary/short-term loudness) per
track — two tracks can share the same integrated loudness while one has a
much louder chorus the average smooths over, which is what actually
predicts a track sounding louder next to its neighbors in a playlist. The
MP3 derivative gets its own small, independent gain trim (the FLAC master
is never touched) if lossy encoding would push its true peak past the
ceiling, iterated the same way the applause safety loop is.

---

## Part 2 — The tools

Everything lives in `scripts/` in the renedebos.com repo. **"Who runs it"**
tells you whether you ever need to touch it.

### The two you actually use

| Tool | What it does | Who runs it |
|---|---|---|
| **`make edit`** (`edit_metadata.py`) | Browser editor for `recordings.json`: titles, descriptions, tags, songwriters, opt-in update notes. Machine fields (paths, durations, sizes) are read-only. Saves make a backup first. | **You.** Then ask Claude to rebuild + push (or run `make build` and commit yourself). |
| **`split_raw.py`** | Cuts the whole-show WAV at the `labels.txt` boundaries into raw, unedited per-song FLACs — sample-accurate, no fades, no processing. For when you want to hear or re-edit the untouched version of a song. Generated on demand; never archived. | **Either.** Ask Claude, or yourself: `python3 scripts/split_raw.py "<work folder>"` |

### The pipeline (Claude runs these — listed so you know what's happening)

| Tool | What it does |
|---|---|
| **`publish_show.py`** | The orchestrator. `prepare <slug>` = locate + copy + diagnose, then stop for review. `publish <slug>` = normalize → R2 → peaks → verify → Drive backup. `cleanup <slug>` = delete the local work copies, but only after verifying the show is live, complete on R2, and backed up on Drive. One human gate in the middle, everything else automatic. |
| **`audio_process.py`** | The engine underneath: `diagnose` (per-track measurements + clipping/dropout/bandwidth/channel verdicts), `plan` (dry run — every track's normalization decision, no audio written; see [Loudness normalization](#loudness-normalization)), `process` (the −20 LUFS loudnorm + tagged FLAC/MP3 + provenance sidecar), `verify` (R2 MD5s vs sidecar), `retag` (retro-fit tags without touching the audio), `status`/`history`/`versions` (what's been done to what, per track). |
| **`draft_tracks.py`** | Drafts `tracks[]` metadata from the processed files + the existing catalog; flags anything needing a human call. |
| **`gen_peaks.py`** | Precomputes the waveform shapes the player draws. Runs inside `publish`. |
| **`build.py`** | Generates the whole site from `recordings.json` + content fragments. Fails on integrity problems (bad tags, broken paths, missing peaks/sidecars, orphan song pages); warns on rarity drift. CI runs the same checks before every deploy. |
| **`clipcheck.py`** | The old standalone clip-only pass. Superseded — full diagnose is always run now — but still works for a quick one-off check of any folder. |
| **`update_tracks.py`** | For re-publishing already-listed shows after re-processing (e.g. a loudness standard change). Rarely needed. |
| **`make refresh` / `diff` / `status` / `upload`** | Whole-show WAV bookkeeping between Drive and R2 (the original archive layer, separate from split shows). |

### Conventions worth remembering

- **Folder meanings**: root WAV + `labels.txt` + `.aup3` = raw archive ·
  `Tracks/` or `Tracks Noise Reduction/` = your hand-edited export (pipeline
  input) · `Tracks (pre-NR archive)/` = untreated export kept when NR was
  used · `Processed/` = pipeline output backup (audio-identical to what's on
  the site; tags are reproducible from the catalog via `retag`). Anything
  suffixed **"(… superseded)"** is a retired earlier generation — draft
  exports or old processing runs — kept for the record, never used by the
  pipeline (archive-wide cleanup 2026-07-10).
- **The storage rule**: *store what hands made; derive what machines can
  remake.* Raw splits are never stored (WAV + labels regenerate them); your
  edits always are.
- **Provenance**: every processed show has `data/processing/<slug>.json` —
  the exact settings and measurements per track — rendered as the "Technical
  data" table on the show page. NR shows get a blue **noise-reduced** badge.
  A per-track **Treatment** column (workflow v5+) shows which normalization
  mode the track got, with the plain-language reasoning on hover; a `—`
  means the track predates v5 and hasn't been reprocessed yet.

> **Drive is the source of truth.** `~/gdrive-mount` is an ordinary local
> folder; nothing syncs by itself — you copy up via the Files app, Claude
> verifies against real Drive.

---

## Part 3 — Metadata: the catalog and the tags inside the files

The archive has **two metadata layers**. Everything editorial lives in one
place; the audio files carry a derived copy so downloads look right in any
player.

| Layer | Where it lives | Who reads it | How you edit it |
|---|---|---|---|
| **The catalog** — `data/recordings.json` | the site's git repo | every page of the website (built from it), the playlist, search, the technical tables | `make edit` → Save → build + push |
| **Embedded tags** — inside each FLAC/MP3 | the file copies on R2 (what people stream and download) | music players, phones, car stereos, anything that opens a downloaded file | never by hand — regenerated from the catalog with `retag` |

> **The catalog is the single source of truth.** The embedded tags are a
> derived copy, written by the pipeline. If the two ever disagree, the
> catalog wins and a `retag` makes the files match it.

### What's embedded in every track

| Tag | Example | Comes from |
|---|---|---|
| `title` | Open Door | the catalog title (falls back to the filename at first processing, before the catalog entry exists) |
| `artist` / `album_artist` | Sean Hannan | the catalog's artist entry |
| `album` | 19 Broadway — February 21, 2000 | catalog venue + display date |
| `track` | 1/11 | track number / show total |
| `date` | 2000 | show date (year) |
| `comment` | The Hannan Tapes (renedebos.com) — loudness-normalized to −20 LUFS | fixed provenance note |

### The technical part

- **FLAC** files store tags as **Vorbis comments** (the FLAC-native tag
  block); **MP3** files use **ID3v2.3** (chosen over 2.4 for maximum player
  compatibility). ffmpeg writes both from the same generic keys.
- Tags live in the file’s *container* (the envelope), not in the audio
  stream. Retagging is a container rewrite (`ffmpeg -c copy`): the audio
  bytes pass through untouched, so the **audio MD5 in the provenance sidecar
  stays valid** — `verify` proves after every retag that the music is
  bit-identical.
- Every retagged track is MD5-checked *before* upload; a track whose audio
  would change is refused.
- Where the tagged copies are: **R2** (streams + downloads). The website
  itself doesn’t read the tags — pages render from the catalog. Drive
  `Processed/` backups from before 2026-07-10 are untagged (deliberate: tags
  are reproducible in one command, so ~8 GB of Drive re-uploads bought
  nothing); shows published after that date carry tags everywhere.

### Changing metadata, end to end

1. **Edit the catalog**: `make edit` → change titles, venue, dates, artist
   credits, songwriter, tags → Save.
2. **Update the site**: build + push (or ask Claude) — the pages now show
   the new values.
3. **Update the files**: `python3 scripts/audio_process.py retag <slug>
   --force` — re-derives every tag for that show from the catalog and
   rewrites the file envelopes on R2. A few minutes per show; audio provably
   untouched.

> **Never edit tags directly in the files** (with a tag editor or
> otherwise). The next `retag` would overwrite your edit, and the R2 copy
> would silently disagree with the catalog. Change the catalog; let the
> pipeline propagate it.

---

## Part 4 — Site operations

Reference facts about how the site itself runs. Nothing here is a
per-show step; it matters when something breaks or gets upgraded.

### How deploys work

| What | How it deploys |
|---|---|
| **The site** (`renedebos-site` Worker: all pages, assets, playlist short links) | Automatically on every push to `main`: the GitHub Action runs the integrity checks, verifies the committed output matches a fresh build, then deploys. The Action's dependencies are version-pinned on purpose — bump them deliberately, never implicitly. |
| **The download/stream worker** (`wav-download`, in `worker/`) | Automatically too (since 2026-07-10): a second Action fires on any `worker/**` change on `main`. Manual fallback if ever needed: `cd worker && npx wrangler deploy --config wrangler.toml`. |

> **Important: a green Action is not proof the site works.** After a deploy,
> always spot-check a URL only the new deploy can serve, on renedebos.com itself.
> **`?cache-bust` query strings and client `Cache-Control: no-cache` headers
> don't reliably bypass Cloudflare's edge cache on this site** (confirmed
> 2026-07-13, twice: a `/shows/*/` page and, in a later deploy, `/history/`
> both kept serving `cf-cache-status: HIT` with pre-deploy content through
> several cache-busted requests, while other pages in the same deploys came
> back fresh). It isn't tied to one route pattern — any page that already had
> a cached copy sitting at the edge can keep serving it past a deploy. So:
> after any deploy, spot-check the pages you actually changed, not a
> different page in the same deploy — freshness elsewhere doesn't prove
> anything about the page you care about. If a checked page still shows old
> content, purge it by hand: dashboard → **Caching → Configuration → Purge
> Cache → Custom Purge**, paste the exact URL (or **Purge Everything** if
> multiple pages from the same deploy are affected). The deploy Action's
> `CLOUDFLARE_API_TOKEN` is scoped to Workers deploy only — it can't purge
> cache, so this step has to be manual.

### Security posture (hardened 2026-07-10)

- Every site response carries security headers (HSTS, CSP, nosniff,
  frame/referrer policies).
- The WAV download password can't be brute-forced quickly: constant-time
  comparison, a 1-second delay per wrong guess, and a per-minute attempt
  budget. The password's strength is still the real defence.
- Playlist short-link creation is capped per IP per day (re-sharing an
  existing playlist doesn't count against it).
- Lossless files can't be reassembled through the streaming endpoint —
  it refuses WAV/FLAC keys outright.

### If things go wrong

- **R2 audio lost or corrupted**: every processed file is on Drive under
  `<show>/Processed/`. Re-upload, run `retag --all --force` (pre-2026-07-10
  Drive backups have no embedded tags), then `verify <slug>` per show —
  zero mismatches required.
- **A show sounds wrong on the site**: `verify <slug>` compares the live R2
  audio against the provenance MD5s and pinpoints any drifted track.
- **The site itself**: everything is in the git repo — pages, assets,
  data, workers. A `git push` (or `wrangler rollback` for a bad worker
  version) restores it.
- **Raw archive**: whole-show WAVs + `labels.txt` + `.aup3` projects live
  on Drive; the tapes themselves remain the last resort.

---

## Part 5 — Appendix: audio processing version history

Every processed track records which workflow version produced it (`ver` in
`data/processing/<slug>.json`) and the literal ffmpeg chain applied
(`chain`) — so one show can hold a mix of versions if a single track is ever
reprocessed later on a newer engine. `scripts/audio_process.py`'s
`WORKFLOW_VERSIONS` dict is the source of truth; this appendix is its
human-readable decode. To see which workflow version (and every other spec
field — loudness, true peak, LRA, tags, damage flags) has actually landed on
each track across the whole archive at once, filterable and sortable, see
[Archive Data](/archive-data/) — not linked from the main nav, bookmark it
directly.

| Version | Introduced | What changed | Loudnorm mode |
|---|---|---|---|
| v1 | 2026-06-28 | Baseline: two-pass linear loudnorm to the per-artist target (all artists −20 LUFS), −1 dBTP ceiling, optional HPF/LPF/hum notch, derived 320k MP3. Recommend-only — no automatic limiter/compressor/denoise. | Linear only |
| v2 | 2026-06-29 | Added an optional literal corrective-EQ chain (`--eq`) for restoring poor source recordings (de-mud, presence, air shelf), recorded verbatim in the track's `chain`. | Linear only |
| v3 | 2026-07-09 | Embedded metadata tags (title/artist/album/track/date/comment) into both the FLAC master and MP3; added a true-peak check of the encoded MP3 (lossy encoding overshoots peaks); `retag` retro-fits tags onto already-published shows without touching the audio stream or its provenance MD5. | Linear only |
| v4 | 2026-07-12 | Fixed a silent ffmpeg fallback: `linear=true` is only a *request* — if the target would push true peak past the ceiling, ffmpeg quietly switches to dynamic (frame-adaptive) normalization instead, which can flatten hand-drawn fades with zero warning in the logs. A track whose predicted true peak exceeds the ceiling is now processed at its own safe "max linear target" instead, staying in true linear mode. | Linear only (per-track reduced target when needed) |
| v5 | 2026-07-13 | Added applause-aware headroom recovery for audience tapes where a clap peaks louder than the music itself. Peaks are classified by *behavior* (position near a track's head/tail + crest factor), never loudness alone; if applause is what's eating the headroom, the music gets one constant gain sized to the music's own peaks, with a lookahead limiter that only applause transients can reach. A measure-and-correct loop verifies the actual rendered true peak and re-renders (up to 5 attempts) if it overshoots — the limiter's own threshold is never trusted blind. Ambiguous cases fall back to the v4 reduced target. | Linear, or applause-limiter mode (music untouched, only applause capped) |
| v6 | 2026-07-16 | Linear/linear-reduced tracks now render with an explicit `volume=<gain>dB` gain instead of asking `loudnorm` for the target — the gain is computed once from a measurement pass and applied unconditionally, so a silent dynamic-mode render is no longer possible in principle, not just avoided by construction. The output LRA-preservation QA gate now runs on every track (previously applause-limiter tracks only). Provenance gains `plr` and `max_m`/`max_s` per track. The MP3 derivative gets its own independent gain trim (never touching the FLAC master) if lossy encoding would clip its true peak, iterated like the applause safety loop. | Linear only via `volume`; applause-limiter mode unchanged from v5 |

### v1 — the linear baseline

Two-pass `ffmpeg loudnorm` to a fixed per-artist target
(`I=<target>:LRA=11:TP=-1:linear=true`), all artists at −20 LUFS (Mad
Hannans moved from −16 to −20 after A/B testing showed −16 forced
non-linear processing on band masters with no audible loudness gain).
Optional 80 Hz high-pass, 18 kHz low-pass, and a 60 Hz hum notch. Output
mirrors the input container plus a derived 320k MP3. Deliberately
recommend-only: no automatic limiter, compressor, or denoise — those remain
hand-editing territory in Audacity.

### v2 — corrective EQ

Same audio engine as v1, plus an optional literal ffmpeg EQ chain (`--eq`),
prepended before the loudnorm stage, for restoring a poor source recording
(e.g. de-mud + presence + air shelf on a muffled tape). The exact filter
chain is recorded verbatim in the track's `chain`, so only tracks actually
processed with `--eq` differ from v1's output.

### v3 — embedded tags + MP3 true-peak check

Audio processing unchanged from v2. Added embedded metadata tags
(title/artist/album/track/date/comment, sourced from `recordings.json`)
into both the FLAC master and the derived MP3, plus a true-peak measurement
of the *encoded* MP3 — lossy encoding can overshoot the original peak, so
this is recorded per-track as `mp3_tp` and flagged above 0 dBTP. `retag`
retrofits tags onto already-published shows via a container rewrite
(`-c copy`) that never touches the audio stream, so the provenance MD5
stays intact.

### v4 — the silent-fallback fix

The most consequential fix in the series. `linear=true` is only a *request*
to ffmpeg's `loudnorm` filter — if hitting the target would push true peak
past the −1 dBTP ceiling, ffmpeg silently falls back to dynamic
(frame-adaptive) normalization instead, a compressor-like mode that rides
gain up on quiet passages and can flatten a hand-drawn fade-out, with no
warning at all in the logs (`-loglevel error` swallows it). From v4 on, any
track whose predicted true peak overshoots the ceiling (the same math
`diagnose`'s `PRED_TP` flag already reports) is processed at its own honest
"max linear target" (`I − TP − 1`) instead — a few dB quieter than its
neighbors, but always one constant linear gain. Recorded in the provenance
sidecar as `target_lufs` whenever it differs from the show's nominal
target.

### v5 — applause-aware headroom recovery

Calibrated on "Butter" (`jerry-cafe-java-1999-03-25` track 4): on audience
tapes the mic often sat close to the crowd, and a single clap can peak
6+ dB above anything in the music, alone forcing v4's reduced target
several dB quieter than the music itself needs. When the predicted
overshoot exceeds 2 dB, the loudest windows are classified by *behavior*,
never raw loudness: a window can only be applause if it falls within
`min(30s, track-length/6)` of the track's very start or end (tracks are
split from one continuous tape — applause lives at those boundaries, never
mid-song), **and** either towers ≥ 27 dB over its own local RMS (a clap's
signature; sustained music measures 19–22 dB) or beats the loudest window
in the song's body by ≥ 2 dB (catches a final chord ringing out under the
applause). If applause is confirmed as what's eating the headroom, the
music gets one constant gain sized to the music's own peaks — the limiter
is mathematically incapable of reaching anything classified as music —
with a lookahead limiter (`alimiter`, threshold −1.2 dBTP) engaging only on
the applause tail. Because `alimiter` thresholds *sample* peaks while the
archive's ceiling is a *true* (oversampled) peak, the render is measured
after the fact and, if it overshoots, the gain is backed off and
re-rendered (up to 5 attempts) — the limiter's math is never trusted
blind. Ambiguous cases (a loud moment mid-song, or where limiting would
recover less than 1 dB) fall back to v4's reduced target and are flagged
for a listen. QA gate: output LRA must match source LRA within 0.5 LU.

This is a narrow, sanctioned exception to the "never limit the music" rule,
not a reversal of it — it caps only the applause transient, never the
performance itself. See `CLAUDE.md`'s linear-normalization policy note for
the full reasoning.

### v6 — explicit-gain rendering and broader QA

Every prior version still handed `loudnorm` a target LUFS at render time and
trusted its own internal choice between linear and dynamic (frame-adaptive)
normalization — v4 and v5's whole design is built around *engineering* that
choice so it always lands on linear (the reduced target, the applause-sized
gain), but the decision at render time was still ffmpeg's to make. v6
removes that decision from the render step entirely: `plan_track`'s
measurement pass computes the exact gain a track needs (the same math v4/v5
already used), and the render applies it with ffmpeg's `volume` filter — an
unconditional multiply with no fallback mode to fall into. `loudnorm` and
`ebur128` remain in the pipeline purely as measurement tools. Re-running the
two tracks used to validate this (one linear-reduced, one applause-limiter)
produced byte-identical applause-limiter output to v5 (that code path is
untouched) and a slightly *more* precise linear-reduced result — the old
`loudnorm`-based render for "Plastic Lemons" landed 0.42 dB under the
ceiling it was engineered to just reach; the explicit-gain render lands
within 0.02 dB of it, using the headroom the plan already calculated was
safe.

Three QA additions ride along with the same change:

- The **output LRA-preservation check** (source vs. rendered loudness range,
  0.5 LU tolerance) now runs on every track, not just applause-limiter
  ones. A linear gain cannot change dynamic range at all — on any other
  track, a shift would mean something rode the gain during render, which
  after this change should be structurally impossible, but a QA gate that
  only watched the one mode capable of nuance was never really guarding the
  other two.
- The provenance sidecar gains **`plr`** (true peak minus integrated
  loudness) and **`max_m`/`max_s`** (the loudest 400ms/3s window in the
  track) alongside the existing `lufs`/`tp`/`lra`. Two tracks can share the
  same integrated loudness while one has a much louder chorus the average
  smooths straight over — that's what actually predicts a track sounding
  louder than its neighbors in a mixed playlist, which integrated loudness
  alone can't show.
- The **MP3 derivative** gets its own small, independent gain trim — the
  FLAC master's gain is never touched — if the lossy encode's true peak
  would otherwise clip on decode, iterated up to 3 times the same way the
  applause true-peak loop already re-renders and re-measures rather than
  trusting a single pass.
