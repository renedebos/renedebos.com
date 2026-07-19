# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-19 · **Branch:** `main` — everything below is committed & pushed, deploy verified live on renedebos.com itself (not just green Action).

> Front-end/architecture session, no audio processing. Rene noted the
> archive is now fully split (every show track-listed) — which meant the
> homepage's "Recently Added" 6-card teaser had lost its reason to exist,
> since new shows will land rarely from here on. Talked through the
> tradeoffs, built an interactive Artifact mockup, iterated on it live with
> Rene through several rounds of feedback, then implemented the approved
> design for real: merged the old `/archive/` page into the homepage as a
> single sortable show listing.

## ✅ Done this session

### Homepage/Archive merge (commit `fc2f280`)
The core change: `/archive/` no longer exists as a separate page. The
homepage (`/`) now shows the full 30-show catalog directly below the hero,
sortable by **date, artist, or venue** (venue is new — the old archive page
only had artist/date). `/archive/` 301-redirects to `/` (`site_worker.js`
`LEGACY_REDIRECTS`) for existing bookmarks/search-index entries; dropped
from nav everywhere via `SITE_PAGES` in `scripts/sitegen/fragments.py`.

**Design, arrived at through several mockup rounds with Rene:**
- Kept the homepage's own "tape deck" look (`home.css`), not `site.css` —
  ported the archive's *sorting capability*, not its visual system.
- Default view is a **9-card collapsed preview**, not the full 30 — but
  every group actually represented in those 9 cards gets its real header
  and true count shown up front (e.g. "Jerry Hannan · 16 SHOWS"), not just
  after clicking "Show all N shows". This took two iterations to get
  right: first attempt showed all headers for every group regardless of
  whether their cards were visible (rejected — too much upfront), second
  attempt dropped headers entirely from the collapsed view (rejected —
  Rene specifically wanted the count visible without expanding). Final:
  walk groups in original order, stop adding groups once the 9-card budget
  is hit, only show headers for groups actually contributing a card.
- Cards got smaller: dropped the "added" date (dead weight once "recently
  added" stopped being the framing) and the artist tag (redundant — the
  card's own `<h3>` already says the artist name). Source (AUD/SBD) and
  NR/PE pre-edit badges shrunk from full pills to small inline badges.
  Highlight star moved inline with the title instead of a separate tag row.
  Grid went from 3 to 4 columns on desktop as a result.
- **Why/About stays below the listing, not above** — deliberately not
  moved despite Rene questioning it once mobile scroll depth came up (a
  30-show single-column mobile list is a long scroll to reach it). Fixed
  the actual problem (scroll depth) with the 9-card collapse instead of
  relocating the section — the hero already orients a first-time visitor,
  and most visits (especially repeat ones, likely common given the
  personal nature of this project) just want the shows.
- Sort choice persists across visits via localStorage (`homeSort` key),
  same pattern the old archive page's toggle used.
- Legend (NR/PE/Highlight explainer) and the old subtitle sentence under
  "Every Show" were both explicitly cut on Rene's request mid-review.

**Technical shape:** rendered client-side by new `scripts/home.js` from a
new `assets/home-shows.json` (via `build_home_shows()` in
`scripts/sitegen/feeds.py`) — same pattern `/search/` and `/playlist/`
already use, not server-prerendered toggle blocks like the old archive
page. Chosen deliberately over prerendering every sort/collapsed/expanded
combination server-side.

**The "download the complete archive" line** (the old archive page's only
download affordance) moved to the homepage — it would otherwise have had
nowhere to live. This required **porting the password-modal/toast/
download-button CSS from `site.css` into `home.css`** (`.pw-overlay`,
`.pw-modal`, `.dl-toast`, `.download-btn`, translated to `home.css`'s own
token names) and adding `<script src="/assets/player.js">` to the
homepage — `player.js`'s download-gating JS is shared sitewide and expects
those exact class names to exist wherever a `.download-btn` renders;
without the CSS the modal would appear completely unstyled. Verified
working end-to-end with a real Playwright click-through (temporarily faked
`data/archive_zip_meta.json`, screenshotted the modal, then reverted).

**Cleanup:** removed now-dead code — `build_archive`, `artist_sections`,
`date_sorted_list`, `show_row`, `_home_show_card`, `show_add_button` (Python)
— and the matching ~230 lines of now-unreferenced CSS in `site.css`
(`.show-row`, `.archive-legend`, `.view-toggle`, etc., checked one by one
for cross-page reuse before deleting — kept `.src-tag` since `/search/`
and `/updates/` still use it). Deleted the stale tracked `archive/index.html`
file itself (the generator only ever writes, never deletes — it would have
sat there stale otherwise). Fixed 3 now-stale `/archive/` references in
CLAUDE.md's own docs (design-system count, two runbook mentions).

**Verification before pushing:** full local rebuild + `--check`, a
Playwright smoke test (sort switching, expand button, light/dark theme,
zero console errors) against a local server, then the same checks again
against the live production URL after deploy — actual screenshots, not
just "the Action went green."

## ⚠️ Not done — known gaps, surfaced but not fixed

1. **Lost feature: whole-show "add to playlist" button.** The old
   `/archive/` row listing (`show_row`) had a `show_add_button` — select an
   entire show's tracks for the playlist queue in one click. The card
   design never had an equivalent and the approved mockup never included
   one, so it's gone now. Flagged to Rene twice (once before building,
   once after) — no decision yet on whether to add it back to the new card
   design. `track-select.js` still has harmless dead `.show-add` selectors
   (matches nothing now) — intentionally left alone rather than risk
   editing a file shared across show/songs/playlist pages for a
   zero-functional-impact cleanup.
2. **Stale copy in `content/about.html`**, unrelated to this session's
   code but now more obviously wrong given the framing change: "About This
   Archive" still says *"This is very much a work in progress. I'm
   steadily working through the show tapes — splitting them into
   individual songs..."* — directly contradicts the premise that started
   this whole session (splitting is done). Deliberately not rewritten —
   it's Rene's narrative voice, not layout, and he writes his own blurbs
   by convention. Sitting right next to the new lede ("Every show is
   digitized, split into songs, and streamable") it reads inconsistently.
3. **`about.html`'s first paragraph** (kept, unedited) also still opens
   with the DAT-recorder/audio-quality note before the now-stale
   "work in progress" paragraph — worth a full pass, not just deleting one
   sentence, if Rene wants to fix this.

## Gotchas learned this session
- **`home.css` and `site.css` are two independent token systems with the
  same underlying colors but different CSS variable names** (`--panel` vs
  `--surface`, `--ink` vs `--text`, `--ink-dim` vs `--muted`, `--hairline`
  vs `--border`, `--accent-dim` vs `--accent-light`). Porting any
  site.css-styled component into a home.css context (as happened with the
  password modal this session) means manually remapping every token, not
  copy-pasting the rule — get the mapping wrong and it silently falls back
  to unstyled/inherited values rather than erroring.
- **The static site generator (`build.py`) only ever writes files, it
  never deletes ones a removed page generator used to write.** Retiring
  `archive/index.html` from the build required an explicit `git rm` — the
  stale file doesn't get cleaned up automatically just because
  `write("archive/index.html", ...)` disappeared from `build.py`.
- **Before deleting anything from a shared CSS file, grep for the class
  name across every `sitegen/*.py` generator, not just the page you're
  editing** — several classes removed this session (`.src-tag` was almost
  one of them) are reused across `/search/`, `/updates/`, and elsewhere in
  ways that aren't obvious from the page being retired.
- **A component that gates behavior through shared, sitewide JS
  (`player.js`'s password modal) can't be dropped into a page that doesn't
  load that JS *and* doesn't have the CSS it expects** — both pieces have
  to move together. Missing either one fails silently (no JS error, just
  a broken-looking modal or a non-functional click), so it needs an actual
  browser test, not just "the build didn't error."
- **`npx playwright screenshot`** (CLI, no project install needed) is
  enough for a single static screenshot; multi-step interaction (click,
  sort, expand, check console errors, compare themes) needs a real script
  — `npm install playwright --no-save` in a scratch dir + a `.mjs` file
  worked fine here since Node/npx were already available in this
  environment.

## Durable facts (don't undo)
- **Three design systems, not two**: `home.css` (homepage — now also the
  full show listing), `site.css` ("Hannan Classic" — every other generated
  page), and `/process/`+`/manual/`'s own inline styles. See CLAUDE.md →
  "Site Styling & Templates" for the full breakdown, kept current as of
  this session.
- **`/archive/` is retired as a URL** — permanently redirects to `/`.
  Don't recreate it; any future archive-browsing feature belongs on the
  homepage's existing sort/listing UI.
- Audio-processing policy (−20 LUFS, linear-only normalization, workflow
  v7, gdrive/R2 remote setup) is unchanged by this session — see CLAUDE.md
  → "Publishing a Split Show" for the canonical, current version; not
  restated here since nothing about it changed today.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Site templates/CSS
source-vs-output layout, including today's homepage/archive merge:
`CLAUDE.md` → "Site Styling & Templates". Owner's manual (all tools, all
four workflow phases, full version history): `PUBLISHING.md` (also
rendered at `/manual/` — remember to rebuild after editing it). Older
phase-by-phase technical detail: `AUDIO_PROCESSING.md`. Playlist/player
feature spec: `PLAYLIST FEATURE.md`. Tag vocabulary: `TAGS.md`.
