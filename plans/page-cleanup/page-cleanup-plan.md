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

One row per item. `Rec` was my recommendation; **`Decided` is Rene's call and is
what governs** — where they differ, `Decided` won and the reason is recorded.

Legend — **KEEP** · **CUT** · **MOVE** (elsewhere on the page / behind a
`<details>` / to another page) · **REWORD**.

**Round 1 decided 2026-08-19, implemented the same day.** Rows marked ✅ are
live in the generator; ⬜ are open.

### 4.1 The three Rene named

| # | item | reach | Rec | Decided | Why |
|---|---|---|---|---|---|
| A1 | "Audio processing · `done`" pill (§2.2) | 30/30 | CUT | ✅ **CUT** | Identical on every generated show page. A status badge whose value never varies is not status. The `done` badge still renders on the technical-data summary, beside the numbers it describes. |
| A2 | "All tracks brought to the archive's loudness target through the audio workflow." (§2.3) | 30/30 | CUT | ✅ **CUT** | Same element as A1; the fact is stated properly in the tech table's head and on `/process/`. |
| A3 | "Every song streams in full · lossless FLAC downloads are password protected" (§2.12) | 30/30 | REWORD to the streaming half | ✅ **CUT entirely** | Rene went further than the recommendation: the play buttons and durations already say the songs are playable, so the whole line goes. |

`STATUS_BLURB` was deleted with A1/A2. `status_line()` survives but now renders
**only** the hand-work pills (see D3).

### 4.2 Password-protection redundancy (measured, 4× per show page)

| # | item | reach | Rec | Decided | Why |
|---|---|---|---|---|---|
| B1 | "Full shows stream as 320 kbps MP3 — the lossless original download is password protected." (§2.19) | 30 | REWORD | ✅ **REWORD → "Full shows stream as 320 kbps MP3."** | The bitrate is genuinely useful here; the password half is B2's job. |
| B2 | "Full-show downloads are password protected. Streaming may take a moment to start for large files." (§2.21) | 30 | KEEP | ✅ **KEEP** | Page-level, at the foot where it belongs, and carries the one fact nothing else says (large-file start latency). This is now the page's single body-copy statement. |
| B3 | Download-button hover "Download FLAC (password protected)" (§2.26) | 30 | KEEP | ✅ **KEEP** | Hover/accessible name, not body copy. Point-of-action is where this belongs. |

Net: password protection stated **once** in body copy per show page, plus at the
point of click. Down from four.

### 4.3 Global chrome

| # | item | reach | Rec | Decided | Why |
|---|---|---|---|---|---|
| C1 | Eyebrow "The Hannan Tapes" above every `<h1>` (§1.4) | 174 | CUT | ✅ **CUT**, song pages' "· Song" with it | The site name was already in the header mark, the footer, the `<title>` and the tab. The `eyebrow` parameter was removed from `page_shell()` and all 10 call sites, not just left unused. |
| C2 | Footer "Part of **The Hannan Tapes** archive" (§1.6) | 174 | REWORD | ✅ **CUT the sentence, keep the links** | Told a visitor the page they are on is part of the site they are on. Applied to the homepage's own footer too, which had the same sentence. |
| C3 | Header mark reads "Shows" but links home (§1.2) | 174 | discuss | ✅ **KEEP as "Shows"** | Accurate since `/archive/` folded into the homepage on 2026-07-19 — the homepage *is* the show listing. |

### 4.4 Show pages, remainder

| # | item | reach | Rec | Decided | Why |
|---|---|---|---|---|---|
| D1 | "About This Show" heading (§2.8) | 29 | CUT heading | ✅ **KEEP** | It is a landmark for screen readers and anchors the section visually. Overruled the recommendation. |
| D2 | Tech head bits (§2.15) | 30 | KEEP | ✅ **KEEP** | Already behind a collapsed `<details>` — exactly where processing detail belongs. |
| D3 | "noise-reduced" / "pre-edited" pill (§2.5) | 7 / 1 | MOVE to tech summary | ✅ **KEEP page-level, on its own line** | It genuinely varies (8 of 30), which is what makes it worth reading. `status_line()` now emits just the pills, and returns "" for the 22 shows with none, so no empty line is left behind. |
| D4 | "corrective-eq" badge (§2.6) | 0 | KEEP as code | ✅ **KEEP** | Zero reach today, but a real future state with a real trigger. No page cost. |
| D5 | "Highlight show" (§2.7) | 2 | KEEP | ✅ **KEEP** | Rare by design — that is what makes it worth reading. |
| D6 | "Alternate transfers (N) — other digitizations of the same tape" (§2.20) | 17 | KEEP | ✅ **KEEP** | Explains a genuinely non-obvious term, inside a collapsed summary. |

### 4.5 Song pages

| # | item | reach | Rec | Decided | Why |
|---|---|---|---|---|---|
| E1 | "Every performance streams in full. "Open on show page" jumps to the song within its full set." (§3.6) | 136 | first sentence only | ✅ **CUT entirely** | Consistent with A3 — the show-page equivalent went, so this one does too. |
| E2 | tagline "Played N times across the archive" (§3.1) vs "Played N time(s) · `artists`" (§3.3) | 136 | CUT the tagline | ✅ **CUT the tagline** | Same fact twice, ~200px apart; the surviving line carries the artists too. With C1 the song-page header is now just the song title. |

### 4.6 Other pages

| # | item | reach | Rec | Decided | Why |
|---|---|---|---|---|---|
| F1 | `/contact/` sub "Questions or comments about the recordings? Send a message below." (§5.6) | 1 | CUT the sub | ✅ **CUT the sub** | Verbatim duplicate of the tagline plus an instruction the form makes obvious. |
| F2 | `/playlist/` "How to build a playlist" — 3 paragraphs (§5.2) | 1 | tighten to 2 | ✅ **Tightened to 2** | The cross-page selection bar genuinely is not discoverable, so the facts stay; the third paragraph folded into the second as a clause. |
| F3 | `/archive-data/` 5-sentence intro (§5.7) | 1 | KEEP | ✅ **KEEP** | Rene-facing tool page; the density is the point. |
| F4 | `_curated_playlists_html()` (§5.3) | 0 | KEEP as code | ✅ **KEEP** | Renders nothing while no playlists are defined; a real feature awaiting data. |
| F5 | `/process/` "Last updated 2026-08-08" (§5.9) | 1 | check | ✅ **Bumped to 2026-08-18** | It was stale: `content/process.html` had substantive changes on 2026-08-09 (`227ea3b`) and 2026-08-18 (`e84646d`, the loud-variant rollout) after the stamp was last set. |

### 4.7 Still open

⬜ Nothing from the inventory is undecided. Later rounds — layout/placement
rather than copy, and the editorial items in inventory §8 — get their own rows
here.

## 5. How to work it

1. Rene decides the rows (round 1: done 2026-08-19).
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
needs no git archaeology. HTML entities are as they appeared in the source.

### Round 1 — 2026-08-19

**A1/A2 — the show-page audio-processing line** (`fragments.py`, `status_line()`
plus the whole `STATUS_BLURB` map). The element wrapped all of this:

```html
  <p class="proc-status-line">Audio processing<span class="proc-status status-{st}">{st}</span>{pills}<span class="proc-status-blurb">{blurb}</span></p>
```

```python
STATUS_BLURB = {
    "done": "All tracks brought to the archive's loudness target through the audio workflow.",
    "partial": "Some tracks brought to the archive's loudness target; the rest are pending.",
    "redo": "Previously processed outside the current workflow — queued to be re-processed to standard.",
    "needs-processing": "Not yet processed.",
}
```

Only `done` ever reached a page. The CSS rule `.proc-status-blurb` went with it;
`.proc-status.status-*` colours stayed (the badge still renders on the
technical-data summary).

**A3 — the show-page track hint** (`pages.py`), both branches:

> Every song streams in full &middot; lossless FLAC downloads are password protected

> Every song streams in full

The second branch (no-FLAC shows) never reached a page.

**B1 — the Full Recording hint** (`pages.py`), before → after:

> Full shows stream as 320&nbsp;kbps MP3 &mdash; the lossless original download is password protected.

> Full shows stream as 320&nbsp;kbps MP3.

**C1 — the eyebrow** (`fragments.py`, `page_shell()`), and the ten values passed
to it (`"The Hannan Tapes"` ×9, `"The Hannan Tapes &middot; Song"` on song
pages):

```html
    <p class="site-eyebrow">{eyebrow}</p>
```

CSS rule removed with it:

```css
.site-eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 1.2rem;
  font-weight: 400;
}
```

**C2 — the footer sentence**, in both shells. `fragments.py`:

```html
  Part of <a href="/">The Hannan Tapes</a> archive
```

`pages.py` (`HOME_SHELL`):

```html
    <span>Part of <a href="/">The Hannan Tapes</a> archive</span>
```

**E1 — the song-page hint** (`pages.py`):

> Every performance streams in full. &ldquo;Open on show page&rdquo; jumps to the song within its full set.

**E2 — the song-page tagline** (`pages.py`):

> Played {N} time{s} across the archive

**F1 — the /contact/ sub** (`fragments.py`, `contact_block()`):

```html
    <p class="contact-sub">Questions or comments about the recordings? Send a message below.</p>
```

CSS rule removed with it:

```css
.contact-sub {
  font-size: 14px;
  color: var(--muted);
  font-weight: 300;
  margin-bottom: 2rem;
}
```

**F2 — the /playlist/ help, third paragraph** (`pages.py`), removed as a
standalone paragraph and folded into the second as a clause:

> Your selection is saved as you go, so it survives a reload or a closed tab, and stays in sync if the site is open in more than one tab.

The first two paragraphs were also tightened. Previous text:

> Right here, the fastest way: pick filters below — artist, venue, source, tags — then either hit <strong>Generate playlist</strong> for an instant random set, or use the + button on individual results to hand-pick songs first.

> You can also build a selection while browsing the rest of the site: on any song's own page, click + next to a performance to add it. A bar at the bottom of the screen keeps a running count and stays there as you move between pages — browse to other songs from the <a href="/songs/">Songs</a> index or search, add more, and go back and forth as many times as you like. When you're ready, click <strong>Build playlist &rarr;</strong> in that bar to bring your picks here.
