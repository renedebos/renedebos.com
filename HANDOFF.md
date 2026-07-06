# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-05 · **Branch:** `main` (all work committed & pushed)

> This session **published the Mad Hannans New George's show**, fixed two title
> typos, and **built a new song-concordance section (`/songs/`)**. Everything is
> live (R2 + site); Rene has mirrored the New George's files to Drive. No open blockers.

## ✅ Done this session

### 1. `mad-new-georges-1999-10-13` — 14 tracks — PUBLISHED (commit `12cd83f`)
- **Two audience-DAT transfers existed** for this show. A/B-compared them (ffmpeg astats /
  ebur128 + a local A/B web player): the **apostrophe file** `MadHannans - New George's 1999-10-13.wav`
  is hotter (−20 LUFS integrated) but **clips** (true-peak +0.6 dBFS, flat-topped transients on the
  left channel, 2.8 dB L/R imbalance); the **underscore file** `MadHannans_NewGeorges_1999-10-13.wav`
  is cleaner (−24.4 LUFS, ~7 dB headroom, no clipping). Same performance/tone (LRA ≈ 20 both).
- **Rene chose the apostrophe transfer** (the site's main recording) for its sound, accepting the
  clipping. He split it in Audacity into 14 songs, **studio-faded the applause** on each, exported
  24-bit/48k FLAC to `Tracks/` (raw split kept in `Source/`).
- Processed all 14 to **−20 LUFS / −1 dBTP** (workflow v2, `filters: none`), uploaded FLAC + 320k MP3
  to R2, peaks generated, **R2 verified 14/14 md5 OK**, description + Updates note + a **"Week six"**
  history entry added. Track 1 is a soundcheck ("Scallywag").
- **Drive backup:** Rene moved `Tracks/`, `Source/`, and the processed masters to Google Drive himself.

### 2. Title-typo fixes — PUBLISHED (commits `6080143`, `8878db7`)
- **"Luxery" → "Luxury of Murder"** on **both** New George's (track 5) and Cafe Java (track 11):
  renamed the R2 objects (MP3 + FLAC), updated `recordings.json` titles/keys, renamed local files.
- **"Da Da Da" → "Da Da Da (Slave to an Angel)"** everywhere (part of commit `35b7278`): the standalone
  track on `mad-sweetwater-2000-02-17` (num 21). Note that show has a **file-prefix offset** on tracks
  19–21 (prefix = num−1), so its R2 key kept the `20 ` prefix: `20 Da Da Da (Slave to an Angel).*`.
  The separate **medley** "The Kiss - Da Da Da (Slave To an Angel)" was deliberately left alone.

### 3. New feature — Song concordance `/songs/` — PUBLISHED (commit `35b7278`)
- Cross-references every song across the 11 track-listed shows. **List view** (each song expands to
  every performance with an inline player + deep-link to that track) + **grid view** (songs × 11 shows,
  artist-colored dots), with sort (most-played / A–Z) and artist filter. **101 per-song pages**
  (`/songs/<slug>/`) for sharing/SEO. Added "Songs" to nav + sitemap.
- Built in `build.py`: `collect_songs()`, `build_songs_index()`, `build_song_page()`, dependency-free
  `scripts/songs.js`, styles in `scripts/site.css`. `player()` gained a `version=` arg (MD5 cache-bust).
- **Canonical/alias map lives in `build.py`** as `SONG_MANUAL_MERGE` + `SONG_CANONICAL_OVERRIDE`
  (curated with Rene: spelling merges, "ignore leading The", ABC+Sesame, German Clockwinder, Plastic
  Lemons, medley naming, Houses of the Holy = Me and Eddie Vedder, I Need a Lover = Lover + I Need a
  Dream, etc.). Re-derives on every build, so **new shows fold in automatically** — new title variants
  just need a one-line entry there. Scratch/audit: `~/work/song-concordance/` (`gen_aliases.py`, `REVIEW.md`).

## 🟥 Tooling gotchas (still real)
- **`pgrep -f '<script>.py'` self-matches the watcher** — hit it again this session. Match on the file
  PATH or use the bg-task notification, not a name that also appears in the watcher's own command line.
- **rclone uploads to `gdrive:` stall mid-file** — `--timeout` won't catch it; use a `--max-duration`
  retry loop, prefer local→Drive. [[rclone-drive-upload-stall]]
- **Audacity MCP is unreliable** — spaces in paths choke import, ambiguous `success:false`, once lost a
  track. Use for surgical hand-editing by Rene only; ffmpeg beats it for deterministic DSP. [[audacity-mcp-unreliable]]

## ⏭️ What's left in the archive
- `status`: **`done: 11, needs-processing: 20`.** All **track-listed** shows are `done`.
- The 20 `needs-processing` are **whole-show-only** shows (no split tracks yet) — they need **splitting
  into songs first**, then the normal pipeline (which auto-adds them to `/songs/`).
- Optional idea parked: a **covers-vs-originals filter** on `/songs/` using the per-track `tags`.
- Separate item (untouched): **`jerry-19-broadway-2001`** still carries a "not normalized yet"
  description line (recordings.json ~line 1057) — a different show.

## Durable facts (don't undo)
- **All artists → −20 LUFS, −1 dBTP ceiling.** [[mad-target-20]]
- **`gdrive:` = owner account `renedebos@hotmail` (5 TB). No `--drive-shared-with-me` anywhere.**
- `gdrive-mount/` is a **LOCAL copy**, not a live mount — edits must be rclone-pushed to Drive. [[metadata-editor]]
- **Song grouping for `/songs/` is curated in `build.py`** (`SONG_MANUAL_MERGE` / `SONG_CANONICAL_OVERRIDE`) —
  the authoritative map; the `~/work/song-concordance/` files are just scratch/audit.
- Engine `audio_process.py` (diagnose/process/verify/status/versions/history); `--eq "<chain>"` corrective
  EQ before loudnorm. `update_tracks.py` re-reads recordings.json right before writing (edit it AFTER uploads).

## Per-show publish (Phase 3) — reference
build tracks array in recordings.json → `update_tracks.py <slug> <processed>` (R2 + sizes/durations) →
`gen_peaks.py --slug` → Updates note + description → `status --write` → update `build_history()` →
`build.py` → commit/push → Drive mirror (`…/Processed`, max-duration retry loop) → `verify <slug>`.
Detail: `AUDIO_PROCESSING.md`. New shows automatically appear on `/songs/` after `build.py`.
