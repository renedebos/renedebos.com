# Publishing a Show — Owner's Manual

*How a show gets from a whole-show WAV to renedebos.com, what you do
by hand, what Claude runs, and what every tool in `scripts/` is for.*
*Last updated: 2026-07-09 (matches workflow v2 — publish_show orchestration).*

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
| `publish_show.py prepare` | Finds the Work Folder, picks `Tracks/` vs `Tracks Noise Reduction/`, reads `notes.txt`, copies tracks, runs the **full diagnose** (loudness, true peak, dynamics, DC offset, clipping scan, DAT dropout scan, bandwidth-vs-sample-rate check, channel balance/phase on every track) | none |
| Diagnose review | Claude reads the verdicts | **Only if real clipping is found**: Claude sends the track list back to you — fix in Audacity, re-export those tracks, re-copy to Drive, say go. Benign/minor residual publishes as-is. |
| `publish_show.py publish` | Loudness-normalize every track to **−20 LUFS / −1 dBTP** (linear gain only — no compression, no EQ), make FLAC master + 320k MP3 with **embedded metadata tags** (title/artist/show/track/year, so downloads display properly in any player) and an MP3 true-peak check, upload to R2, generate waveform peaks, verify R2 MD5s against the provenance record, back up processed files to Drive `Processed/`, clean up | none |
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
| **`audio_process.py`** | The engine underneath: `diagnose` (per-track measurements + clipping/dropout/bandwidth/channel verdicts), `process` (the −20 LUFS loudnorm + tagged FLAC/MP3 + provenance sidecar), `verify` (R2 MD5s vs sidecar), `retag` (retro-fit tags without touching the audio), `status`/`history`/`versions` (what's been done to what, per track). |
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
- Tags live in the file&rsquo;s *container* (the envelope), not in the audio
  stream. Retagging is a container rewrite (`ffmpeg -c copy`): the audio
  bytes pass through untouched, so the **audio MD5 in the provenance sidecar
  stays valid** — `verify` proves after every retag that the music is
  bit-identical.
- Every retagged track is MD5-checked *before* upload; a track whose audio
  would change is refused.
- Where the tagged copies are: **R2** (streams + downloads). The website
  itself doesn&rsquo;t read the tags — pages render from the catalog. Drive
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
