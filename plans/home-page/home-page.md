# Home page: Header Icon Plan

Status: **shipped and closed** (2026-08-13, commit `2f9e688`, *Replace header
musical-note mark with a Shows label, sitewide*). On `main` and live on
renedebos.com. This file is the record of what was decided and why; it is not
open work. Do not reuse this folder for a new project — start a fresh
`plans/<name>/<name>-plan.md`.

**Loose ends left in the working tree, still there as of 2026-08-19:** branch
`home-page` and worktree `/home/renedebos/renedebos.com-home-page` were never
cleaned up. The icon work itself is on `main`, but the branch still carries 3
unmerged commits (HANDOFF/workflow notes from that session) and is 98 behind.
Merge or discard them deliberately — do not assume the branch is redundant just
because the feature shipped.

**The one open thread it deliberately left behind:** the icon could not teach a
first-time visitor that the home page *is* the browsable archive, and §1 says so
plainly — a word carries that, not a mark. The "Shows" label is a supporting
signal, not the whole fix. An on-page-copy fix was named as the more direct
follow-up and was never done.

Codex notes and repository review: see `home-page-codex.md` in this folder.

## 1. Objective

Replace the small circular musical-note mark in the home-page header with a
new icon. Use this small change to establish a safe workflow for working on
several website projects at the same time with separate Claude or Codex
sessions, Git branches, and Git worktrees.

**Refined design goal (added after initial planning):** the musical note
doesn't communicate what a first-time visitor most needs to know — that the
home page is not just a landing page but the full, sortable/searchable show
archive (since the 2026-07-19 `/archive/` → `/` merge, per root `CLAUDE.md`).
The note reads as "this site is about music," not "there is a browsable list
of shows right here." The replacement icon should lean toward that meaning —
something that reads as list/catalog/collection rather than reinforcing
"audio" a second time (the site is already unambiguously about audio; the
header doesn't need to say that twice).

**Honest limitation worth stating up front:** this is a 34 px icon in the
page corner, functioning as the home link across the whole site. Icons alone
are a weak channel for teaching a first-time visitor a specific, non-standard
fact about page content — that's usually carried more reliably by on-page
copy or a labeled section near the show list itself. Treat the icon as a
small, supporting signal toward "there's a catalog here," not as the whole
fix for the discoverability problem. If the underlying confusion turns out to
matter more than this exercise's scope, an on-page-copy fix is a separate,
likely more direct follow-up — not something to fold into this branch.

**Final decision (2026-08-13):** an icon can't reliably carry this meaning —
a word can. The mark now reads **"Shows"** as visible text, sitewide, in
place of the `♪` glyph. Because a word doesn't fit a 34 px circle, the
container changes shape too: from a circular icon badge to a pill.

Word options considered: "Archive" (names the site, but doesn't say "browse
shows here"), "Shows" (the most direct match for the goal — chosen), and
"Hannan Tapes" (the conventional wordmark role, but redundant with the hero
`<h1>` and the longest of the three). "Shows" was chosen for being the most
direct answer to the actual discoverability problem.

Success means:

- the new home-page mark is agreed before it is shipped;
- it says "Shows," not the site name or an icon;
- it is legible and balanced at its 34 px header height on desktop and
  mobile;
- it works in both light and dark themes;
- the home link's accessible name starts with the visible text "Shows" (WCAG
  2.5.3 Label in Name) and keeps enough context to still read as "go home";
- visible keyboard focus is retained;
- unrelated music-note and record-ring icons do not change accidentally;
- the generated site builds successfully; and
- the work is reviewed through its own GitHub pull request before merging to
  `main`.

## 2. Scope

### In scope

- the header mark rendered by `HOME_SHELL` in `scripts/sitegen/pages.py`
  (home page) **and** by `page_shell()` in `scripts/sitegen/fragments.py`
  (every other generated page) — decided sitewide, not home-only (see below);
- the source styling for `.mark` in both `scripts/home.css` and
  `scripts/site.css`;
- the built site files produced by the normal site build; and
- the accessible name on the home link (`aria-label`), since the visible
  text is changing.

### Out of scope

- the record-ring icons on individual show cards;
- musical-note icons used for playlists, `/player/`, or elsewhere on the
  site (`PLAYER_SHELL` still uses the plain `♪` glyph in its `<h1>` — a
  different element, not `.mark`);
- the browser favicon (still the `♪` glyph, in four places — a separate,
  not-yet-made decision, deliberately not folded into this pass);
- any broader nav/logo redesign beyond this one element; and
- changes to the player-consolidation project, audio processing, or
  publishing workflows.

Keeping these boundaries makes the first branch exercise easy to review and
easy to reverse.

### Resolved: sitewide, not home-only

`.mark` was byte-for-byte duplicated in two templates: `HOME_SHELL`
(`scripts/sitegen/pages.py:119`, styled by `scripts/home.css`) and
`page_shell()` (`scripts/sitegen/fragments.py:159`, styled by
`scripts/site.css`) — the shared header on every other generated page. A
homepage-only change was considered and rejected: swapping the container
shape from a circle to a pill is a much more visible seam than an icon swap
would have been (it reads as two different navigation systems, not just a
different logo), so both templates and both stylesheets change together in
this PR.

### Bugs found by actually looking at it (2026-08-13)

Browser review during this pass surfaced three real issues, all fixed:

- **Underline on non-home pages.** `home.css` has a global `a { text-decoration:
  none; }` that silently protected the mark there; `site.css` has no such
  reset and never gave `.mark` its own — so it fell back to the browser's
  default underline. Invisible under the old single-glyph icon, obvious under
  real text. Fixed by adding `text-decoration: none` to `.mark` in
  `site.css`.
- **Header height mismatch.** `home.css`'s header uses `padding: 22px 0`;
  `site.css`'s used `padding-top/bottom: 1rem` (16px) — a pre-existing,
  unrelated-to-this-change gap that made the pill (taller than the old icon)
  sit visibly higher on non-home pages. Fixed by matching `site.css` to
  `22px`.
- **Inconsistent color treatment.** Home used an outline pill (panel
  background, accent text); every other page used a filled pill (accent
  background, `--bg`-colored text) — carried over faithfully from the old
  icon's two treatments, but reads as a much bigger seam on a bold text pill
  than it did on a small icon. Unified on the filled treatment sitewide
  (home.css's `.mark` now matches site.css's colors exactly, via the same
  `--accent`/`--bg` token values both files already share).

### Hero block background (2026-08-13)

Separately from `.mark`: the home page's hero (eyebrow/h1/lede/actions) had
no background of its own, while every other page's equivalent —
`.page-title` in `site.css` — sits on `background: var(--surface)`, reading
as a distinct panel under the header. Home was the outlier (every other page
already has the block); fixed by adding `background: var(--panel)` to
`.hero` in `home.css` — `--panel` and `--surface` are already the same
values under different names, so this is a like-for-like match, not a new
color.

One residual difference, deliberately left as-is: `site.css` puts the
`.page-title` background on a div *outside* `.wrap`, so it spans the full
browser width; `home.css` wraps the entire page (header through footer) in a
single `.wrap`, so `.hero`'s new background is boxed within the 1080px
column, with plain page background visible as gutters on wide screens.
Closing that fully would mean restructuring home's hero outside `.wrap` —
a bigger change to home's layout system than this pass warrants. Decided to
stop at closing the "no block at all" gap, not chase pixel-exact full-bleed
parity.

### Home-page active-state underline

`fragments.py`'s `site_nav()` already skips a "Home" nav link with the
comment "the header's logo mark covers it" — the mark was always meant to
carry the current-page indicator for home, it just was never styled that
way. Since `home.css` is exclusively the home page's stylesheet, its `.mark`
rule now always renders underlined — no conditional class needed, the file
boundary itself is the condition. `site.css`'s `.mark` (every other page)
stays non-underlined, matching how a regular nav link (e.g. "Search") is
only underlined via `.active` on its own page.

## 3. Design Approach (final)

Two SVG-based directions were prototyped and rejected before landing here —
kept for the record, not as live options:

- **card-stack icon** (overlapping rounded rectangles) — rejected outright;
  an icon can't reliably teach a first-time visitor a specific, non-standard
  fact about page content, however well it's drawn.
- **circular icon container** — dropped once text replaced the icon; no word
  fits a 34 px circle.

**Final: a text pill reading "Shows."** `.mark` changes from a 34 px circle
with a single glyph to a pill: fixed 34 px height (unchanged, keeps header
rhythm), horizontal padding instead of a fixed width, `border-radius` at half
the height, bold small-caps-scale label text instead of an icon. Colors stay
token-driven (`var(--panel)`/`var(--accent)`/`var(--hairline)` on the home
page; `var(--accent)`/`var(--bg)` sitewide) so light/dark and the two
stylesheets' existing treatments both carry over unchanged — only the shape
and content of `.mark` itself changes, not its color logic.

The accessible name changes from `"The Hannan Tapes — home"` to `"Shows — The
Hannan Tapes home"` — it now starts with the visible text (matches WCAG 2.5.3
Label in Name) while still identifying the destination as home.

## 4. Source of Truth

The home page is generated. Make changes in the source files and rebuild:

- `scripts/sitegen/pages.py` — home-page HTML template and current note mark;
- `scripts/home.css` — home-page styling; and
- `python3 scripts/build.py` — regenerates `index.html`, `assets/home.css`,
  and the other generated output.

Do not hand-edit `index.html` or `assets/home.css`; the next build would
overwrite those edits.

## 5. Git and Session Workflow

This project uses one repository but a dedicated branch and worktree:

```text
GitHub repository: renedebos/renedebos.com
  main branch
    local folder: /home/renedebos/renedebos.com

  home-page branch
    local folder: /home/renedebos/renedebos.com-home-page
    session purpose: this header-icon project

  player-consolidation branch
    local folder: /home/renedebos/renedebos.com-player-consolidation
    session purpose: consolidated-player planning and implementation
```

Every Claude or Codex session should be opened in the folder for its project.
Do not point two concurrent sessions at the same worktree, and do not use one
worktree for unrelated branches.

For this project:

1. Work only in `/home/renedebos/renedebos.com-home-page`.
2. Confirm `git status --short --branch` says `home-page` before editing.
3. Keep commits small and limited to the icon project.
4. Push `home-page` to GitHub when the first reviewable change is ready.
5. Open a pull request from `home-page` into `main`.
6. Review the diff and preview/build result before merging.
7. Merge the pull request only after approval; do not develop directly on
   `main`.

## 6. Verification

- Run `python3 scripts/build.py`.
- Confirm only the intended source and generated files changed.
- Check the home page at narrow mobile and desktop widths.
- Check automatic light and dark themes.
- Tab to the icon and confirm focus remains visible.
- Confirm the home link still returns to `/` and has the correct accessible
  label.
- Confirm show-card ring icons, playlist icons, and non-home pages are
  unchanged.
- Review the GitHub pull-request diff before merging.

## 7. Implementation Steps

- [x] Create the `home-page` branch and its separate worktree.
- [x] Create the home-page plan and Codex notes files.
- [x] Choose what the replacement mark should represent — "Shows" (text, not
      an icon).
- [x] Decide whether the surrounding circle stays or changes — changes to a
      pill; text doesn't fit a circle.
- [x] Decide favicon scope — left unchanged, out of scope for this pass.
- [x] Decide sitewide vs. home-only — sitewide; both templates/stylesheets
      change together.
- [x] Implement in `HOME_SHELL`, `page_shell()`, `scripts/home.css`,
      `scripts/site.css`, including the updated `aria-label`.
- [x] Rebuild and inspect the generated diff — 183 files (2 templates, 2
      stylesheets, and every generated page under `page_shell()`, as
      expected for a sitewide header change).
- [x] Verify in a real browser (Playwright screenshots): home page and
      `/contact/`, desktop and mobile widths, light and dark — all read
      cleanly. Hover/focus-visible rules were left untouched (only the
      resting-state geometry/color changed), so not separately screenshotted.
- [ ] Commit the change on `home-page`.
- [ ] Push the branch and open a pull request into `main`.
- [ ] Merge only after reviewing the pull request.

