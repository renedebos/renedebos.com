# Page cleanup — layout, copy, and the standing text

**Started:** 2026-08-19 · **Branch:** `page-cleanup` (off `main` @ `675ece2`)
**Companion:** [`page-cleanup-inventory.md`](page-cleanup-inventory.md) — every
standing text block, its generator, and how many pages it reaches.

## 1. What this is

Rene's ask: tidy the page layout, move text blocks around, and maintain the
standing copy. Not a rewrite of the site — a pass over the text the *generator*
puts on every page, deciding for each one whether it still earns its place.

**This is not a phased project.** There is no dependency chain: every row in the
register below is an independent decision, cheap to make and cheap to revert.
What makes it finite is the inventory — the register covers what the inventory
found, and nothing keeps turning up afterwards.

**Every change is a template edit** in `scripts/sitegen/fragments.py` or
`pages.py`, then `make build`. There is no per-page HTML to edit; editing a file
under `shows/`, `songs/` or `assets/` is silently discarded by the next build.

## 2. Principles

Falling out of the three examples Rene named:

1. **Remove text that is constant across all pages.** A badge that reads the same
   on 30 of 30 pages is decoration that looks like data. It costs a reader
   attention every time and tells them nothing.
2. **Remove text that answers a question the visitor did not ask.** Internal
   processing state is interesting to us, not to someone who came to hear a
   1999 gig at 19 Broadway.
3. **Say a thing once per page.** Where the same fact appears three or four
   times, the fix is placement, not deletion of the fact.
4. **A UI element that explains itself needs no caption.** If the link says
   "open on show page", a sentence explaining that the link opens the show page
   is redundant.
5. **Prefer moving to cutting.** A fact that matters to a few visitors belongs
   behind the `<details>` or on `/process/`, not deleted.
6. **Policy commitments are not clutter** — see §3.

## 3. ⚠️ Explicit KEEPs — do not sweep these up

These read exactly like the boilerplate being cut. They are not.

| item | inventory | why it stays |
|---|---|---|
| Variant toggle note — "**You are hearing the Loud version** — an extra render at −14 LUFS…" | §2.13, §3.7, §5.11 | **Policy commitment.** `CLAUDE.md` → "The −14 loud variant": while Loud is the default playback variant, every page with a player must state in plain words which version is playing. Rene's 2026-08-18 decision made the default Loud *in exchange for* that disclosure. Removing it silently breaks the trade. |
| "**These figures describe the archive master** — the −20 LUFS files you download…" | §2.16 | Same commitment, at the point of measurement. Shipped in PR #21. Without it, "Target: −20 LUFS" reads as a claim about what the visitor is hearing, which is false by default. |
| `/process/` explanation of the variant's cost | §5.9 | Same commitment; `CLAUDE.md` names `/process/` specifically. |

Wording may be tightened. **The fact must remain stated in plain words on every
page that has a player**, for as long as Loud is the default.

## 4. Decision register

One row per item. `Rec` is my recommendation; `Decided` is Rene's call and is
what governs. Nothing is implemented until a row is decided.

Legend — **KEEP** · **CUT** · **MOVE** (elsewhere on the page / behind a
`<details>` / to another page) · **REWORD**.

### 4.1 The three Rene named

| # | item | reach | Rec | Why | Decided |
|---|---|---|---|---|---|
| A1 | "Audio processing · `done`" pill (§2.2) | 30/30 | **CUT** | Identical on every generated show page. A status badge whose value never varies is not status. The tech table already carries a `done` badge on its own summary for anyone who opens it. | |
| A2 | "All tracks brought to the archive's loudness target through the audio workflow." (§2.3) | 30/30 | **CUT** | Same element as A1, and the fact is stated properly on `/process/` and in the tech table's head. | |
| A3 | "Every song streams in full · lossless FLAC downloads are password protected" (§2.12) | 30/30 | **REWORD → "Every song streams in full."** | The streaming half is worth saying once above the track list. The password half is stated three more times on the same page (A4, A5, and the download button's own hover) — see 4.2. | |

If A1+A2 both go, `status_line()` becomes dead and `STATUS_BLURB` (§2.4) can go
with it. That is a code removal, recorded here so it is not rediscovered later.

### 4.2 Password-protection redundancy (measured, 4× per show page)

| # | item | reach | Rec | Why | Decided |
|---|---|---|---|---|---|
| B1 | "Full shows stream as 320 kbps MP3 — the lossless original download is password protected." (§2.19) | 30 | **REWORD → "Full shows stream as 320 kbps MP3."** | The bitrate is genuinely useful here; the password half is B2's job. | |
| B2 | "Full-show downloads are password protected. Streaming may take a moment to start for large files." (§2.21) | 30 | **KEEP** | Page-level, sits at the bottom where it belongs, and carries the one fact nothing else says (large-file start latency). Make this the single visible statement. | |
| B3 | Download-button hover "Download lossless FLAC (password protected)" (§2.26) | 30 | **KEEP** | Hover/accessible name, not body copy. Point-of-action is exactly where this belongs. | |

Net: password protection stated **once** in body copy per page, plus at the
point of click. Down from four.

### 4.3 Global chrome

| # | item | reach | Rec | Why | Decided |
|---|---|---|---|---|---|
| C1 | Eyebrow "The Hannan Tapes" above every `<h1>` (§1.4) | 174 | **CUT** (keep "· Song" as a song-page eyebrow, or fold into the tagline) | The site name is already in the header, the footer, the `<title>` and the browser tab. Four times per page. | |
| C2 | Footer "Part of **The Hannan Tapes** archive" (§1.6) | 174 | **REWORD** | Tells a visitor the page they are on is part of the site they are on. The footer *links* are useful; the sentence is not. | |
| C3 | Header mark reads "Shows" but links home (§1.2) | 174 | **discuss** | Either the wording or the destination is wrong. Low stakes, but it is the first thing on every page. | |

### 4.4 Show pages, remainder

| # | item | reach | Rec | Why | Decided |
|---|---|---|---|---|---|
| D1 | "About This Show" heading (§2.8) | 29 | **CUT heading, keep prose** | The paragraph is plainly about the show; the heading is a label on the obvious. | |
| D2 | Tech head bits — source, pre-edits, filters, workflow version, render summary (§2.15) | 30 | **KEEP** | Already behind a collapsed `<details>`. This is exactly where processing detail should live. | |
| D3 | "noise-reduced" / "pre-edited" pill beside the status pill (§2.5) | 7 / 1 | **MOVE** into the tech-table summary only | It *does* vary (8 of 30), so it is real information — but if A1 removes the line it sits on, it needs a home. It already appears on the tech summary. | |
| D4 | "corrective-eq" badge (§2.6) | 0 | **KEEP as code** | Zero reach today, but a real future state with a real trigger. No page cost. | |
| D5 | "Highlight show" (§2.7) | 2 | **KEEP** | Rare by design — that is what makes it worth reading. | |
| D6 | "Alternate transfers (N) — other digitizations of the same tape" (§2.20) | 17 | **KEEP** | Explains a genuinely non-obvious term, inside a collapsed summary. | |

### 4.5 Song pages

| # | item | reach | Rec | Why | Decided |
|---|---|---|---|---|---|
| E1 | "Every performance streams in full. "Open on show page" jumps to the song within its full set." (§3.6) | 136 | **REWORD → first sentence only** | The second sentence captions a link whose own text says what it does, on every row below it. | |
| E2 | tagline "Played N times across the archive" (§3.1) vs "Played N time(s) · `artists`" (§3.3) | 136 | **CUT the tagline** | Same fact twice, ~200px apart. The second carries the artists too. | |

### 4.6 Other pages

| # | item | reach | Rec | Why | Decided |
|---|---|---|---|---|---|
| F1 | `/contact/` tagline vs "Questions or comments about the recordings? Send a message below." (§5.6) | 1 | **CUT the sub** | Verbatim duplicate of the tagline plus an instruction the form makes obvious. | |
| F2 | `/playlist/` "How to build a playlist" — 3 paragraphs (§5.2) | 1 | **REWORD, shorter** | Genuinely useful (the cross-page selection bar is not discoverable), but long for a first read. | |
| F3 | `/archive-data/` 5-sentence intro (§5.7) | 1 | **KEEP** | Rene-facing tool page; the density is the point. | |
| F4 | `_curated_playlists_html()` (§5.3) | 0 | **KEEP as code** | Renders nothing while no playlists are defined; a real feature awaiting data. | |
| F5 | `/process/` "Last updated 2026-08-08" (§5.9) | 1 | **check** | Hand-bumped. If the variant rollout changed `process.html`'s substance, this is stale. | |

## 5. How to work it

1. Rene fills in `Decided` — or says "your call" per row.
2. Implement in **one or two commits**, not one per string: each is a rebuild.
3. `python3 scripts/build.py` then `--check`; eyeball one show page, one song
   page and the homepage locally before pushing.
4. Anything removed goes into **Appendix A verbatim**, in the same commit.
5. Push, watch the Action, then spot-check on renedebos.com itself — a green
   Action is not proof.

Housekeeping: `.claude/commands/review-step.md` still defaults to the
player-consolidation plan. Point it at this file before running `/review-step`,
or the review will confidently report on the wrong document.

## 6. Out of scope

- The three design systems stay separate (`home.css`, `site.css`, the
  `/process/` + `/manual/` inline style). Folding them together is a bigger,
  separate decision — see `CLAUDE.md` → "Site Styling & Templates".
- Per-show `description` prose and `/history/` (inventory §8) — maintained, not
  cleaned up. Handle those as ordinary editorial work.
- No changes to what the player does, what is rendered, or what is uploaded.

---

## Appendix A — removed copy, verbatim

Every string this project removes is recorded here in full, so restoring one
needs no git archaeology. Empty until the first change lands.

| date | item | verbatim text | generator it came from |
|---|---|---|---|
| — | — | — | — |
