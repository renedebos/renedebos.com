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

3. **Noise reduction — only when the tape needs it:**
   - *Before* applying NR, export the untreated tracks once into
     **`Tracks (pre-NR archive)/`** — hand edits without NR can't be
     regenerated later, so this is the only chance to keep them.
   - Apply NR across the **whole show** (one noise profile for the whole
     tape), ideally before the fade-outs, or check the faded tails after.

4. **Export the labels**: *File → Export → Labels* → save as **`labels.txt`**
   in the Work Folder root, next to the WAV. It's a 2 KB text file and it is
   the raw archive's split recipe: WAV + labels can regenerate untouched
   per-song files forever, even if Audacity or `.aup3` files are long gone.

5. **Export the tracks**: *File → Export → Export Multiple*, split by labels,
   **FLAC**, numbered filenames (`01 Title.flac`, `02 Title.flac`, …) into:
   - **`Tracks/`** — the normal case;
   - **`Tracks Noise Reduction/`** — if and only if you applied NR.

   **Rule: exactly one of these two folders may contain audio.** The pipeline
   refuses to run if both do — it never guesses which set is canonical.

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
| `publish_show.py prepare` | Finds the Work Folder, picks `Tracks/` vs `Tracks Noise Reduction/`, reads `notes.txt`, copies tracks, runs the **full diagnose** (loudness, true peak, dynamics, DC offset, clipping scan on every track) | none |
| Diagnose review | Claude reads the verdicts | **Only if real clipping is found**: Claude sends the track list back to you — fix in Audacity, re-export those tracks, re-copy to Drive, say go. Benign/minor residual publishes as-is. |
| `publish_show.py publish` | Loudness-normalize every track to **−20 LUFS / −1 dBTP** (linear gain only — no compression, no EQ), make FLAC master + 320k MP3, upload to R2, generate waveform peaks, verify R2 MD5s against the provenance record, back up processed files to Drive `Processed/`, clean up | none |
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
| **`publish_show.py`** | The orchestrator. `prepare <slug>` = locate + copy + diagnose, then stop for review. `publish <slug>` = normalize → R2 → peaks → verify → Drive backup → cleanup. One human gate in the middle, everything else automatic. |
| **`audio_process.py`** | The engine underneath: `diagnose` (per-track measurements + clipping verdicts), `process` (the −20 LUFS loudnorm + FLAC/MP3 + provenance sidecar), `verify` (R2 MD5s vs sidecar), `status`/`history`/`versions` (what's been done to what, per track). |
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
  used · `Processed/` = pipeline output backup (identical to what's on the
  site).
- **The storage rule**: *store what hands made; derive what machines can
  remake.* Raw splits are never stored (WAV + labels regenerate them); your
  edits always are.
- **Provenance**: every processed show has `data/processing/<slug>.json` —
  the exact settings and measurements per track — rendered as the "Technical
  data" table on the show page. NR shows get a blue **noise-reduced** badge.
- **Drive is the source of truth.** `~/gdrive-mount` is an ordinary local
  folder; nothing syncs by itself — you copy up via the Files app, Claude
  verifies against real Drive.
