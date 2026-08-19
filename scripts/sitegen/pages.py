"""sitegen.pages: one build_* function per page of the site."""
import datetime
import html
import json
import os
import re
import sys
import urllib.parse

from .core import *       # noqa: F401,F403
from .fragments import *  # noqa: F401,F403

def _home_content_blocks(name):
    """Pull the ordered blocks (h2 heading, then each p/ol element) out of a
    scripts/content/*.html prose fragment — lets the homepage show a one-paragraph
    teaser plus an expandable "rest" without rewriting a word of the original."""
    src = content(name)
    heading = re.search(r"<h2>(.*?)</h2>", src, re.S).group(1)
    blocks = re.findall(r"<(?:p|ol)\b[^>]*>.*?</(?:p|ol)>", src, re.S)
    return heading, blocks

def _home_info_card(name, summary_label):
    heading, blocks = _home_content_blocks(name)
    teaser, rest = blocks[0], blocks[1:]
    rest_html = "\n        ".join(rest)
    return f'''    <div class="info-card">
      <h2>{heading}</h2>
      {teaser}
      <details class="info-expand">
        <summary>{esc(summary_label)}</summary>
        <div class="info-expand-body">
        {rest_html}
        </div>
      </details>
    </div>'''

RANDOM_TAPE_SCRIPT = '''
<script>
(function () {
  var btn = document.getElementById('randomTape');
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    fetch('/assets/tracks.json').then(function (r) { return r.json(); }).then(function (rows) {
      if (!rows.length) { location.href = '/'; return; }
      var url = rows[Math.floor(Math.random() * rows.length)].url;
      var i = url.indexOf('#');
      // Autoplay marker for the destination page's focusHashTrack (player.js /
      // wavesurfer.js) — kept out of tracks.json's shared `url` field since other
      // consumers (song-page occurrence links) should only deep-link, not autoplay.
      location.href = i === -1 ? url : url.slice(0, i) + '?autoplay=1' + url.slice(i);
    }).catch(function () { location.href = '/'; });
  });
})();
</script>'''

def build_home():
    """The homepage is a standalone document (like /manual/) rather than
    page_shell + site.css — a deliberately different "tape deck" look the
    rest of the site doesn't share, per the 2026-07-10 redesign.

    Absorbs the old /archive/ page (2026-07-19): the full show listing, sortable
    by date/artist/venue, lives right below the hero instead of a teaser grid
    of 6 "recently added" shows plus a click-through to a separate page —
    once every show was track-listed, "recently added" had nothing left to
    say (see HANDOFF.md for the reasoning). Rendered client-side from
    assets/home-shows.json by home.js, same pattern as /search/ and
    /playlist/, so the collapsed/expanded and grouped/flat states don't need
    prerendering every combination server-side."""
    tracked = [s for s in PUBLIC_SHOWS if s.get("tracks")]
    n_tracks = sum(len(s["tracks"]) for s in tracked)
    songs, _cols = collect_songs()
    n_songs = len(songs)

    notes = [a for a in M["artists"] if a.get("note")]
    artist_links = (f'\n    <div class="artist-links">{" &middot; ".join(a["note"] for a in notes)}</div>'
                     if notes else "")

    return HOME_SHELL.format(
        nav_links="\n    ".join(f'<a href="{href}">{label}</a>'
                                 for label, href in SITE_PAGES[1:]),
        n_shows=len(tracked),
        n_tracks=n_tracks,
        n_songs=n_songs,
        archive_zip_html=_archive_zip_line(),
        why_card=_home_info_card("why.html", "Read the full story"),
        what_card=_home_info_card("about.html", "Read more"),
        artist_links=artist_links,
        random_tape_script=RANDOM_TAPE_SCRIPT,
        jsonld=home_jsonld(),
        playback_ready=PLAYBACK_READY_SNIPPETS["none"],
    )

HOME_SHELL = '''<!DOCTYPE html>
<html lang="en">
<head>
{playback_ready}<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Hannan Tapes</title>
<meta name="description" content="Live recordings archive — Jerry Hannan, Sean Hannan, and Mad Hannans performing at clubs in Marin County in the late 1990s and early 2000s.">
<link rel="canonical" href="https://renedebos.com">
<meta name="theme-color" content="#f5f2ed" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17150f" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="The Hannan Tapes">
<meta property="og:description" content="Live recordings archive — Jerry Hannan, Sean Hannan, and Mad Hannans.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://renedebos.com">
<meta property="og:image" content="https://renedebos.com/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#9834;</text></svg>">
<link rel="alternate" type="application/rss+xml" title="The Hannan Tapes &mdash; Updates" href="https://renedebos.com/feed.xml">
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/home.css">{jsonld}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="wrap">

  <header>
    <a class="mark" href="/" aria-label="Shows &mdash; The Hannan Tapes home">Shows</a>
    <nav>
    {nav_links}
    </nav>
  </header>

  <main id="main">
  <section class="hero">
    <div class="eyebrow">Live &middot; DAT-sourced &middot; primarily 1998&ndash;2003</div>
    <h1>The <em>Hannan</em> Tapes</h1>
    <p class="lede">Live recordings of Jerry Hannan, Sean Hannan, and the Mad Hannans, taped from the audience and soundboard at clubs across Marin County. Every show is digitized, split into songs, and streamable &mdash; hiss and all.</p>
    <div class="actions">
      <a class="btn btn-primary" href="#every-show" id="randomTape">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2" stroke="currentColor" stroke-width="1.3"/></svg>
        Play random tape
      </a>
      <a class="btn btn-secondary" href="/playlist/">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h9M2 8h9M2 12h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13 9v5M13 14l-1.7-1.4M13 14l1.7-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Build a playlist
      </a>
    </div>
  </section>

  <div class="grid-head" id="every-show">
    <h2>Every Show</h2>
    <span class="stat">{n_shows} SHOWS &middot; {n_songs} SONGS &middot; {n_tracks} TRACKS</span>
  </div>

  <div class="sort-bar">
    <div class="sort-group">
      <span class="sort-label">Sort</span>
      <div class="seg-group" role="group" aria-label="Sort shows">
        <button type="button" class="seg" data-sort="date">Date</button>
        <button type="button" class="seg" data-sort="artist">Artist</button>
        <button type="button" class="seg" data-sort="venue">Venue</button>
      </div>
    </div>
  </div>

  <div id="sections"></div>
{archive_zip_html}

  <section class="home-about-grid">
{why_card}
{what_card}
  </section>
  </main>

  <footer>
    <span>Part of <a href="/">The Hannan Tapes</a> archive</span>
    <span><a href="/history/">The Story So Far</a> &middot; <a href="/contact/">Contact</a> &middot; <a href="/feed.xml">RSS</a></span>{artist_links}
  </footer>

</div>
{random_tape_script}
<script src="/assets/player.js"></script>
<script src="/assets/home.js"></script>
</body>
</html>
'''

def _archive_zip_line():
    """The homepage's "download the complete archive" line — a standalone
    ZIP snapshot of every curated FLAC, regenerated occasionally by
    build_archive_zip.py (see data/archive_zip_meta.json), not part of the
    per-show build."""
    archive_zip_path = os.path.join(ROOT, "data", "archive_zip_meta.json")
    if not os.path.exists(archive_zip_path):
        return ""
    meta = json.load(open(archive_zip_path))
    size_gb = round(meta["size_mb"] / 1000, 1)
    updated = meta["generated"][:10]
    btn = dl_button(meta["r2_key"],
                     title=f'Download the complete archive (password protected) · '
                           f'{meta["n_tracks"]} tracks · {size_gb} GB FLAC')
    return f'''
  <p class="archive-zip-line">
    {btn}
    <span>Download the complete archive &middot; {meta["n_tracks"]} tracks &middot; {size_gb} GB FLAC &middot; updated {esc(updated)}</span>
  </p>'''

def build_search():
    return page_shell(
        title="Search — The Hannan Tapes",
        description="Search the Hannan Tapes archive by song, artist, venue, date, or source.",
        url="https://renedebos.com/search/",
        eyebrow="The Hannan Tapes",
        heading="Search",
        tagline="Find a song, show, venue, or date",
        nav=site_nav("Search"),
        # search.js fetches the index immediately on parse, so preloading it
        # alongside the script (rather than after it) is worth ~one round trip
        # on first search. `crossorigin` is required, not decorative: without
        # it the preload is a no-cors request, which can't satisfy fetch()'s
        # default cors mode, and the browser downloads the index twice.
        extra_head='\n<link rel="preload" href="/assets/search-index.json" as="fetch" '
                   'type="application/json" crossorigin>',
        # The live UI is JS-only — the input and filters do nothing until the
        # index lands. Without a fallback this page is blank to crawlers, and
        # the homepage's SearchAction schema points them straight here. /songs/
        # ships the whole concordance server-rendered, so the archive really is
        # reachable without JS; noscript hides the dead controls and says so.
        main='''
  <section class="search">
    <noscript>
      <style>#search-live { display: none; }</style>
      <p class="search-status">Search runs in your browser, so it needs JavaScript.</p>
      <p class="pl-intro">Without it you can still browse the whole archive: the
        <a href="/songs/">Songs index</a> lists every song and each show it was played at,
        and the <a href="/">home page</a> lists every show by date, artist, and venue.</p>
    </noscript>
    <div id="search-live">
      <input id="q" class="search-input" type="search" autocomplete="off" autofocus
             placeholder="Search songs, shows, venues, dates, covers…">
      <div id="filters" class="search-filters"></div>
      <p id="status" class="search-status">Loading…</p>
      <div id="results" class="search-results">
        <div class="sr-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
    </div>
    <p class="pl-intro">Looking for loudness, true peak, workflow version, or damage flags instead? See <a href="/archive-data/">Archive Data</a>.</p>
  </section>''',
        extra_scripts='\n<script src="/assets/search.js"></script>',
    )

def _curated_playlists_html():
    """The archive's own named playlists (top-level "playlists" in
    recordings.json, validated at build). Omitted entirely while empty."""
    pls = M.get("playlists") or []
    if not pls:
        return ""
    by_id = {f'{s["slug"]}-{t["num"]:02d}': t
             for s in M["shows"] for t in (s.get("tracks") or [])
             if isinstance(t.get("num"), int)}
    rows = []
    for pl in pls:
        tracks = [by_id[i] for i in pl["ids"]]
        n = len(tracks)
        href = "/playlist/#p=" + ",".join(pl["ids"])
        desc = (f'<span class="sr-sub">{esc(pl["description"])}</span>'
                if pl.get("description") else "")
        rows.append(f'''      <a class="sr pl-curated-row" href="{esc(href)}">
        <span class="sr-icon">&#9834;</span>
        <span class="sr-main"><span class="sr-title">{esc(pl["name"])}</span>{desc}</span>
        <span class="sr-meta">{n} song{"s" if n != 1 else ""} &middot; {track_total(tracks)}</span>
      </a>''')
    return f'''
    <div class="pl-curated">
      <p class="pl-filter-label">Playlists</p>
      <div class="search-results">
{chr(10).join(rows)}
      </div>
    </div>'''


# ── /playlist/ on the shared PlaybackController (Phase 2 of
# plans/player-consolidation/) ─────────────────────────────────────────────
# Stage 2c (2026-08-14) deleted the legacy playlist.js engine and its
# `?engine=` canary/escape-hatch resolver -- playlist-boot.js is now the
# only engine and mounts unconditionally. See player-consolidation-plan.md's
# Phase 2 section for the 2a (canary) / 2b (default-on) / 2c (legacy
# deletion) history.

def build_playlist():
    # window.WORKER_ORIGIN is emitted for the same reason WS_PEAKS_URL is on
    # show pages: player.js's `const WORKER = '...'` (player.js:2) is a
    # lexical binding, not a `window` property, so a module (playlist-boot.js)
    # can't read it as a bare identifier the way another classic script can.
    worker_origin = f"<script>window.WORKER_ORIGIN={WORKER!r};</script>\n"
    return page_shell(
        title="Playlist — The Hannan Tapes",
        description="Build a custom playlist from the Hannan archive — filter by artist, venue, mood, and source, then hit play.",
        url="https://renedebos.com/playlist/",
        eyebrow="The Hannan Tapes",
        heading="Playlist",
        tagline="Roll your own set list from the archive",
        nav=site_nav("Playlist"),
        # onerror -> 'none', not 'legacy': /playlist/ has no fallback engine to
        # defer to (see playback_ready_onerror's own callers' comments) --
        # 'none' lets a future mini-player construct its own controller on an
        # otherwise-broken page instead.
        extra_scripts=('\n<script src="/assets/track-select.js"></script>'
                       f'\n<script type="module" src="/assets/playlist-boot.js" '
                       f'onerror="{playback_ready_onerror("none")}"></script>'
                       + (VARIANT_UI_SCRIPT if has_variant() else "")),
        pre_scripts=worker_origin,
        playback_ready="deferred",
        main=f'''
  <section class="playlist">
    <p class="pl-intro">Filter the archive by artist, venue, source, or mood, then build a set — a fixed number of songs, a target length, or endless shuffle. Each playlist uses one randomly chosen performance of a song, so one played a dozen times over the years never repeats within a single set.</p>
    <details class="tech-details pl-help">
      <summary>How to build a playlist</summary>
      <p>Right here, the fastest way: pick filters below — artist, venue, source, tags — then either hit <strong>Generate playlist</strong> for an instant random set, or use the + button on individual results to hand-pick songs first.</p>
      <p>You can also build a selection while browsing the rest of the site: on any song's own page, click + next to a performance to add it. A bar at the bottom of the screen keeps a running count and stays there as you move between pages — browse to other songs from the <a href="/songs/">Songs</a> index or search, add more, and go back and forth as many times as you like. When you're ready, click <strong>Build playlist &rarr;</strong> in that bar to bring your picks here.</p>
      <p class="tech-head">Your selection is saved as you go, so it survives a reload or a closed tab, and stays in sync if the site is open in more than one tab.</p>
    </details>
    <div class="pl-presets">
      <button type="button" class="pl-preset" data-preset="mixed45">45-minute mixed set</button>
      <button type="button" class="pl-preset" data-preset="traditional">Traditional &amp; Irish</button>
      <button type="button" class="pl-preset" data-preset="soundboard">Soundboard recordings</button>
    </div>{_curated_playlists_html()}
    <div class="pl-panel">
      <div class="pl-panel-head"><span class="pl-filter-label">Filters</span><button type="button" id="pl-clear" class="pl-clear" hidden>Clear filters</button></div>
      <div id="pl-filters" class="pl-filter-groups"></div>
    </div>
    <div class="pl-panel pl-panel-build">
      <div id="pl-length" class="pl-filter-groups"></div>
      <p id="pl-status" class="search-status">Loading the track catalog…</p>
      <p class="pl-actions"><button id="pl-generate" class="pl-generate" type="button" disabled>Generate playlist</button>
      <button id="pl-save" class="pl-generate pl-share" type="button" hidden>Save playlist</button>
      <button id="pl-share" class="pl-generate pl-share" type="button" hidden>Copy share link</button>
      <button id="pl-download" class="pl-generate pl-share" type="button" hidden>Download ZIP</button>
      <button id="pl-player" class="pl-generate pl-share" type="button" hidden>Open continuous player</button></p>
    </div>
    <div id="pl-saved"></div>{variant_toggle(has_variant())}
    <div id="pl-now" class="pl-now" hidden></div>
    <div id="pl-queue" class="pl-queue"></div>
  </section>''',
    )

def build_updates():
    return page_shell(
        title="Updates — The Hannan Tapes",
        description="Recently added to the Hannan Tapes archive.",
        url="https://renedebos.com/updates/",
        eyebrow="The Hannan Tapes",
        heading="Updates",
        tagline="Recently added to the archive",
        nav=site_nav("Updates"),
        main=f'''
  <section class="updates">
    <ul class="update-list">
{updates_list()}
    </ul>
  </section>''',
    )

def build_history():
    return page_shell(
        title="The Story So Far — The Hannan Tapes",
        description="A behind-the-scenes history of how the Hannan Tapes archive came together.",
        url="https://renedebos.com/history/",
        eyebrow="The Hannan Tapes",
        heading="The Story So Far",
        tagline="A behind-the-scenes history of the archive",
        nav=site_nav(),
        main=content("history.html"),
    )

# Hand-bumped whenever scripts/content/process.html's substance changes
# (facts, figures, pipeline steps) — not on every build, so it reflects
# actual content freshness, matching PUBLISHING.md's "Last updated" convention.
PROCESS_UPDATED = "2026-08-08"

def build_process():
    """Like /manual/, a standalone document — not the site's visual system.
    Grouped with the Manual as the two "how this archive works" reference
    pages, reading well in daylight, distinct from the interactive site."""
    return PROCESS_SHELL.format(body=content("process.html"), updated=PROCESS_UPDATED)

PROCESS_SHELL = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Process — The Hannan Tapes</title>
<meta name="description" content="How a 25-year-old DAT tape becomes a track-listed show page — the archive's full audio pipeline, step by step.">
<link rel="canonical" href="https://renedebos.com/process/">
<style>
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
:root {{
  --bg: #f6f7f8; --panel: #ffffff; --text: #21262b; --muted: #5d6773;
  --border: #dfe3e8; --accent: #135ec4; --chip: #eef1f5;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg: #14171a; --panel: #1c2126; --text: #d8dee5; --muted: #939ea9;
    --border: #333a42; --accent: #77aef7; --chip: #262d34;
  }}
}}
body {{
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16.5px; line-height: 1.68; background: var(--bg); color: var(--text);
}}
.wrap {{ max-width: 40rem; margin: 0 auto; padding: 2rem 1.4rem 5rem; }}
.mast {{ margin-bottom: 2.2rem; }}
.mast .crumb {{ font-size: 13px; }}
.mast .crumb a {{ color: var(--muted); text-decoration: none; }}
.mast .crumb a:hover {{ color: var(--accent); }}
.mast h1 {{ font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; margin-top: 0.7rem; }}
.mast .sub {{ color: var(--muted); margin-top: 0.35rem; font-size: 15px; }}
.mast .updated {{ color: var(--muted); margin-top: 0.5rem; font-size: 12px; }}
main p {{ margin-bottom: 0.95rem; color: var(--muted); }}
main a {{ color: var(--accent); }}
main em {{ color: var(--muted); }}
main strong {{ color: var(--text); }}
.process-intro, .process-outro {{ margin-bottom: 1.6rem; }}
.process-outro {{ margin-top: 1.8rem; }}
.process-outro h2 {{ font-size: 1.3rem; font-weight: 700; margin-bottom: 0.7rem; color: var(--text); }}
.process-outro .reasons {{ padding-left: 1.3rem; margin-bottom: 1rem; }}
.process-outro .reasons li {{ margin-bottom: 0.6rem; color: var(--muted); }}
.flow {{ display: flex; flex-direction: column; }}
.flow-stage {{
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 1.1rem 1.3rem 1.15rem;
}}
.flow-stage h2 {{ font-size: 1.2rem; font-weight: 700; margin: 0.15rem 0 0.5rem; color: var(--text); }}
.flow-stage p {{ margin-bottom: 0.6rem; }}
.flow-stage p:last-of-type {{ margin-bottom: 0; }}
.flow-kind {{
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600;
  color: var(--accent);
}}
.flow-manual {{ border-left: 3px solid var(--accent); }}
.flow-optional {{
  border: 1px dashed var(--border); border-radius: 8px;
  padding: 0.6rem 0.8rem; background: var(--chip); margin-top: 0.6rem;
}}
.flow-loc {{ display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.75rem; }}
.flow-loc span {{
  font-size: 11px; color: var(--muted); border: 1px solid var(--border);
  border-radius: 999px; padding: 0.1rem 0.6rem; background: var(--bg);
}}
.flow-arrow {{ text-align: center; color: var(--accent); font-size: 1.3rem; line-height: 1; padding: 0.45rem 0; }}
.proc-status.pre-edit {{
  display: inline-block; border: 1px solid var(--accent); color: var(--accent);
  border-radius: 999px; font-size: 10px; letter-spacing: 0.04em; font-weight: 600;
  padding: 0.05rem 0.5rem; margin-left: 0.3rem;
}}
main code {{
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.84em; background: var(--chip); border: 1px solid var(--border);
  padding: 0.08em 0.4em; border-radius: 5px; white-space: nowrap;
}}
@media print {{ body {{ background: #fff; color: #000; font-size: 11.5pt; }} .crumb {{ display: none; }} }}
</style>
</head>
<body>
<div class="wrap">
  <header class="mast">
    <div class="crumb"><a href="/">&larr; The Hannan Tapes</a> &nbsp;&middot;&nbsp; <a href="/manual/">The Manual</a></div>
    <h1>The Process</h1>
    <p class="sub">From DAT tape to show page, step by step.</p>
    <p class="updated">Last updated {updated}</p>
  </header>
  <main>
{body}
  </main>
</div>
</body>
</html>
'''

def build_manual():
    """Render PUBLISHING.md (the repo's owner's manual) as /manual/ — built
    from the same file every build, so an edited manual can never go stale on
    the site (CI's fresh-build gate enforces it). Deliberately NOT the site's
    visual style: this is a working manual, so it gets its own standalone
    document — readable type, a table of contents, step numbering, callouts,
    and a print stylesheet."""
    md = open(os.path.join(ROOT, "PUBLISHING.md")).read()
    md = re.sub(r"^# .*\n", "", md)          # the template provides the heading
    body = md_to_html(md)
    toc = "\n".join(
        f'      <a class="t{lvl}" href="#{hid}">{txt}</a>'
        for lvl, hid, txt in re.findall(
            r'<h([23]) id="([^"]+)">(?:<[^>]+>)*([^<]+)', body))
    return MANUAL_SHELL.format(toc=toc, body=body)

MANUAL_SHELL = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Manual — The Hannan Tapes</title>
<meta name="description" content="The owner's manual for processing and publishing a show, from Audacity to the live site.">
<link rel="canonical" href="https://renedebos.com/manual/">
<style>
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
:root {{
  --bg: #f6f7f8; --panel: #ffffff; --text: #21262b; --muted: #5d6773;
  --border: #dfe3e8; --accent: #135ec4; --chip: #eef1f5;
  --warn-bg: #fdf3e0; --warn-bd: #d9a13e; --note-bg: #e9f1fd; --note-bd: #5b93e8;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg: #14171a; --panel: #1c2126; --text: #d8dee5; --muted: #939ea9;
    --border: #333a42; --accent: #77aef7; --chip: #262d34;
    --warn-bg: #2b2312; --warn-bd: #c69a44; --note-bg: #182742; --note-bd: #4f83d6;
  }}
}}
html {{ scroll-behavior: smooth; }}
body {{
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16.5px; line-height: 1.68; background: var(--bg); color: var(--text);
}}
.wrap {{ max-width: 72rem; margin: 0 auto; padding: 2rem 1.4rem 5rem; }}
.mast {{ margin-bottom: 2.2rem; }}
.mast .crumb {{ font-size: 13px; }}
.mast .crumb a {{ color: var(--muted); text-decoration: none; }}
.mast .crumb a:hover {{ color: var(--accent); }}
.mast h1 {{ font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; margin-top: 0.7rem; }}
.mast .sub {{ color: var(--muted); margin-top: 0.35rem; font-size: 15px; }}
.cols {{ display: grid; grid-template-columns: 1fr; gap: 2.5rem; }}
@media (min-width: 1080px) {{
  .cols {{ grid-template-columns: 15rem minmax(0, 46rem); }}
  .toc {{ position: sticky; top: 1.2rem; align-self: start; max-height: calc(100vh - 3rem); overflow-y: auto; }}
}}
.toc {{ border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 1rem 1.1rem; font-size: 13.5px; }}
.toc .toc-title {{ font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin-bottom: 0.5rem; }}
.toc a {{ display: block; color: var(--muted); text-decoration: none; padding: 0.18rem 0; line-height: 1.45; }}
.toc a:hover {{ color: var(--accent); }}
.toc a.t2 {{ font-weight: 600; color: var(--text); margin-top: 0.45rem; }}
.toc a.t2:hover {{ color: var(--accent); }}
.toc a.t3 {{ padding-left: 0.9rem; }}
main h2 {{ font-size: 1.45rem; font-weight: 700; letter-spacing: -0.01em; margin: 2.6rem 0 0.9rem; padding-top: 1.6rem; border-top: 1px solid var(--border); }}
main h2:first-child {{ margin-top: 0; padding-top: 0; border-top: none; }}
main h3 {{ font-size: 1.12rem; font-weight: 650; margin: 2rem 0 0.7rem; }}
main p {{ margin-bottom: 0.95rem; }}
main a {{ color: var(--accent); }}
main hr {{ border: none; margin: 0.4rem 0; }}
main em {{ color: var(--muted); }}
main code {{
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.84em; background: var(--chip); border: 1px solid var(--border);
  padding: 0.08em 0.4em; border-radius: 5px; white-space: nowrap;
}}
main ul {{ padding-left: 1.4rem; margin-bottom: 1rem; }}
main li {{ margin-bottom: 0.55rem; }}
main li ul {{ margin: 0.45rem 0 0; }}
/* numbered steps as cards with big circled numerals (number from data-n) */
main ol {{ list-style: none; margin-bottom: 1.1rem; }}
main ol > li {{
  position: relative;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 0.85rem 1.1rem 0.85rem 3.4rem; margin-bottom: 0.6rem;
}}
main ol > li::before {{
  content: attr(data-n); position: absolute; left: 0.95rem; top: 0.95rem;
  width: 1.65rem; height: 1.65rem; border-radius: 50%;
  background: var(--accent); color: #fff; font-weight: 700; font-size: 0.85rem;
  display: flex; align-items: center; justify-content: center;
}}
blockquote.callout {{
  border-radius: 10px; padding: 0.85rem 1.1rem 0.85rem 1rem; margin: 0.9rem 0 1.1rem;
  border-left: 4px solid var(--note-bd); background: var(--note-bg);
}}
blockquote.callout.warn {{ border-left-color: var(--warn-bd); background: var(--warn-bg); }}
blockquote.callout p {{ margin: 0; }}
.md-scroll {{ overflow-x: auto; margin-bottom: 1.2rem; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }}
main table {{ border-collapse: collapse; width: 100%; font-size: 14.5px; }}
main th, main td {{ text-align: left; padding: 0.6rem 0.85rem; vertical-align: top; line-height: 1.55; }}
main th {{
  font-size: 11.5px; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--muted); border-bottom: 2px solid var(--border);
}}
main td {{ border-top: 1px solid var(--border); }}
main tbody tr:nth-child(even) td {{ background: color-mix(in srgb, var(--chip) 55%, transparent); }}
@media print {{
  body {{ background: #fff; color: #000; font-size: 11.5pt; }}
  .toc, .crumb {{ display: none; }}
  .cols {{ display: block; }}
  main ol > li, .md-scroll, .toc {{ border-color: #bbb; }}
  main a {{ color: #000; text-decoration: none; }}
}}
</style>
</head>
<body>
<div class="wrap">
  <header class="mast">
    <div class="crumb"><a href="/">&larr; The Hannan Tapes</a> &nbsp;&middot;&nbsp; <a href="/process/">The Process</a></div>
    <h1>Publishing a Show &mdash; Owner&rsquo;s Manual</h1>
    <p class="sub">From the whole-show WAV in Audacity to the live site, and every tool along the way.</p>
  </header>
  <div class="cols">
    <nav class="toc" aria-label="Contents">
      <div class="toc-title">Contents</div>
{toc}
    </nav>
    <main>
{body}
    </main>
  </div>
</div>
</body>
</html>
'''

VARIANT_UI_SCRIPT = '\n<script type="module" src="/assets/variant-ui.js"></script>'

def build_player():
    """/player/ — a dedicated popup window for continuous playback (see
    scripts/continuous-player.js and player.js's sendToPlayer()). Deliberately
    NOT page_shell(): no nav/footer chrome, since this is a small window a
    visitor opens once and leaves alone, not a normal nav destination — same
    reasoning as /manual/. Unlike /manual/'s own bespoke design system, this
    reuses the main site's stylesheet/fonts and its existing .pl-now/.pl-btn/
    .pl-row player styling so it still feels like part of the archive.

    The variant control is templated in here rather than baked into
    PLAYER_SHELL so a checkout with no rendered variant doesn't ship a dead
    toggle -- same has_variant() gate the other client-rendered pages use."""
    return (PLAYER_SHELL
            .replace("<!--VARIANT_PICK-->", variant_toggle(has_variant()))
            .replace("<!--VARIANT_SCRIPT-->", VARIANT_UI_SCRIPT if has_variant() else ""))

PLAYER_SHELL = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Hannan Tapes — Player</title>
<meta name="description" content="Continuous playback window for The Hannan Tapes — keep listening while you browse.">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f5f2ed" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17150f" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#9834;</text></svg>">
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/site.css">
<style>
  body { max-width: 26rem; margin: 0 auto; padding: 1.1rem 1.1rem 3rem; }
  .cp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8rem; margin-bottom: 0.8rem; }
  .cp-head a { font-size: 12px; color: var(--muted); text-decoration: none; }
  .cp-head a:hover { color: var(--accent); }
  .cp-head h1 { font-family: var(--serif); font-size: 1.15rem; font-weight: 500; margin: 0; }
  .cp-empty { font-size: 13px; color: var(--muted); font-weight: 300; line-height: 1.6; }
  .cp-empty a { color: var(--accent); }
</style>
</head>
<body>
  <div class="cp-head">
    <h1>&#9834; Player</h1>
    <a href="/playlist/">Build a playlist &rarr;</a>
  </div>
  <!--VARIANT_PICK-->
  <div id="cp-now" class="pl-now"></div>
  <p id="cp-status" class="search-status"></p>
  <div id="cp-queue"></div>
  <script src="/assets/continuous-player.js"></script><!--VARIANT_SCRIPT-->
</body>
</html>
'''

def build_archive_data():
    """/archive-data/ — a single filterable/sortable table of every track's
    catalog + audio-processing spec data (loudness, true peak, LRA, workflow
    version, treatment, damage flags), for managing the processing rollout
    across the whole archive at once. Rene-facing, not a normal nav
    destination: uses page_shell() (not a bespoke shell, unlike /manual/)
    since it's an interactive tool that belongs to the site's app-like pages,
    but is deliberately absent from SITE_PAGES/EXTRA_PAGES (so: no nav link,
    no sitemap entry) and noindex'd, matching /player/'s "unlisted" treatment
    for the same reason: not content for a visitor to stumble into."""
    return page_shell(
        title="Archive Data — The Hannan Tapes",
        description="Every track in the archive with its catalog and audio-processing spec data, filterable and sortable.",
        url="https://renedebos.com/archive-data/",
        eyebrow="The Hannan Tapes",
        heading="Archive Data",
        tagline="Every track's catalog and processing spec data, in one table",
        nav=site_nav(),
        extra_head='\n<meta name="robots" content="noindex">',
        extra_scripts='\n<script src="/assets/archive-data.js"></script>',
        main='''
  <section class="archive-data">
    <p class="pl-intro">Every track in the archive with the spec data collected for it — loudness, true peak, LRA, workflow version, treatment, tags, and damage flags. The tinted <strong>Loud</strong> columns describe the separate −14 LUFS streaming variant, including what it cost in loudness range (ΔLRA); everything else describes the −20 archive master. Click a treatment cell for the full limiter breakdown of either render. Filter or search, click a column to sort, click a song to jump to its show page.</p>
    <input id="ad-q" class="search-input" type="search" autocomplete="off" placeholder="Search song, show, venue, songwriter…">
    <div class="pl-panel">
      <div class="pl-panel-head"><span class="pl-filter-label">Filters</span><button type="button" id="ad-clear" class="pl-clear" hidden>Clear filters</button></div>
      <div id="ad-filters" class="pl-filter-groups"></div>
    </div>
    <p id="ad-status" class="search-status">Loading…</p>
    <div class="tech-scroll">
      <table class="tech-table" id="ad-table">
        <thead><tr id="ad-head"></tr></thead>
        <tbody id="ad-tbody"></tbody>
      </table>
    </div>
  </section>''',
    )

def build_contact():
    return page_shell(
        title="Contact — The Hannan Tapes",
        description="Questions or comments about the recordings? Get in touch.",
        url="https://renedebos.com/contact/",
        eyebrow="The Hannan Tapes",
        heading="Contact",
        tagline="Questions or comments about the recordings",
        nav=site_nav(),
        main=contact_block(),
    )

# ── shared-player rollout allowlist (plans/player-consolidation/, Phase 1
# Steps 4-5b) ────────────────────────────────────────────────────────────────
# Show pages listed here run the shared PlaybackController (player-boot.js)
# instead of the legacy player.js. player.js stays on every page as the
# runtime fallback either way. (The legacy wavesurfer.js waveform-row engine
# that used to pair with it was removed in Step 5c — see plan.md.)
#
# Step 5b (2026-08-14) widened this from an explicit 3-page allowlist to
# every public show, computed from PUBLIC_SHOWS -- a newly added show is
# automatically covered from here on, with no manual sync step. The
# membership gate below (`if show["slug"] in CONTROLLER_ENGINE_SLUGS:`) is
# unchanged; only what populates the set changed.
# CONTROLLER_ENGINE_EXCLUDED_SLUGS is the escape hatch for a targeted
# rollback of one specific page (a page-specific bug, not an architectural
# one) without reverting the whole rollout -- see plan.md's Step 5a rollback
# design for why this shape (edit the set + rebuild + PR), not a runtime flag.
# PARTIAL since Step 5c: with wavesurfer.js gone, an excluded page's
# waveform track rows have no engine at all (dead, not degraded) -- only the
# Full Recording card recovers via player.js. This is the accepted tradeoff
# documented in plan.md's Step 5c entry, not a bug in this mechanism, but a
# real incident rollback via this set does NOT fully restore the page.
#
# The three pages Step 4/5a's browser-pass verification specifically covered
# for their differing shapes -- still worth knowing if a markup-shape bug
# ever surfaces:
#   jerry-cafe-java-1999-05-27   plain: waveform rows, one Full Recording card
#   jerry-cafe-java-1999-03-25   two canonical Full Recording parts, so two hero
#                                cards live on one page at once
#   mad-sweetwater-2000-10-17    an alternate transfer sharing the canonical
#                                recording's MP3 stream proxy — the case that
#                                forced recording ids to key on the lossless
#                                original — inside a collapsed <details>
#
# Not covered, because no *published* show has the shape: a page with no track
# list at all. jerry-western-saloon-2025-07-03 is the only track-less show and
# it's currently hidden, so it generates no page.
CONTROLLER_ENGINE_EXCLUDED_SLUGS = set()
CONTROLLER_ENGINE_SLUGS = {s["slug"] for s in PUBLIC_SHOWS} - CONTROLLER_ENGINE_EXCLUDED_SLUGS

def build_show(show):
    artist = next(a for a in M["artists"] if a["id"] == show["artist"])
    canon = [r for r in show["recordings"] if not r["alternate"]]
    alts = [r for r in show["recordings"] if r["alternate"]]

    # Split tracks render as wavesurfer waveforms when pre-computed peaks exist for
    # this show; otherwise they fall back to the classic progress-bar player.
    peaks_path = os.path.join(ROOT, "data", "peaks", f"{show['slug']}.json")
    has_waves = bool(show.get("tracks")) and os.path.exists(peaks_path)

    parts = []

    # Audio-processing status badge — shown on every show page (the technical-data
    # table only appears for already-processed shows).
    parts.append(status_line(show))

    # Highlight flag — Rene's editorial call on the performance, independent
    # of the audio-processing badge above (a rough tape can still be a highlight).
    if show.get("highlight"):
        parts.append(f'\n  <p class="highlight-line">{HIGHLIGHT_STAR_SVG} Highlight show</p>')

    if show.get("description"):
        desc = "".join(f"\n    <p>{p}</p>" for p in show["description"])
        parts.append(f'''
  <section class="about">
    <h2>About This Show</h2>{desc}
  </section>''')

    # Processing provenance (if any): drives the technical-data table and supplies
    # per-track audio fingerprints used as stream cache-busters.
    proc = load_processing(show["slug"]) if show.get("tracks") else None
    proc_tracks = proc.get("tracks", {}) if proc else {}
    var = load_variant(show["slug"])
    var_tracks = var.get("tracks", {}) if var else {}
    # Read again at script-emission time, so it must exist on every path — a
    # track-less show never enters the branch that used to define it.
    any_loud = bool(var_tracks)

    if show.get("tracks"):
        has_flac = any(t.get("flac") for t in show["tracks"])
        zip_html = ""
        if has_flac:
            zip_html = show_zip_button_html(show)
        rows = []
        prev_group = None
        for t in show["tracks"]:
            # Some shows splice in a second batch of tracks from a separate source
            # tape (e.g. a mislabeled/distorted reel found later); "group" labels
            # that batch with its own divider inside the same track list.
            grp = t.get("group")
            if grp != prev_group:
                if grp:
                    rows.append(f'''      <div class="track-group-head">
        <div class="group-label-bare">{esc(grp)}</div>
      </div>''')
                prev_group = grp
            # Version the stream URL with the track's MD5 (when known) so the edge
            # caches hard yet a re-normalized upload goes live instantly.
            ver = (proc_tracks.get(str(t["num"]), {}).get("md5") or "")[:12] or None
            stream = stream_url(t["file"], ver)
            # Loud variant, only when this track actually has one rendered.
            vt = var_tracks.get(str(t["num"]))
            loud_stream = (stream_url(variant_key(t["file"]),
                                      (vt.get("mp3_md5") or "")[:12] or None)
                           if vt else None)
            sizes = []
            if t.get("flac_size_mb"):
                sizes.append(f'FLAC {t["flac_size_mb"]} MB')
            if t.get("size_mb"):
                sizes.append(f'MP3 {t["size_mb"]} MB')
            # A track may override the show artist (e.g. a guest singer).
            track_artist = t.get("artist") or artist["name"]
            proc_ver = proc_tracks.get(str(t["num"]), {}).get("ver")
            info_rows = [
                ["Artist", track_artist],
                ["Song", t["title"]],
                ["Venue", show["venue"] or "—"],
                ["Date", show["date"] or "Unknown date"],
                ["Format", "FLAC + MP3" if t.get("flac") else "MP3"],
                ["Size", " · ".join(sizes) or "—"],
                ["Process version", f"v{proc_ver}" if proc_ver else "Not yet processed"],
            ]
            # Some tracks have audible tape damage / dropouts; flag them inline
            # with a small badge and in the track info popup.
            if t.get("dropouts"):
                info_rows.append(["Condition", "Significant tape damage — audible dropouts"])
            info = esc(json.dumps(info_rows, ensure_ascii=False))
            badge = ('<span class="track-badge" title="Significant tape damage'
                     ' — audible dropouts">dropouts</span>') if t.get("dropouts") else ""
            title_html = (f'<div class="track-main"><span class="track-title" data-info="{info}">'
                          f'{esc(t["title"])}</span>{badge}</div>')
            play_label = esc(f'{t["title"]}, {track_artist}, {date_with_subtitle(show)}')
            # Password-protected lossless FLAC download when a FLAC exists;
            # otherwise the track is stream-only.
            dl_btns = []
            if t.get("flac"):
                flac_title = "Download FLAC (password protected)" + (f" · {t['flac_size_mb']} MB" if t.get("flac_size_mb") else "")
                dl_btns.append(dl_button(t["flac"], title=flac_title))
            # Playlist-selection id: {show-slug}-{tracknum:02d}, matching assets/tracks.json.
            track_id = f'{show["slug"]}-{t["num"]:02d}'
            add_btn = track_add_button(track_id)
            # The shared player reads this; nothing consumes it until the
            # controller is switched on for a page (see the plan's Step 4).
            # play_label is rebuilt unescaped here on purpose — playable_item_attr
            # escapes the whole JSON itself, so passing the esc()'d one would
            # double-escape it.
            item_attr = playable_item_attr(
                item_id=track_id,
                kind="track",
                stream=stream,
                title=t["title"],
                artist=track_artist,
                venue=show.get("venue"),
                date=show.get("date"),
                date_display=date_with_subtitle(show),
                duration_label=t["duration"],
                # Peaks JSON is keyed by track number as a string; a row whose
                # key is missing from the fetched map just renders without a
                # waveform, per-row rather than per-show.
                peaks_key=str(t["num"]) if has_waves else None,
                page_url=f'{show_url(show)}#track-{t["num"]}',
                play_label=f'{t["title"]}, {track_artist}, {date_with_subtitle(show)}',
                lossless_file=t.get("flac"),
                lossless_size_mb=t.get("flac_size_mb"),
                dropouts=t.get("dropouts"),
                loud_stream=loud_stream,
            )
            if has_waves:
                # waveform replaces the progress bar; the download (if any) keeps the
                # .ws-dl wrapper so the mobile grouping styles apply.
                dl = ('\n        <div class="ws-dl">' +
                      "".join("\n          " + b for b in dl_btns) +
                      "\n        </div>") if dl_btns else ""
                rows.append(f'''      <div class="track-row ws-track" id="track-{t["num"]}" data-trackid="{t["num"]}" data-src="{esc(stream)}" {item_attr}>
        <button class="play-btn" aria-label="Play {play_label}" data-play-label="{play_label}">{PLAY_SVG}</button>
        <span class="track-num">{t["num"]:02d}</span>
        {title_html}
        <div class="ws-wave"></div>
        <span class="time-label current" data-duration="{esc(t["duration"])}">0:00 / {esc(t["duration"])}</span>{dl}
        {add_btn}
      </div>''')
            else:
                dl = "".join("\n        " + b for b in dl_btns)
                rows.append(f'''      <div class="track-row custom-player" id="track-{t["num"]}" data-src="{esc(stream)}" {item_attr}>
        <button class="play-btn" aria-label="Play {play_label}" data-play-label="{play_label}">{PLAY_SVG}</button>
        <span class="track-num">{t["num"]:02d}</span>
        {title_html}
        <span class="time-label current" data-duration="{esc(t["duration"])}">0:00 / {esc(t["duration"])}</span>{dl}
        <input type="range" class="progress-range" min="0" max="1000" value="0" step="1" aria-label="Seek {play_label}" aria-valuetext="0:00 of {esc(t["duration"])}">
        {add_btn}
      </div>''')
        hint = ("Every song streams in full &middot; lossless FLAC downloads are password protected"
                if has_flac else "Every song streams in full")
        parts.append(f'''
  <section id="tracks">
    <div class="tracks-head">
      <div class="group-label-bare">Tracks &middot; {len(show["tracks"])} songs &middot; {track_total(show["tracks"])}</div>
      <div class="tracks-actions">
        <button type="button" class="select-all" data-target=".track-list">Select all</button>
        {zip_html}
      </div>
    </div>
    <p class="track-hint">{hint}</p>{variant_toggle(any_loud)}
    <div class="track-list" data-autoplay-next>
{chr(10).join(rows)}
    </div>
  </section>''')

    # Technical-data table for shows that have been through the audio_processing
    # workflow (renders all tracks; loudness columns filled where measured).
    if proc:
        parts.append(tech_data_section(show, proc, var))

    cards = []
    for r in canon:
        title = r["label"] or "Complete show"
        meta = [("Source", r["source"]), ("Format", r["format"]), ("Size", r["size"])]
        play_label = f'{title}, {artist["name"]}, {date_with_subtitle(show)}'
        cards.append(recording_card(title, meta, r["source"], r["file"], r.get("stream"), play_label,
                                    show=show))
    label = "Full Recording" if len(canon) == 1 else "Full Recording &middot; " + f"{len(canon)} parts"
    streamed = any(r.get("stream") for r in canon)
    hint = ('\n    <p class="track-hint">Full shows stream as 320&nbsp;kbps MP3 &mdash; '
            'the lossless original download is password protected.</p>'
            if streamed else "")
    parts.append(f'''
  <section>
    <div class="group-label-bare">{label}</div>{hint}
    <div class="recording-list">
{chr(10).join(cards)}
    </div>
  </section>''')

    if alts:
        cards = []
        for r in alts:
            meta = [("Source", r["source"]), ("Format", r["format"]), ("Size", r["size"])]
            play_label = f'{r["alt_label"]}, {artist["name"]}, {date_with_subtitle(show)}'
            cards.append(recording_card(r["alt_label"], meta, r["source"], r["file"], r.get("stream"), play_label,
                                        show=show))
        parts.append(f'''
  <section>
    <details class="alt-details">
      <summary>Alternate transfers ({len(alts)}) &mdash; other digitizations of the same tape</summary>
      <div class="recording-list">
{chr(10).join(cards)}
      </div>
    </details>
  </section>''')

    wav_note = ('\n  <p class="wav-note">Full-show downloads are password protected. '
                'Streaming may take a moment to start for large files.</p>'
                if any(r["format"] in ("WAV", "FLAC") for r in show["recordings"]) else "")

    venue_city = show["venue"].split(", ")[-1] if show["venue"] and ", " in show["venue"] else None
    tagline_bits = [b for b in [
        f"{venue_city}, California" if venue_city else show["venue"],
        date_with_subtitle(show),
        SOURCE_LABEL.get(show["source"], show["source"]),
    ] if b]

    extra_scripts = '\n<script src="/assets/track-select.js"></script>'
    if has_waves:
        # Emit the peaks to a served, cacheable path (data/ is .assetsignore'd),
        # rather than inlining ~58 KB into every page. Fetched by the shared
        # controller's player-boot.js (attachPeaks()) via WS_PEAKS_URL.
        write(f"assets/peaks/{show['slug']}.json", open(peaks_path).read())
        extra_scripts += f'\n<script>window.WS_PEAKS_URL = "/assets/peaks/{show["slug"]}.json";</script>'

    # Shared player engine, for allowlisted shows only. The flag has to be set
    # before player.js (hence pre_scripts); player-boot.js goes last so
    # player.js has already registered its DOMContentLoaded fallback by the
    # time it claims the page. player.js stays on the page on purpose — it's
    # the runtime fallback if this module never mounts, not dead weight.
    # The variant control is independent of which engine the page runs: it only
    # writes the shared preference, and whatever engine is mounted reads it.
    if any_loud:
        extra_scripts += '\n<script type="module" src="/assets/variant-ui.js"></script>'

    pre_scripts = ""
    if show["slug"] in CONTROLLER_ENGINE_SLUGS:
        pre_scripts = "<script>window.PLAYER_ENGINE = 'controller';</script>\n"
        # onerror: a real 'error' event fires only on a genuine module
        # load/parse failure (404, syntax error) -- see PLAYBACK_READY_SNIPPETS'
        # comment and plans/dynamic-hugging-rossum.md's "Blocker A continued"
        # section. An in-script throw during mount is a SEPARATE signal,
        # handled inside player-boot.js's own auto-run catch block instead.
        extra_scripts += (f'\n<script type="module" src="/assets/player-boot.js" '
                          f'onerror="{playback_ready_onerror("legacy")}"></script>')

    if proc:
        # Open the collapsed technical-data table when linked to via #technical-data
        # (e.g. the "view data" link on the Updates page).
        extra_scripts += ('\n<script>(function(){function o(){var e=location.hash&&'
                          'document.getElementById(location.hash.slice(1));'
                          "if(e&&e.tagName==='DETAILS')e.open=true;}o();"
                          'addEventListener("hashchange",o);})();</script>')

    return page_shell(
        title=f"{show_title(show)} — {show['date'] or 'Unknown date'}",
        description=f"{show_title(show)}, {date_with_subtitle(show)} — {SOURCE_LABEL.get(show['source'], show['source'])}. Stream or download.",
        url=f"https://renedebos.com{show_url(show)}",
        eyebrow="The Hannan Tapes",
        heading=f"{esc(artist['name'])}<br><em>Live at {esc(show['venue_short'])}</em>",
        tagline=" &middot; ".join(esc(b) for b in tagline_bits),
        nav=site_nav(),
        main="".join(parts) + wav_note,
        extra_scripts=extra_scripts,
        extra_head=show_jsonld(show, artist),
        pre_scripts=pre_scripts,
        # Deterministic at build time: allowlisted shows defer to
        # player-boot.js's own resolution; an excluded slug never emits a
        # boot module at all, so 'legacy' (player.js's synchronous fallback)
        # is the only outcome that page will ever have.
        playback_ready="deferred" if show["slug"] in CONTROLLER_ENGINE_SLUGS else "legacy",
    )

# ── song-page migration onto the shared controller (Phase 3 Stage
# 3a-foundation) ────────────────────────────────────────────────────────────
# Unconditional on every song page from the start -- unlike show pages'
# CONTROLLER_ENGINE_SLUGS rollout (which needed a per-page canary/rollback
# allowlist because every show page's markup shape had to be individually
# verified against real waveform/hero-card combinations), song occurrence
# rows are one uniform shape everywhere, so canary/default/removal-to-
# fallback-only collapse into one step here. Reuses the SAME window.PLAYER_
# ENGINE/PLAYER_ENGINE_MOUNTED flag pair show pages use: a document is never
# both a show page and a song page, so there is no ambiguity in sharing the
# name, and player.js's existing engine-selection gate (its
# `window.PLAYER_ENGINE === 'controller'` check) needs no changes at all to
# also cover song pages -- verified directly against player.js's real source
# in scripts/test-player-boot.mjs's two gate tests.
SONG_ENGINE_FLAG = "<script>window.PLAYER_ENGINE = 'controller';</script>\n"
# onerror -> 'legacy': song-boot.js's fallback is initCustomPlayers()
# (retained, not deleted -- see songs.js/build_songs_index()'s own comment),
# mirroring player-boot.js's show-page handshake exactly.
SONG_BOOT_SCRIPT = (f'\n<script type="module" src="/assets/song-boot.js" '
                    f'onerror="{playback_ready_onerror("legacy")}"></script>')

def build_songs_index():
    songs, cols = collect_songs()
    multi = sum(1 for s in songs if s["plays"] > 1)

    present = [a for a in _ARTIST_ORDER if any(a in s["artists"] for s in songs)]
    legend = "".join(f'<span class="legend-item"><span class="artist-dot artist-{a}"></span>'
                     f'{esc(ARTIST_SHORT.get(a, a))}</span>' for a in present)

    items = []
    for s in songs:
        # Fixed slot per artist (Jerry | Mad | Sean order), filled where they played
        # this song and an empty placeholder where they didn't — so the dots line up
        # into scannable per-artist columns down the list.
        chips = "".join(
            (f'<span class="artist-dot artist-{a}" title="{esc(ARTIST_SHORT.get(a, a))}"></span>'
             if a in s["artists"]
             else '<span class="artist-dot empty"></span>')
            for a in present)
        # Occurrence rows (each with its own player) aren't rendered here — with
        # 400+ of them across the index that's a lot of embedded HTML and live
        # audio elements for content most visitors never open. songs.js fetches
        # assets/song-occurrences.json and renders a song's rows into
        # .song-occs the first time its <details> is expanded.
        items.append(f'''    <details class="song-item" data-artists="{' '.join(s['artists'])}" data-plays="{s['plays']}" data-title="{esc(song_norm(s['canonical']))}">
      <summary>
        <span class="song-plays">{s['plays']}&times;</span>
        <a class="song-name" href="/songs/{s['slug']}/">{esc(s['canonical'])}</a>
        <span class="song-chips">{chips}</span>
      </summary>
      <div class="song-occs" data-song="{s['slug']}"></div>
    </details>''')

    col_head = "".join(
        f'<th class="artist-{c["artist"]}" data-artist="{c["artist"]}">'
        f'<a href="{esc(show_url(c))}" title="Open {esc(c.get("venue_short") or c.get("venue") or "this show")} &middot; {esc(c.get("date") or "")}">'
        f'<span class="g-venue">{esc(c.get("venue_short") or c.get("venue") or "—")}</span>'
        f'<span class="g-date">{esc((c.get("date") or "??")[:10])}</span></a></th>' for c in cols)
    rows = []
    for s in songs:
        by_show = {}
        for o in s["occ"]:
            by_show.setdefault(o["slug"], o)
        cells = []
        for c in cols:
            o = by_show.get(c["slug"])
            if o:
                cells.append(f'<td class="hit artist-{o["artist"]}" data-artist="{c["artist"]}"><a href="{esc(o["url"])}#track-{o["num"]}" '
                             f'title="{esc(s["canonical"])} &middot; {esc(o["date"])}">&#9679;</a></td>')
            else:
                cells.append(f'<td data-artist="{c["artist"]}"></td>')
        rows.append(f'<tr data-artists="{" ".join(s["artists"])}" data-plays="{s["plays"]}" '
                    f'data-title="{esc(song_norm(s["canonical"]))}">'
                    f'<th class="g-song"><a href="/songs/{s["slug"]}/" title="{esc(s["canonical"])}">{esc(s["canonical"])}</a>'
                    f'<span class="g-count">{s["plays"]}&times;</span></th>{"".join(cells)}</tr>')

    main = f'''
  <section class="about">
    <h2>Every Song</h2>
    <p>
      Every song across the {len(cols)} shows that have been split into individual tracks &mdash; <strong>{len(songs)} distinct songs</strong>, {multi} of them played more than once. Click a song to see every time it was played, each with a player and a link to that exact performance. The same songs turn up across Jerry, the Mad Hannans, and Sean &mdash; that shared repertoire is what this page is for.
    </p>
  </section>
  <div class="songs-controls">
    <input type="search" id="song-search" class="song-search" placeholder="Search songs&hellip;" autocomplete="off" aria-label="Search songs">
    <div class="seg" data-role="view"><button data-view="list" class="active">List</button><button data-view="grid">Grid</button></div>
    <div class="seg" data-role="sort"><button data-sort="plays" class="active">Most&nbsp;played</button><button data-sort="az">A&ndash;Z</button></div>
    <div class="seg" data-role="artist"><button data-artist="all" class="active">All</button><button data-artist="jerry">Jerry</button><button data-artist="mad">Mad</button><button data-artist="sean">Sean</button></div>
  </div>
  <div class="song-legend" aria-hidden="true">{legend}</div>{variant_toggle(has_variant())}
  <p class="songs-empty" id="songs-empty" hidden>No songs match &mdash; try a different search.</p>
  <div class="song-list" id="song-list">
{chr(10).join(items)}
  </div>
  <div class="song-grid-wrap" id="song-grid" hidden>
    <table class="song-grid">
      <thead><tr><th class="g-corner">Song</th>{col_head}</tr></thead>
      <tbody>
{chr(10).join("        " + r for r in rows)}
      </tbody>
    </table>
  </div>'''
    return page_shell(
        title="Songs — The Hannan Tapes",
        description=f"Every song across the Hannan live archive — {len(songs)} songs cross-referenced against every show and performance.",
        url="https://renedebos.com/songs/", eyebrow="The Hannan Tapes",
        heading="Songs", tagline="Every song, and every time it was played",
        nav=site_nav("Songs"), main=main,
        # Shared player engine (song-boot.js), unconditional on every song page
        # since Stage 3a-foundation -- see SONG_BOOT_SCRIPTS' own comment.
        # songs.js still loads: it owns the list/grid sort/filter/search
        # controls AND the lazy occurrence-row insertion, and calls into
        # song-boot.js's window.SONG_BOOT.mountRows() (falling back to the
        # legacy initCustomPlayers() if song-boot.js never mounted) each time
        # a <details> opens for the first time.
        extra_scripts=('\n<script src="/assets/track-select.js"></script>'
                       f'{SONG_BOOT_SCRIPT}'
                       '\n<script src="/assets/songs.js"></script>'
                       + (VARIANT_UI_SCRIPT if has_variant() else "")),
        pre_scripts=SONG_ENGINE_FLAG,
        playback_ready="deferred")

def build_song_page(s):
    plural = "s" if s["plays"] != 1 else ""
    arts = ", ".join(artist_name(a) for a in s["artists"])
    parts = ['\n  <p class="song-back"><a href="/songs/">&larr; All songs</a></p>']
    if len(s["variants"]) > 1:
        alt = ", ".join(esc(v) for v in s["variants"] if v != s["canonical"])
        if alt:
            parts.append(f'''
  <section class="about"><p class="song-variants">Also listed as: {alt}</p></section>''')
    occs = "\n".join(_song_occ_html(o, s["canonical"]) for o in s["occ"])
    any_loud = any(o.get("loud") for o in s["occ"])
    zip_html = song_zip_button_html(s)
    parts.append(f'''
  <section id="tracks">
    <div class="tracks-head">
      <div class="group-label-bare">Played {s['plays']} time{plural} &middot; {esc(arts)}</div>
      <div class="tracks-actions">
        <button type="button" class="select-all" data-target=".song-occs">Select all</button>
        {zip_html}
      </div>
    </div>
    <p class="track-hint">Every performance streams in full. &ldquo;Open on show page&rdquo; jumps to the song within its full set.</p>{variant_toggle(any_loud)}
    <div class="song-occs">
{occs}
    </div>
  </section>''')
    return page_shell(
        title=f"{s['canonical']} — The Hannan Tapes",
        description=f"{s['canonical']} — {s['plays']} live performance{plural} by {arts} in the Hannan archive.",
        url=f"https://renedebos.com/songs/{s['slug']}/", eyebrow="The Hannan Tapes &middot; Song",
        heading=esc(s["canonical"]), tagline=f"Played {s['plays']} time{plural} across the archive",
        nav=site_nav("Songs"), main="".join(parts), extra_head=song_jsonld(s),
        # Every occurrence row is server-rendered here (unlike /songs/'s lazy
        # per-<details> insertion), so song-boot.js mounts the whole page's
        # queue synchronously at parse time, same shape as a show page.
        extra_scripts=(f'\n<script src="/assets/track-select.js"></script>{SONG_BOOT_SCRIPT}'
                       + (VARIANT_UI_SCRIPT if any_loud else "")),
        pre_scripts=SONG_ENGINE_FLAG,
        playback_ready="deferred")

def build_404():
    main = '''
  <section class="about">
    <h2>Page not found</h2>
    <p>This page doesn&rsquo;t exist &mdash; it may have moved, or a song may have been renamed or merged into another. A few good places to pick back up:</p>
    <ul class="notfound-links">
      <li><a href="/">Browse all shows</a></li>
      <li><a href="/songs/">Every song, cross-referenced</a></li>
      <li><a href="/search/">Search the archive</a></li>
    </ul>
  </section>'''
    return page_shell(
        title="Page not found — The Hannan Tapes",
        description="That page couldn't be found in the Hannan live recordings archive.",
        url="https://renedebos.com/404", eyebrow="The Hannan Tapes",
        heading="404", tagline="Page not found",
        nav=site_nav(), main=main)


__all__ = ['CONTROLLER_ENGINE_SLUGS', 'SONG_BOOT_SCRIPT', 'SONG_ENGINE_FLAG', 'build_404', 'build_archive_data', 'build_contact', 'build_history', 'build_home', 'build_manual', 'build_player', 'build_playlist', 'build_process', 'build_search', 'build_show', 'build_song_page', 'build_songs_index', 'build_updates']
