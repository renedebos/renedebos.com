# Page-cleanup inventory — every standing text block on the site

**Generated:** 2026-08-19 · **Branch:** `page-cleanup` · **Basis:** `675ece2`

Mechanically derived: generator `file:line` from `scripts/sitegen/`, reach counted
from `data/recordings.json` + `data/processing/` + the built `shows/` and `songs/`
trees. **Regenerate the counts before acting on a row** — they are a snapshot.

"Standing text" = copy that the *generator* writes, not per-show editorial content
(`description`, `updates` entries, `/history/` prose). Editorial content is in
scope for the project but is not boilerplate, so it is listed separately in §8.

## Page census

| page type | count | shell |
|---|---|---|
| Show pages (`/shows/*/`) | **30** | `page_shell()` |
| Song pages (`/songs/*/`) | **136** | `page_shell()` |
| Standalone shell pages (`/songs/`, `/search/`, `/playlist/`, `/updates/`, `/history/`, `/contact/`, `/archive-data/`, 404) | **8** | `page_shell()` |
| **`page_shell()` total** | **174** | |
| Homepage `/` | 1 | `HOME_SHELL` |
| `/process/` | 1 | `PROCESS_SHELL` |
| `/manual/` | 1 | `MANUAL_SHELL` |
| `/player/` | 1 | `PLAYER_SHELL` |
| **Site total** | **178** | |

One show is hidden and generates no page (`jerry-western-saloon-2025-07-03`,
track-less). Every count below is over *generated* pages.

---

## 1. Global chrome — `page_shell()`, reach 174

| # | text | generator | reach | notes |
|---|---|---|---|---|
| 1.1 | "Skip to content" | `fragments.py:335` | 174 | a11y affordance, visually hidden |
| 1.2 | Header mark **"Shows"**, aria-label "Shows — The Hannan Tapes home" | `fragments.py:339` | 174 | the logo slot says "Shows" but the link is home |
| 1.3 | Nav: Songs · Playlist · Search · Updates | `fragments.py:373-379`, `site_nav()` `:388` | 174 | Home omitted deliberately (the mark covers it) |
| 1.4 | Eyebrow **"The Hannan Tapes"** above every `<h1>` | `fragments.py:348`, value passed per page | 174 | constant on 173 of 174; song pages pass "The Hannan Tapes · Song" |
| 1.5 | Per-page `tagline` under the `<h1>` | `fragments.py:350` | 174 | see §2.1, §3.1, §5 for the values |
| 1.6 | Footer: "Part of **The Hannan Tapes** archive" | `fragments.py:359` | 174 | says the page is *part of* the site it is on |
| 1.7 | Footer links: The Story So Far · The Process · Contact · RSS | `fragments.py:360-365` | 174 | `/manual/` and `/archive-data/` deliberately absent |

## 2. Show pages — reach 30 unless noted

| # | text | generator | reach | notes |
|---|---|---|---|---|
| 2.1 | tagline "`City, California · date · source`" | `pages.py:967-972` | 30 | |
| 2.2 | **"Audio processing · `done`" pill** | `fragments.py:559-581` (`status_line`) | **30 of 30** | every generated show page reads `done` |
| 2.3 | **"All tracks brought to the archive's loudness target through the audio workflow."** | `fragments.py:553` (`STATUS_BLURB["done"]`) | **30 of 30** | same element as 2.2 |
| 2.4 | `STATUS_BLURB` `partial` / `redo` / `needs-processing` | `fragments.py:554-556` | **0** | unreachable on the live site today |
| 2.5 | "noise-reduced" / "pre-edited" pill | `fragments.py:520`, emitted `:574` | 7 / 1 | 22 shows show neither |
| 2.6 | "corrective-eq" pill | `fragments.py:536` | **0** | no show has `filters` |
| 2.7 | ★ "Highlight show" line | `pages.py:772` | **2** | |
| 2.8 | "About This Show" heading | `pages.py:778` | 29 | 1 show has no `description` |
| 2.9 | "Tracks · N songs · `total`" | `pages.py:909` | 30 | |
| 2.10 | "Select all" | `pages.py:911` | 30 | |
| 2.11 | "Download ZIP" + hover "Download all N tracks (.zip) · N MB" | `fragments.py:148-150` | 30 | |
| 2.12 | **"Every song streams in full · lossless FLAC downloads are password protected"** | `pages.py:904` | **30 of 30** | the `else` branch ("Every song streams in full") reaches **0** |
| 2.13 | Variant toggle + **"You are hearing the Loud version…"** note | `fragments.py:995-1024` | 30 | **policy KEEP — see plan §3** |
| 2.14 | "Technical data — loudness, peaks & sizes" summary + status/pre-edit badges | `fragments.py:722` | 30 | collapsed by default |
| 2.15 | Tech head bits: "Target: −20 LUFS · −1.0 dBTP true-peak ceiling", render summary, transient-capped / applause-limited counts, source, pre-edits, workflow version, date, "how these tracks were made" | `fragments.py:646-667`, `_render_summary` `:583` | 30 | 28 shows show a transient-cap count, 16 an applause count |
| 2.16 | **"These figures describe the archive master…"** scope line | `fragments.py:626-631` | 30 | **policy KEEP — see plan §3** |
| 2.17 | Tech table column heads (#, Song, Time, MP3, FLAC, In LUFS, Out LUFS, Gain, True Pk, LRA, Treatment, Ver) | `fragments.py:726-728` | 30 | |
| 2.18 | "Full Recording" / "Full Recording · N parts" | `pages.py:933` | 30 | 6 shows have >1 canonical part |
| 2.19 | **"Full shows stream as 320 kbps MP3 — the lossless original download is password protected."** | `pages.py:935-936` | **30** | |
| 2.20 | "Alternate transfers (N) — other digitizations of the same tape" | `pages.py:956` | 17 | |
| 2.21 | **"Full-show downloads are password protected. Streaming may take a moment to start for large files."** | `pages.py:963-964` | **30** | |
| 2.22 | "dropouts" badge + "Significant tape damage — audible dropouts" | `pages.py:840-841` | 11 tracks | |
| 2.23 | Track-info popup labels (Artist, Song, Venue, Date, Format, Size, Process version) | `pages.py:826-834` | 30 | hover/tap only |
| 2.24 | Group divider label | `pages.py:806` | **1** show | |
| 2.25 | Recording-card meta labels (Source, Format, Size) | `pages.py:929`, `fragments.py:198` | 30 | |
| 2.26 | Download button hover "Download lossless FLAC (password protected)" | `fragments.py:177-178` | 30 | a **fourth** statement of the same fact |

> **Measured redundancy:** items **2.12, 2.19, 2.21 and 2.26** all tell the visitor
> that lossless downloads are password protected — three of them in visible body
> copy, on all 30 show pages. 2.19 and 2.21 both describe the *full-show* download
> specifically, within ~30 lines of rendered output.

## 3. Song pages — reach 136

| # | text | generator | reach | notes |
|---|---|---|---|---|
| 3.1 | eyebrow "The Hannan Tapes · Song", tagline "Played N times across the archive" | `pages.py:1181-1182` | 136 | tagline duplicates 3.3 |
| 3.2 | "← All songs" | `pages.py:1155` | 136 | |
| 3.3 | "Played N time(s) · `artists`" | `pages.py:1167` | 136 | 41 pages read "Played 1 time" |
| 3.4 | "Also listed as: …" | `pages.py:1160` | **31** | |
| 3.5 | "Select all" + "Download ZIP" | `pages.py:1169-1170`, `fragments.py:920` | 136 | |
| 3.6 | **"Every performance streams in full. "Open on show page" jumps to the song within its full set."** | `pages.py:1173` | 136 | second sentence explains a link that is visible on every row |
| 3.7 | Variant toggle + note | `fragments.py:995` via `:1173` | 136 | **policy KEEP** |
| 3.8 | Per-occurrence "open on show page →" | `fragments.py:889` | 136 (every row) | what 3.6's second sentence describes |
| 3.9 | Occurrence info-popup labels (Title, Venue, Date, Source, Duration, Size, Process version) | `fragments.py:875-883` | 136 | |

## 4. Homepage — reach 1

| # | text | generator | notes |
|---|---|---|---|
| 4.1 | Hero eyebrow "Live · DAT-sourced · primarily 1998–2003" | `pages.py:128` | |
| 4.2 | Lede "Live recordings of Jerry Hannan… hiss and all." | `pages.py:130` | |
| 4.3 | Buttons "Play random tape" / "Build a playlist" | `pages.py:134,138` | |
| 4.4 | "Every Show" + "N SHOWS · N SONGS · N TRACKS" | `pages.py:144-145` | |
| 4.5 | Sort bar "Sort · Date / Artist / Venue" | `pages.py:150-154` | |
| 4.6 | "Download the complete archive · N tracks · N GB FLAC · updated `date`" | `pages.py:195-199` | |
| 4.7 | Two info cards from `content/why.html` + `content/about.html`, with "Read the full story" / "Read more" | `pages.py:22-35, 86-87` | teaser paragraph + `<details>` |
| 4.8 | Footer + artist notes | `pages.py:168-171` | different footer text from §1.6 |

## 5. Other standalone pages

| # | page | text | generator |
|---|---|---|---|
| 5.1 | `/search/` | tagline "Find a song, show, venue, or date"; noscript fallback (2 paragraphs); "Search runs in your browser, so it needs JavaScript."; "Looking for loudness, true peak, workflow version, or damage flags instead? See Archive Data." | `pages.py:208, 224-240` |
| 5.2 | `/playlist/` | tagline "Roll your own set list from the archive"; intro paragraph; **"How to build a playlist"** `<details>` — 3 paragraphs; 3 preset button labels; "Filters" / "Clear filters"; status "Loading the track catalog…"; 5 action button labels | `pages.py:295, 309-332` |
| 5.3 | `/playlist/` | curated-playlists block ("Playlists" label + rows) | `pages.py:245-272` — **renders nothing: 0 playlists defined** |
| 5.4 | `/updates/` | tagline "Recently added to the archive"; per-entry "Added `show` — N split tracks"; "view data" link | `pages.py:347`, `fragments.py:745-782` — **96 entries** |
| 5.5 | `/history/` | tagline "A behind-the-scenes history of the archive"; body = `content/history.html` | `pages.py:364-366` |
| 5.6 | `/contact/` | tagline "Questions or comments about the recordings"; sub "Questions or comments about the recordings? Send a message below."; form labels; status strings | `pages.py:709`, `fragments.py:787-833` — tagline and sub say the same thing |
| 5.7 | `/archive-data/` | tagline + a 5-sentence intro paragraph | `pages.py:680, 686` |
| 5.8 | 404 | "Page not found" + explanation + 3 links | `pages.py:1193-1207` |
| 5.9 | `/process/` | crumb, "The Process", sub "From DAT tape to show page, step by step.", "Last updated `PROCESS_UPDATED`" (**hand-bumped, currently 2026-08-08**), body = `content/process.html` | `pages.py:372, 460-467` |
| 5.10 | `/manual/` | crumb, "Publishing a Show — Owner's Manual", sub, TOC, body = `PUBLISHING.md` | `pages.py:590-601` |
| 5.11 | `/player/` | "♪ Player", "Build a playlist →", variant toggle + note | `pages.py:651-657` |

## 6. Repeated meta / SEO copy

| # | text | generator | reach |
|---|---|---|---|
| 6.1 | `<title>` suffix "— The Hannan Tapes" | every `build_*` | 174 |
| 6.2 | Show `description` meta "`Title`, `date` — `source`. Stream or download." | `pages.py:1013` | 30 |
| 6.3 | Song `description` meta "`Song` — N live performance(s) by `artists` in the Hannan archive." | `pages.py:1180` | 136 |
| 6.4 | OG/Twitter title+description mirror `title`/`description` | `fragments.py:320-328` | 174 |

## 7. Dead or near-dead copy (reach 0–2)

Not necessarily removable — some are genuine future states — but each is copy no
visitor currently sees:

- `STATUS_BLURB` `partial` / `redo` / `needs-processing` (§2.4) — **0**
- "corrective-eq" badge (§2.6) — **0**
- `pages.py:905` "Every song streams in full" (the no-FLAC branch of §2.12) — **0**
- `_curated_playlists_html()` (§5.3) — **0**
- `.track-row .progress-range` fallback branch — **0** pages (noted in HANDOFF)
- "Highlight show" (§2.7) — **2**
- Track group divider (§2.24) — **1**

## 8. Editorial (not boilerplate) — in scope, decided per item

| what | where | volume |
|---|---|---|
| Per-show "About This Show" | `data/recordings.json` → `description` | 29 shows; 1–4 paragraphs (12 shows have 3) |
| Updates feed entries | `data/recordings.json` → `updates` + auto "Added …" | 96 entries |
| `/history/` narrative | `scripts/content/history.html` | standing weekly task |
| Homepage cards | `scripts/content/why.html`, `about.html` | 2 fragments |
| `/process/` body | `scripts/content/process.html` | + hand-bumped date stamp |
| `/manual/` body | `PUBLISHING.md` | rendered every build |
