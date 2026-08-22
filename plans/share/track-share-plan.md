# Share a Song: short links for a single performance

Status: **built 2026-08-22** per §8's answers (autoplay: yes; popover: Copy
link + Email). Written 2026-08-21 from Rene's ask: *"I
don't think there is a good way to share a single song. Design a plan to
create a share-song option, either an icon/pill or something else. It needs
to be a short name to copy/paste."*

This narrows and partly supersedes `share-plan.md` §3's "share affordance on
song pages": Rene wants a specific **performance** (Truck at 19 Broadway on
1999-02-01), not the song's catalog page, and he wants the link **short**.
Everything in `share-plan.md` about search-filter URLs stands untouched.

## 1. What exists today (verified 2026-08-21, against the code)

- **Every performance already has a deep link**, just not a usable one:
  `https://renedebos.com/shows/jerry-19-broadway-1999-02-01/#track-9`
  (~65 characters). On arrival the row scrolls into view and highlights
  (`.target`); with `?autoplay=1` it also starts, and on iPhone — where
  autoplay is blocked — the row shows the "waiting on a tap" cue shipped in
  PR #48. Nothing on the site lets a visitor *copy* that link; the song
  page's ↗ navigates to it.
- **A per-track share button was built on 2026-06-13** (`3dc47fb9`: share
  icon on every row → Web Share sheet on phones, else a popover with
  X / Facebook / Email / **Copy link**). Its markup was dropped as collateral
  on 2026-06-24 when the waveform rows replaced the row template
  (`a8ac100e`); the JavaScript (`player.js` → `sharePop`) and CSS
  (`.share-btn`, `.share-pop`) survive unused. `share-plan.md` §2's "a full
  share UI already exists per track" has therefore been stale since June:
  the code exists, nothing renders it. Worth reusing; not worth trusting as
  "already shipped".
- **Playlist short links** (`POST /api/playlist` → `/play/{slug}`, KV,
  PLAYLIST FEATURE.md Phase 4) make a one-song playlist a working but
  wrong-context workaround: the link lands in the playlist builder with one
  queued song, not on the show with its description and set.
- **The mini-player bar** is on every player surface (show, song, `/songs/`,
  `/playlist/`, home) and already knows the current item's title, artist,
  venue, date and `pageUrl`.

## 2. The link

```
https://renedebos.com/t/7f3a2c
```

- **Path `/t/{code}`**. `code` = the first 6 hex characters of SHA-256 of
  the track id (`jerry-19-broadway-1999-02-01-09`), lengthened at build
  time on a collision — the same recipe playlist slugs use, so the site
  has one way of making short ids. Measured on the 680 curated tracks:
  zero collisions even at 5 characters; 6 keeps headroom and matches
  `/play/`.
- **Resolves by 302** to the performance's deep link on its show page. The
  recipient gets the show — description, the rest of the set — with the
  shared song cued and highlighted.
- **Built, not created.** Unlike playlists (combinatorial, so they need a
  create call and KV), the set of performances is finite and known at
  build time. Every track gets its code the day it is published; no API,
  no storage, no rate limit, no eventual consistency, no "create the link
  first" round trip — the short URL is already in the row's `data-item`
  when the page loads, so copying it is instant and works offline.
- **Stability is the same as today's `#track-N`.** The code follows the
  track id; a reprocess that renumbers tracks changes the id and breaks
  the old code exactly as it breaks the old anchor and the old playlist id.
  Document in the publish runbook (CLAUDE.md step 2, beside `rename-track`).

Rejected forms, briefly:

| Form | Why not |
|---|---|
| `/t/truck-1999-02-01` (readable) | Not unique — Mad Hannans played Truck twice at Sweetwater on 2000-02-17. Titles and dates also change on reprocess. The preview text carries the meaning; the code only has to be short. |
| `/t/412` (sequential) | Shortest, but stable numbers need a registry written into `data/` and committed with every new show. The hash needs no state. |
| one-song `/play/{slug}` | Wrong landing context (§1), and a create call for something the build already knows. |
| `/songs/<slug>/` (share-plan.md §3) | Not what was asked: it lists all 25 Trucks, not the one you heard. |

## 3. Resolution — `site_worker.js`

- Add `TRACK_RE = /^\/t\/([a-f0-9]{5,64})\/?$/i`, checked beside `SLUG_RE`,
  `GET`/`HEAD` only.
- Targets come from **`/assets/track-links.json`** — a build output
  (`{"7f3a2c": "/shows/jerry-19-broadway-1999-02-01/#track-9", …}`, 680
  entries, ~45 KB) fetched through `env.ASSETS.fetch()` and held in a
  module-level variable for the isolate's lifetime. No KV involved.
- Unknown code → the branded 404 through the existing fallback branch
  (`no-store`), not a redirect to somewhere plausible — a mistyped link
  should fail visibly, not land on a random song.
- The redirect is edge-cacheable but **for an hour, not 24** like
  `/play/`: playlist entries are immutable, a track's target can move when
  a show is republished.
- `run_worker_first: true` and `not_found_handling: "none"` already cover
  the navigation-vs-fetch trap that cost a day on Phase 4; nothing to
  re-learn, but re-verify with a real pasted navigation, not only `curl`.

## 4. Build

- `scripts/build.py`: derive each track's code, assert uniqueness
  (lengthen on collision, as `createShortLink()` does), write
  `assets/track-links.json`.
- `playable_item_attr()` (fragments.py) gains `shareUrl` (absolute
  `https://renedebos.com/t/…`) for `kind: "track"` items — show rows and
  song-page occurrence rows alike; `assets/song-occurrences.json` gains
  `code` so `songs.js`'s `occRowHtml()` can carry the same field (the two
  builders are already documented as kept in sync).
- `scripts/verify_markup.py`: every track item has a `shareUrl`; its code
  is in the map; the map's target equals the item's `pageUrl`. Same
  build-fails-on-drift posture as the R2-key and peaks checks.
- Whole-show recording cards (`kind: "recording"`) get no code in this pass
  — sharing a whole show is a different, already-short URL.

## 5. The control — where "share" lives

**Recommendation: one share button in the mini-player bar, acting on the
song that is playing.**

```
[▶]  Truck                                    0:00 ───────────── 3:58   [⇪] [×]
     Jerry Hannan · 19 Broadway · 1999-02-01
```

- **Tap on a phone** → the system share sheet (`navigator.share` with
  title, text and the short URL): Messages, WhatsApp, Mail, copy — whatever
  the phone offers. This is the code path `3dc47fb9` already wrote.
- **Click on desktop** → a small popover anchored to the button:
  **Copy link** (primary; button reads "Link copied" for 1.6 s, the
  playlist page's existing feedback) and **Email** (`mailto:` with the
  text and link). Reuse `.share-pop`; drop the X/Facebook rows unless Rene
  wants them — email and paste were the stated use.
- Share text: `Truck — Jerry Hannan, 19 Broadway, 1999-02-01 · The Hannan
  Tapes` + the link. Built from the item; no new data.
- Why the bar and not a per-row icon: the bar is on every surface, so one
  control covers show pages, song pages, `/songs/` and `/playlist/`; the
  rows have no room — a phone row is at its limit, and the add-to-playlist
  size was deliberately kept the smallest control on the row (site.css,
  "don't fix this again"). "Share what I'm listening to" is also the
  natural moment: you decide to share a song while it plays.
- On `/playlist/` the bar's button shares the **current song**; the page's
  existing "Copy share link" shares the **queue**. Two different things,
  so the labels must say so: bar `aria-label="Share this song"`, page
  button unchanged.
- The song page's ↗ stays what it is (open on the show page).

Deferred, not rejected: share *without* playing. The hover info card
can't host a button (it hides on scroll and never opens on touch), and the
row has no space; if wanted later, the least-crowded option is a share
icon on the **active row only**, beside ↓, which the row already treats as
the expanded state.

## 6. Link previews

A 302 lands on the show page, so iMessage / WhatsApp / Slack unfurl the
**show's** title and description (crawlers follow redirects). Good enough
for v1. If a song-specific preview is wanted later, the Worker would serve a
tiny HTML page for `/t/{code}` — per-track `og:title`/`og:description`, then
a `<meta http-equiv="refresh">`/JS hop — instead of a bare 302. Separate
decision; it changes the Worker from redirector to renderer.

## 7. Tasks, in order (each leaves the site working)

1. **Build** — codes, `assets/track-links.json`, `shareUrl` in `data-item`,
   `code` in `song-occurrences.json`, `verify_markup.py` checks.
   *pages.py, fragments.py, build.py, songs.js, verify_markup.py.*
2. **Worker** — `/t/{code}` route, asset-backed map, 1 h cache, 404
   fallthrough. Deploys with the push. Verify with `curl -I` **and** a real
   pasted navigation on renedebos.com; add the check to
   `scripts/browser_check.mjs`'s production sweep.
3. **Bar button** — `mp-share` in `miniplayer-views.js` (icon from
   `3dc47fb9`, re-added to fragments.py/miniplayer as `SHARE_ICON`),
   `.mp-share` beside `.mp-close`; share sheet / popover. Move the popover
   code out of `player.js` into a small shared `share.js` the bar and the
   legacy engine both load, and delete the dead `.share-btn` handler.
   Tests: `test-miniplayer-views.mjs` gains the button's render and the
   `navigator.share` / fallback branch.
4. **Docs** — PLAYLIST FEATURE.md's URL-namespace table and
   `share-plan.md` §6 gain `/t/{code}`; CLAUDE.md publish runbook notes
   that renumbering changes codes; HANDOFF entry.
5. **Verify** — Playwright: play a song → share → Copy → clipboard equals
   `/t/…`; `/t/…` → 302 → row highlighted (and playing, if §8.1 says so);
   phone viewport hits the `navigator.share` branch (mocked).

Rough size: ~250 lines across seven files, one session, one deploy.

## 8. Decisions for Rene

1. **Autoplay on arrival?** Recommend **yes** (`?autoplay=1` in the
   redirect target): the recipient clicked "listen to this"; where the
   browser blocks sound the row shows the existing tap-to-play cue, so the
   worst case is today's behaviour. Alternative: cue only.
2. **Popover contents on desktop:** Copy link + Email (recommend), or keep
   X / Facebook from the 2026-06 version too.
3. **Code shape:** 6 hex (recommend, matches `/play/`), or 5 base-36 for a
   character less.
4. **Later:** song-specific previews (§6); share without playing (§5);
   *share at a timestamp* — still the URL-grammar question from
   `share-plan.md` §4; `/t/{code}?t=83` would be the natural slot, and has
   to be designed once against `#p=`, `&t=`, `#track-N` and `?autoplay=1`.

---

## 9. Amendment 2026-08-22 — `/t/{code}` becomes a page, not a redirect

Rene, the day after the redirect shipped: *"Is it possible that clicking on
the link opens a player to only play that single song rather than linking to
a show page with all songs from that show?"*

This reverses §2's landing decision. Stated plainly because §2 argued the
other way and the argument was not wrong — it was answering a different
question. §2 optimised for *context* (the recipient gets the show, its
description, the rest of the set). Rene is asking for *focus*: the link
should deliver the one performance he chose to send, and nothing else
competing for the first tap.

The reversal is cheap **because it shipped yesterday**. Essentially no
`/t/` links exist in the wild, so there is no cohort whose links change
meaning under them. That will not be true a month from now, which is the
argument for doing it in this session rather than shelving it.

### 9.1 What changes

`/t/{code}` serves a **built static page**: one track, one player, the
show and song reachable but not in the way.

- **Static, not Worker-rendered.** The set of performances is finite and
  known at build time — the same argument §2 used against a create-call
  API applies again one level up. 680 small pages cost a build second and
  give per-song `og:` tags for free, which closes §6's deferred
  "song-specific link previews" as a side effect rather than as a project.
- **The Worker keeps its `/t/` branch, but rewrites instead of
  redirecting** — `env.ASSETS.fetch('/t/{code}/index.html')`. Serving the
  asset directly rather than falling through to the auto-trailing-slash
  behaviour keeps the shared URL a single 200 with no redirect hop, and
  keeps `shareUrl` slash-free (`/t/7f3a2c`, not `/t/7f3a2c/`).
- **`assets/track-links.json` stays**, repointed at the page. It is no
  longer the Worker's routing table but it is still the build's proof that
  every code resolves, and `verify_markup.py` still checks it.
- **Autoplay stays yes** (§8.1), but can no longer ride on `?autoplay=1`
  + `#track-N` — a clean `/t/{code}` has neither. `player-boot.js` gains
  `window.PLAYER_AUTOPLAY`: on `load`, if the deep-link path did not
  already start something, start row 0. Four lines, inside the existing
  handler, and `initialIntent` stays honest.

### 9.2 What the receiver sees

```
                    THE HANNAN TAPES

                        Truck
          Jerry Hannan · 19 Broadway · 1999-02-01

     [▶]  ▁▃▅▇▅▃▁▂▄▆█▆▄▂▁▃▅▇▅▃▁▂▄▆█▆▄▂▁    0:00 / 3:58
          Playing the Loud version · ⓘ            [↓]

          Hear the whole show (23 songs) →
          All 25 recordings of "Truck" →
```

The page is structurally *a show page with one track*: the same
`.track-row.ws-track` markup, the same `player-boot.js`, the same
mini-player bar — so the recipient can re-share what they just heard
without the bar being a special case. Nothing new to keep in sync.

Peaks come from a **per-track** `assets/peaks/t/{code}.json` (~2.5 KB)
rather than the show's whole file (~60–90 KB for one waveform). Same
`window.WS_PEAKS_URL` contract, no JavaScript change: the file is just
`{"<num>": {…}}`.

The variant disclosure line is **required, not decorative** — CLAUDE.md's
`-14` section obliges every page with a player to say which version is
playing, and this page will be many visitors' only page.

### 9.3 `noindex`

These 680 pages are share targets, not browse targets. Indexed, they would
compete with the show and song pages that are *designed* to be found, on
near-identical text. Same "unlisted" treatment `/archive-data/` already
gets: `<meta name="robots" content="noindex">`, no sitemap entry. Link
previews are unaffected — unfurlers read `og:` tags and ignore `robots`.

### 9.4 Deliberately still deferred

- **The short domain.** Rene, asked whether to settle it first: *"Can we
  save time by delaying the decision about different domains and accept
  renedebos for now?"* — yes. `renedebos.com/t/{code}` stays **canonical**,
  which is what makes a short domain purely additive later: it redirects to
  canonical, old links keep working, and no build output has to change.
  The origin is constructed in exactly two places (`core.py`'s
  `track_share_url()`, `songs.js`'s `occRowHtml()`), asserted in one
  (`verify_markup.py`).
- ~~**Share without playing** (§5).~~ Built the same day — see §10.

---

## 10. Built 2026-08-22 — the per-row share control

§5 deferred "share without playing" and recommended a share icon on the
**active row only, beside ↓**. Rene asked for it immediately after §9 landed,
and that recommendation is what shipped, unchanged in shape.

- **`track-select.js` owns it**, not the player. Everything the control needs
  is already in the row's `data-item`, so it works on a row nobody has pressed
  play on — the entire point — and on a page whose engine never mounted.
  `share.js` is imported on the first press, as the bar does it.
- **An `<a href>`, not a `<button>`.** With JavaScript it opens the share
  sheet (touch) or the Copy link / Email popover (desktop); with none it
  navigates to the share page, where the URL can be copied by hand. This is
  now the *primary* way to share a song, so it must not be dead if a module
  fails to load.
- Three renderers had to grow it, as always on a track row:
  `track_share_button()` (fragments.py, both the show row and the song
  occurrence row), and `trackShareButtonHtml()` (track-select.js) for
  `songs.js`'s lazily-inserted rows. Escaping lives in the builder, not the
  call sites.
- Hidden by CSS on every row but the active one, keyed on `.is-active` **and**
  `.playing` — the legacy fallback engine only ever sets the latter.

### 10.1 The phone layout, which nearly sank it

§5 said "the rows have no room — a phone row is at its limit", and site.css's
note on `.track-add`'s size says the same thing more loudly. Both were right,
and the first version proved it. Measured at 390px, not eyeballed:

| surface | before | naive version | shipped |
|---|---|---|---|
| show row, active title width | 74px | **40px** (`Smoke in Heaven` → `Smo... in...`) | 74px |
| song-occurrence row height | 56px | **88px** (every other row 56px) | 55px |

Two different fixes, because the two rows differ in the one way that matters:

- **Show rows have a second line already** — the waveform, which only the
  active row carries. The control moves onto it (`order: 6`, with `.ws-wave`'s
  flex-basis reduced so the two share a line). Line one then lays out exactly
  as it did before this button existed, so none of the carefully-tuned mobile
  rules above it had to be re-derived.
- **Song-occurrence rows have no second line.** There, the active row trades
  its `↗` for the share control rather than carrying both. Nothing is lost:
  `↗` and the artist chip point at the *same* anchor, so the show page is
  still one tap away on that row. Desktop keeps both — it has the width.

Both numbers are now assertions in `browser_check.mjs`'s `checkRowShare()`,
stated as "no worse than with the control hidden" rather than as pixel
constants, so a future type-scale change can't fail them for an unrelated
reason.

### 10.2 Also cut, same day

The Loud note's clause "about as loud as a streaming service, so it isn't too
quiet on phone speakers or in a car" (Rene). It justified the Loud *default*
rather than telling a listener what they are hearing, and the justification
belongs on `/process/`. The disclosure CLAUDE.md requires — which version is
playing, in plain words — is the first half of that sentence and is untouched.
The **Archive** note keeps its shorter "about as loud as a streaming service",
because there it describes the option you have *not* chosen and is the only
thing that makes "−14 LUFS" mean anything to a non-engineer.
