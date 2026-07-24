# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-25 · **Branch:** `main` — everything below is committed & pushed, both deploys verified live on renedebos.com itself (not just green Action).

> No audio work this session. Rene brought in an external site-audit writeup
> (weaknesses/improvements across search, caching, JSON payloads, CSP) and
> asked for the two highest-ROI items. Verifying the audit's claims against
> the live site first turned out to matter more than the fixes: **half of it
> was wrong**, including the item billed as the biggest available win. Shipped
> the part that was real (font caching) plus the one genuine defect
> (`/search/` had no no-JS fallback), and closed out three other items as
> non-problems without writing code for them.

## ✅ Done this session

### Verified the audit against the live site before acting (do this first)
The audit was confident and specific, and much of it did not survive a
`curl -I` against renedebos.com. Worth recording because the same claims will
resurface if another review runs over this repo:

- **"No cache-control headers; repeat visitors re-download 1.5 MB of JSON;
  CSS/JS can be served stale."** Wrong on all three. Cloudflare's asset server
  already returns `public, max-age=0, must-revalidate` **with working ETags**
  on every asset — confirmed a real `304` on `search-index.json`. Repeat
  visitors were already getting 304s, and `must-revalidate` makes staleness
  impossible. The recommended fix (`max-age=31536000, immutable` on unhashed
  filenames) would have been an actively harmful one-way door.
- **"~1.46 MB of overlapping JSON."** True on disk, misleading on the wire —
  `content-encoding: br` is on for all four JSON files, `site.css`, and
  `/songs/`. That's ~300 KB actually transferred. Dropped the proposed
  JSON-dedup refactor entirely.
- **"`site.css` is 55 KB unminified, a minify pass is free."** Pointless once
  Brotli is confirmed. Not done, deliberately.
- **"Add `<noscript>` + preload to `/search/`."** This one was real — see below.

### Cache headers: fonts immutable, peaks for a day (commit `3817f48`)
What was actually left after the above: not bytes, just the revalidation
**round trip** on assets whose filename can't change meaning. Added to
`_headers` (hand-maintained root file, not generated):
- `/assets/fonts/*` → `max-age=31536000, immutable`. Google's content-hashed
  woff2 names, ~10 fetches per page load on the text-rendering path. The real
  win here, and a modest one.
- `/assets/peaks/*` → `max-age=86400`, **not** immutable on purpose: a show
  reprocess regenerates the peaks JSON under the same slug filename, and a
  year-long cache would shadow it with no client-side purge.
- `og.png` / `artwork.png` → one week.
- CSS/JS/top-level JSON deliberately left on revalidation.

Verified live: every path returns exactly the intended header, all 6 security
headers still present, nothing regressed.

### `/search/` no-JS fallback, preload, skeleton (commit `9ec7e2a`)
The one genuine defect in the audit. `/search/` was a 3 KB shell rendering
nothing until `search.js` fetched and processed the index — crawlers saw an
inert input and an empty page, and the homepage's `WebSite` schema advertises
a `SearchAction` pointing straight at it (`index.html:21`).
- `<noscript>` with an inline `<style>` hiding `#search-live` (so the dead
  input and filter chips disappear rather than sitting there doing nothing),
  plus prose pointing at `/songs/` and `/` — both genuinely server-rendered,
  so it's a real fallback, not an apology.
- `rel="preload" as="fetch" crossorigin` for the index.
- `.sr-skeleton` placeholder rows sized to match `.sr` so the list doesn't
  jump, with a `prefers-reduced-motion` opt-out.
- `search.js`'s error path clears the skeleton (it would otherwise pulse
  forever on a failed load) and offers the same two no-JS indexes.

Touched `scripts/sitegen/pages.py` (`build_search`), `scripts/site.css`,
`scripts/search.js` — the sources, not the build outputs. `build.py --check`
clean: 31 shows, 679 curated tracks, no orphan song pages.

## ⚠️ Open item — needs a browser, couldn't verify here
No browser on this machine, so the `/search/` markup and headers were verified
but the page was **never watched running**. Two things worth a minute on the
live page:
1. **DevTools → Network on `/search/`: there must be exactly ONE
   `search-index.json` request.** If there are two, the preload's `crossorigin`
   isn't matching the fetch — drop the preload rather than double a 314 KB
   download.
2. **Disable JS and reload** — input and filter chips should vanish, leaving
   the "needs JavaScript" line and the links.

## Gotchas learned this session
- **Verify an audit's claims against the live site before planning around
  them.** A `curl -I` would have taken 30 seconds and would have prevented
  presenting a wrong plan (and calling a non-existent problem "the single
  biggest perf win available"). Run it *before* the plan, not after approval.
- **`rel="preload" as="fetch"` needs `crossorigin` even same-origin.** Without
  it the preload is a `no-cors` request that can't satisfy `fetch()`'s default
  `cors` mode, so the browser downloads the file twice — worse than no preload.
  Commented in place in `pages.py` so it doesn't get "cleaned up" later.
- **Never put `Cache-Control` in `site_worker.js`'s `SECURITY_HEADERS`.** That
  set is applied blanketly to every response via `secure()`, which would
  clobber the per-path values from `_headers` and the 404's `no-store`.
  Cache-Control belongs in `_headers` only — the "keep both in sync" comment
  at `site_worker.js:36` is about the *security* headers, not this.
- **Filename hashing is not the cheap win it looks like here.** Assets aren't
  only referenced from the Python generators — the shipped JS fetches them by
  literal path (`search.js`→`search-index.json`, `songs.js`→
  `song-occurrences.json`, `archive-data.js`→`track-spec.json`, plus dynamic
  `import()` of `wavesurfer.esm.js` and `client-zip.js`). Hashing needs either
  a manifest (extra round trip before every data fetch) or build-time string
  rewriting inside the JS. Not worth it while revalidation is working.

## Durable facts (don't undo)
- **Cloudflare already serves `public, max-age=0, must-revalidate` + ETags on
  everything, and Brotli is on.** Don't re-open "add caching" or "the JSON is
  too big" without re-measuring — both were checked 2026-07-25 and are fine.
- `/assets/fonts/*` is `immutable` because the names are content hashes.
  `/assets/peaks/*` is deliberately only a day — don't "upgrade" it to
  immutable, reprocesses reuse the filename.
- **CSP `script-src 'unsafe-inline'` is still open and known.** Real hardening,
  but a much bigger job: inline bootstrap `<script>`s on every show page would
  each need a nonce or hash. Not started, not scoped.
- Carried forward, still true from 2026-07-23 and **not** addressed this
  session:
  - `publish_show.py`'s local `out/` resume-skip (step 1) still resurrects
    stale files on any multi-attempt publish — not patched in the script.
    Check `~/work/<slug>/out/` by eye before retrying, not just R2/Drive.
  - Every `publish` re-invokes `draft_tracks.py`, which re-derives titles from
    export filenames and silently clobbers manual title fixes. Re-check titles
    right before final commit.
  - `mad-cafe-java-1999-09-09` remains a strong data-backed candidate for the
    [[dynamic-fallback-remediation-roadmap]] (76% of tracks showing the
    dynamic-fallback fingerprint) but is **not approved to start**.
  - `Bash(rclone delete:*)` stays out of `.claude/settings.local.json`'s deny
    list; `purge`/`sync`/`move` remain denied.
  - `mad-sweetwater-2000-02-17` track 14 "Butter" (3:12 vs. pre-session 3:27)
    still worth a listen to confirm the opening chords survived.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Owner's manual (all
tools, all four workflow phases, full version history): `PUBLISHING.md`
(also rendered at `/manual/`). Older phase-by-phase technical detail:
`AUDIO_PROCESSING.md`. Tag vocabulary: `TAGS.md`. Site styling systems and
build-output rules: `CLAUDE.md` → "Site Styling & Templates" / "Known Gotchas".
