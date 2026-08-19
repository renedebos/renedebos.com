# Share: Feature Proposal

Status: proposal — not yet built. Still valid; the research below was
re-checked on 2026-08-19 and holds.

**Its stated blocker dissolved rather than resolved — read §4 with this in
mind.** The plan sequenced itself after player-consolidation's canonical
URL-grammar decision. That project shipped and closed on 2026-08-18, but the
grammar decision was never made: "Share timestamp" is still listed as unbuilt
in `plans/player-consolidation/player-consolidation-plan.md` §3, and Phase 3
was PARKED (branch `miniplayer-parked`), not delivered. So:

- **The two in-scope pieces of §3 are unblocked, and always were.** §4 says so
  itself — search-filter URLs and song/search share UI touch none of the
  `#p=` / `&t=` / `#track-N` / `?autoplay=1` namespace.
- **The deferred timestamp piece is not "waiting" for anything.** Whoever picks
  it up owns the URL-grammar decision themselves. Do not read §4 as a reason to
  hold off; there is no longer an event to hold off *for*.

Re-verified 2026-08-19: `search.js`'s `syncUrl()` still writes only
`?q=<text>` and discards filter state, so §2's "filters are not persisted to
the URL" — the actual gap this project exists to close — is unchanged.

Codex notes and repository review: see `share-codex.md` in this folder
(currently a placeholder — no review has run yet).

Originally developed on branch `share` in worktree
`/home/renedebos/renedebos.com-share`; both retired on 2026-08-19 once this
document reached `main`, so the proposal lives with every other plan rather
than on a branch nobody remembers. Start a fresh branch when it gets built.

## 1. Objective

Let a visitor share a link to (a) an individual song, or (b) the current
search/filtered result, with a one-click copyable link suitable for pasting
into an email. Same spirit as the share affordance that already exists for
individual tracks on show pages — extended to these two other contexts,
reusing what already works rather than inventing a third UI pattern.

## 2. Current state — what already exists (don't rebuild this)

A repo-research pass turned up more prior art than expected:

- **Song pages already have stable, canonical URLs**: `/songs/<slug>/`
  (`scripts/sitegen/core.py`'s `song_slug()`, canonical `<link>` in
  `page_shell()`). Per-performance deep links already exist too, via
  `{show_url}#track-N` — used today by the song-grid, the RSS feed, and
  JSON-LD (`fragments.py`, `songs.js`, `feeds.py`).
- **Search already reflects the free-text query in the URL.** `search.js`'s
  `syncUrl()` writes `?q=<text>` via `history.replaceState` on every
  keystroke, and reads it back on load — reloading or sharing
  `/search/?q=foo` already reproduces the text query. **Filters
  (type/artist/source) are not persisted to the URL** — chip state lives
  only in an in-memory object and resets on reload. This is the actual gap
  for "share a search result."
- **A full share UI already exists per track on show pages**
  (`scripts/player.js`, `.share-btn` / `sharePop`): Web Share API when
  available, else a small popover with X/Twitter, Facebook, Email
  (`mailto:`), and a **Copy link** button (clipboard API, falling back to
  `window.prompt` when unavailable). This is a proven, already-shipped
  pattern users have seen — the natural thing to reuse/adapt for song pages
  rather than designing new UI.
- **A second, separate share mechanism exists for playlists**
  (`scripts/playlist.js`'s `copyShare` + a server-side, content-addressed
  short-link system: `POST /api/playlist` → SHA-256 of the joined track-id
  list → `/play/{slug}`, KV-backed, rate-limited, in `site_worker.js`).
  This is heavier machinery (link creation, storage, rate limits) built
  specifically because playlist URLs (comma-joined ID lists) can get long.
  Song and search URLs are already short and stable — this project should
  not need to stand up a second short-link system.

## 3. Scope

### In scope

- Extend `search.js` so filter state (`type`/`artist`/`source`) is also
  reflected in the URL, so a filtered search result is fully reproducible
  from its URL — not just the free-text query.
- A share affordance on song pages — reusing/adapting the existing
  `.share-btn`/`sharePop` pattern from `player.js` rather than inventing new
  UI, pointed at the song's canonical `/songs/<slug>/` URL.
- A share affordance on `/search/` — copy-current-URL, most likely reusing
  `playlist.js`'s `copyShare` clipboard-with-`window.prompt`-fallback
  pattern.
- Decide whether an explicit "Email" option (a `mailto:` link, like the
  existing per-track share popover already offers) sits alongside plain
  copy-link for both contexts, matching the email-pasting use case Rene
  described first.

### Out of scope for this pass

- **"Share with timestamp"** (jump to a specific second within a track) —
  already an open item in player-consolidation's own plan, tied to a
  URL-grammar decision that hasn't been made yet. See §4.
- New short-link infrastructure for songs/search. Their canonical URLs are
  already short; short-linking exists for playlists specifically because
  those URLs are long comma-joined ID lists — a different problem.
- Any change to the two share mechanisms that already work (per-track share
  popover, playlist share/short-link). This project adds two new contexts;
  it doesn't redesign the ones already shipped.

## 4. Why sequence this after player-consolidation

This isn't just prudence — the research surfaced a real, concrete
dependency. Player-consolidation's plan
(`plans/player-consolidation/player-consolidation-plan.md`, in the
`player-consolidation` branch) already lists an open, not-yet-built
**"Share timestamp"** feature:

> Share timestamp — copies a link that opens straight to the current
> second. Needs one canonical URL grammar across queued tracks, show-page
> tracks, and whole shows — the site already uses `#p=id,...`, `&t=...`,
> `#track-N`, and `?autoplay=1`; a timestamp scheme must not collide with
> those or break existing short playlist links.

That project is *already* planning to design the canonical URL grammar
(including a new timestamp scheme) across the whole site's playback
surface. If this project independently invented its own URL conventions for
song/search sharing at the same time, the two would risk colliding or
simply duplicating a decision that needs to be made once, coherently, in
one place. Concretely: this project's song-share links don't need a
timestamp today (§3 scope), so there's no blocking conflict *yet* — but the
moment "share a moment in a song" comes up (see §5's suggestions below),
it's the same open grammar question player-consolidation already owns.
Building this project first would mean guessing at that grammar twice.

**Recommendation:** build the two in-scope pieces above (search filter URLs,
song/search share UI) whenever convenient — they don't touch playback or
the `#p=`/`&t=`/`#track-N`/`?autoplay=1` namespace at all. But hold off on
any timestamp-flavored share functionality until player-consolidation's
grammar decision lands, and re-check this plan against whatever that
decision turns out to be before adding it.

## 5. Additional share-functionality suggestions

Since you're open to more ideas — roughly in order of how directly they
serve the stated goal:

- **Share a whole show/recording**, not just a song — the show page
  presumably wants the same affordance as the song page; natural to build
  both at once rather than song-only now and show-later.
- **Reuse the exact X/Facebook/Email/Copy-link popover** from `player.js`
  for song/show sharing, rather than a plain copy-only button — consistency
  with what's already on every show page, and it's already built/tested.
  (Simple copy-only for search, if a lighter footprint feels more
  appropriate there — search results are more transient than a song.)
- **Share with timestamp** (moment within a song/show) — explicitly
  deferred per §4, but worth having on this list since it's the most
  requested kind of "share" feature on music sites generally, and the
  groundwork (player-consolidation's grammar work) is already planned
  elsewhere.
- **Share a whole artist's or setlist's worth of songs** (e.g. "everything
  Jerry played at 19 Broadway") — a bigger, fuzzier idea, not scoped here;
  flagging only because it's adjacent to "share a search result" once
  search filters are URL-addressable (§3).

## 6. Existing URL/query "namespace" — don't collide with this

Enumerated by the research pass, for reference by whoever builds this:

| Convention | Used for | Where |
|---|---|---|
| `#p=id,id,...` | playlist/queue of track ids | `playlist.js`, `continuous-player.js`, `track-select.js`, `player.js`, `site_worker.js` |
| `&t=<seconds>` | one-time start-time seed into a `#p=` hash | `player.js` → `continuous-player.js` |
| `#track-N` | anchor to a specific track row on a show page | `songs.js`, `fragments.py`, `pages.py`, `feeds.py` |
| `?autoplay=1` | auto-start playback of the hash-targeted track | `pages.py` (random-tape), consumed in `player.js` |
| `?q=<text>` | search free-text query (search page only) | `search.js` |
| `/play/{slug}` | path-based short link, server-resolved to `#p=` | `site_worker.js` |

This project's in-scope work (extending `?q=`-style search-filter params,
sharing canonical `/songs/<slug>/`  and show URLs) doesn't touch any of the
hash-based conventions above. If that changes during implementation, stop
and cross-check against this table and against player-consolidation's
grammar work.

## 7. Git and Session Workflow

Same pattern as the other projects in this repo — one branch, one
dedicated worktree, so this can be worked on independently without
disturbing `main` or the other in-flight projects:

```text
GitHub repository: renedebos/renedebos.com
  main branch
    local folder: /home/renedebos/renedebos.com

  home-page branch
    local folder: /home/renedebos/renedebos.com-home-page

  player-consolidation branch
    local folder: /home/renedebos/renedebos.com-player-consolidation

  share branch
    local folder: /home/renedebos/renedebos.com-share
    session purpose: this project
```

1. Work only in `/home/renedebos/renedebos.com-share`.
2. Confirm `git status --short --branch` says `share` before editing.
3. Sync with `main` at the start of a session — not on a fixed schedule —
   `git fetch origin main && git merge main`, and again right before
   opening/updating this project's pull request.
4. Keep commits scoped to this project.
5. Push, open a pull request into `main`, review the diff/build, merge only
   after review — same as the other projects.

## 8. Open Questions

- Exact share-UI treatment for song pages: reuse `player.js`'s full
  popover (X/Facebook/Email/Copy) as-is, or a trimmed version?
- Should `/search/` sharing be copy-only, or also get the fuller popover?
- Once search filters are URL-addressable, does the *shown* URL bar update
  live (like the free-text query already does), or only get built at
  share-time? (Live update is more "shareable by just copying the address
  bar," matching how the free-text query already behaves.)
- Whether/how to indicate a shared filtered-search link differently on
  arrival (e.g. a small "shared search" banner) — not required, but worth a
  decision either way rather than leaving it implicit.

## 9. Implementation Steps

- [x] Create the `share` branch and its dedicated worktree.
- [x] Create this plan and the Codex-notes placeholder.
- [ ] Codex review (fill in `share-codex.md`).
- [ ] Decide the open questions in §8.
- [ ] Extend `search.js` to persist filter state to the URL.
- [ ] Build the song-page share affordance.
- [ ] Build the search-page share affordance.
- [ ] Verify against the URL namespace in §6 — nothing collides.
- [ ] Rebuild, manual browser check (desktop/mobile, light/dark, copy-link
      fallback path with clipboard API unavailable).
- [ ] Commit, push, open a pull request into `main`.
- [ ] Merge only after review.
- [ ] Re-check §4/§5's timestamp-sharing idea once player-consolidation's
      URL-grammar decision lands, and decide whether to pick it up as a
      follow-on.
