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

RING_ICON_SVG = ('<svg width="24" height="24" viewBox="0 0 24 24" fill="none">'
                  '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.2"/>'
                  '<circle cx="12" cy="12" r="6" stroke="currentColor" stroke-width="1.2"/>'
                  '<circle cx="12" cy="12" r="2" fill="currentColor"/></svg>')

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

def _home_show_card(show, featured=False):
    n = len(show["tracks"])
    tags = ('<span class="tag featured">Featured</span>' if featured else "") + \
           f'<span class="tag">{esc(SOURCE_LABEL.get(show["source"], show["source"]))}</span>'
    added = show.get("added")
    added_html = f'\n      <div class="added">ADDED {esc(added)}</div>' if added else ""
    venue = show["venue"] or show["venue_short"] or ""
    return f'''    <a class="card" href="{show_url(show)}">
      <div class="card-top">
        <span class="ring-icon">{RING_ICON_SVG}</span>
        <span class="count">{n} TRACK{"S" if n != 1 else ""}</span>
      </div>
      <h3>{esc(artist_name(show["artist"]))} &mdash; {esc(show["venue_short"] or "Unknown venue")}</h3>
      <div class="venue">{esc(venue)} &middot; {esc(date_with_subtitle(show))}</div>{added_html}
      <div class="tags">{tags}</div>
      <div class="stream">Stream &middot; {esc(track_total(show["tracks"]))}</div>
    </a>'''

RANDOM_TAPE_SCRIPT = '''
<script>
(function () {
  var btn = document.getElementById('randomTape');
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    fetch('/assets/tracks.json').then(function (r) { return r.json(); }).then(function (rows) {
      if (!rows.length) { location.href = '/archive/'; return; }
      location.href = rows[Math.floor(Math.random() * rows.length)].url;
    }).catch(function () { location.href = '/archive/'; });
  });
})();
</script>'''

def build_home():
    """The homepage is a standalone document (like /manual/) rather than
    page_shell + site.css — a deliberately different "tape deck" look the
    rest of the site doesn't share, per the 2026-07-10 redesign."""
    tracked = [s for s in M["shows"] if s.get("tracks")]
    n_tracks = sum(len(s["tracks"]) for s in tracked)
    featured_slug = M["featured"][0] if M.get("featured") else None
    featured = next((s for s in tracked if s["slug"] == featured_slug), None)
    rest = sorted((s for s in tracked if s["slug"] != featured_slug),
                  key=added_sort_key, reverse=True)
    grid_shows = ([featured] if featured else []) + rest[:6 - (1 if featured else 0)]
    cards = "\n".join(_home_show_card(s, featured=(s is featured)) for s in grid_shows)

    notes = [a for a in M["artists"] if a.get("note")]
    artist_links = (f'\n    <div class="artist-links">{" &middot; ".join(a["note"] for a in notes)}</div>'
                     if notes else "")

    return HOME_SHELL.format(
        nav_links="\n    ".join(f'<a href="{href}">{label}</a>'
                                 for label, href in SITE_PAGES[1:]),
        n_shows=len(tracked),
        n_tracks=n_tracks,
        cards=cards,
        why_card=_home_info_card("why.html", "Read the full story"),
        what_card=_home_info_card("about.html", "Read more"),
        artist_links=artist_links,
        random_tape_script=RANDOM_TAPE_SCRIPT,
        jsonld=home_jsonld(),
    )

HOME_SHELL = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Hannan Tapes</title>
<meta name="description" content="Live recordings archive — Jerry Hannan, Sean Hannan, and Mad Hannans performing at clubs in Marin and the Bay Area in the late 1990s and early 2000s.">
<link rel="canonical" href="https://renedebos.com">
<meta name="theme-color" content="#17150f">
<meta property="og:title" content="The Hannan Tapes">
<meta property="og:description" content="Live recordings archive — Jerry Hannan, Sean Hannan, and Mad Hannans.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://renedebos.com">
<meta property="og:image" content="https://renedebos.com/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#9834;</text></svg>">
<link rel="alternate" type="application/rss+xml" title="The Hannan Tapes &mdash; Updates" href="https://renedebos.com/feed.xml">
<link rel="stylesheet" href="/assets/home-fonts.css">
<link rel="stylesheet" href="/assets/home.css">{jsonld}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="wrap">

  <header>
    <a class="mark" href="/" aria-label="The Hannan Tapes &mdash; home">&#9834;</a>
    <nav>
    {nav_links}
    </nav>
  </header>

  <main id="main">
  <section class="hero">
    <div class="eyebrow">Live &middot; DAT-sourced &middot; 1998&ndash;2003</div>
    <h1>The <em>Hannan</em> Tapes</h1>
    <p class="lede">Live recordings of Jerry Hannan, Sean Hannan, and the Mad Hannans, taped from the audience and soundboard at clubs across Marin and the Bay Area. Digitized, cataloged, and streamable &mdash; hiss and all.</p>
    <div class="actions">
      <a class="btn btn-primary" href="/archive/" id="randomTape">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2" stroke="currentColor" stroke-width="1.3"/></svg>
        Play a random tape
      </a>
      <a class="btn btn-secondary" href="/playlist/">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h9M2 8h9M2 12h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13 9v5M13 14l-1.7-1.4M13 14l1.7-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Build a playlist
      </a>
    </div>
  </section>

  <div class="grid-head">
    <h2>Recently Added</h2>
    <span>{n_shows} SHOWS &middot; {n_tracks} TRACKS</span>
  </div>

  <div class="grid">
{cards}
  </div>

  <div class="all-shows"><a href="/archive/">Browse all shows &rarr;</a></div>

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
</body>
</html>
'''

def build_archive():
    # Absorbs the old /shows/ page (2026-07-08): the four view combinations
    # (artist/date × all/split-only) are prerendered and toggled client-side —
    # same pattern the by-artist/by-date switch always used, so section counts
    # stay honest and no artist header lingers over a filtered-empty list.
    n_split = sum(1 for s in M["shows"] if s.get("tracks"))
    toggle = f'''
  <div class="archive-controls">
    <div class="view-toggle" role="group" aria-label="Sort shows">
      <button type="button" class="seg active" data-view="artist">By artist</button>
      <button type="button" class="seg" data-view="date">By date</button>
    </div>
    <div class="view-toggle" role="group" aria-label="Filter shows">
      <button type="button" class="seg" data-split="1" aria-pressed="false">&#9834; Split shows only ({n_split})</button>
    </div>
  </div>'''
    views = f'''
  <div class="archive-view" data-view="artist" data-split="all">{artist_sections(only_tracks=False)}
  </div>
  <div class="archive-view" data-view="date" data-split="all" hidden>{date_sorted_list()}
  </div>
  <div class="archive-view" data-view="artist" data-split="split" hidden>{artist_sections(only_tracks=True)}
  </div>
  <div class="archive-view" data-view="date" data-split="split" hidden>{date_sorted_list(only_tracks=True)}
  </div>'''
    script = '''
<script>
(function () {
  var VIEW_KEY = 'archiveView', SPLIT_KEY = 'archiveSplit';
  var view = 'artist', split = 'all';
  var segs = document.querySelectorAll('.view-toggle .seg[data-view]');
  var splitBtn = document.querySelector('.view-toggle .seg[data-split]');
  var views = document.querySelectorAll('.archive-view');
  function apply() {
    segs.forEach(function (s) { s.classList.toggle('active', s.dataset.view === view); });
    splitBtn.classList.toggle('active', split === 'split');
    splitBtn.setAttribute('aria-pressed', split === 'split' ? 'true' : 'false');
    views.forEach(function (x) { x.hidden = !(x.dataset.view === view && x.dataset.split === split); });
  }
  segs.forEach(function (s) {
    s.addEventListener('click', function () {
      view = s.dataset.view;
      apply();
      try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
    });
  });
  splitBtn.addEventListener('click', function () {
    split = split === 'split' ? 'all' : 'split';
    apply();
    try { localStorage.setItem(SPLIT_KEY, split); } catch (e) {}
  });
  try {
    if (localStorage.getItem(VIEW_KEY) === 'date') view = 'date';
    if (localStorage.getItem(SPLIT_KEY) === 'split') split = 'split';
  } catch (e) {}
  apply();
})();
</script>'''
    return page_shell(
        title="Archive — The Hannan Tapes",
        description="Every Jerry Hannan, Sean Hannan, and Mad Hannans recording in the archive, by artist or by date.",
        url="https://renedebos.com/archive/",
        eyebrow="The Hannan Tapes",
        heading="Archive",
        tagline="Every show &middot; by artist or by date &middot; filter to split shows",
        nav=site_nav("Archive"),
        main=toggle + views,
        extra_scripts=script,
    )

def build_search():
    return page_shell(
        title="Search — The Hannan Tapes",
        description="Search the Hannan Tapes archive by song, artist, venue, date, or source.",
        url="https://renedebos.com/search/",
        eyebrow="The Hannan Tapes",
        heading="Search",
        tagline="Find a song, show, venue, or date",
        nav=site_nav("Search"),
        main='''
  <section class="search">
    <input id="q" class="search-input" type="search" autocomplete="off" autofocus
           placeholder="Search songs, shows, venues, dates, covers…">
    <div id="filters" class="search-filters"></div>
    <p id="status" class="search-status">Loading…</p>
    <div id="results" class="search-results"></div>
  </section>''',
        extra_scripts='\n<script src="/assets/search.js"></script>',
    )

def build_playlist():
    return page_shell(
        title="Playlist — The Hannan Tapes",
        description="Build a custom playlist from the Hannan archive — filter by artist, venue, mood, and source, then hit play.",
        url="https://renedebos.com/playlist/",
        eyebrow="The Hannan Tapes",
        heading="Playlist",
        tagline="Roll your own set list from the archive",
        nav=site_nav("Playlist"),
        main='''
  <section class="playlist">
    <div class="pl-panel">
      <div id="pl-filters" class="pl-filter-groups"></div>
    </div>
    <div class="pl-panel pl-panel-build">
      <div id="pl-length" class="pl-filter-groups"></div>
      <p id="pl-status" class="search-status">Loading the track catalog…</p>
      <p class="pl-actions"><button id="pl-generate" class="pl-generate" type="button" disabled>Generate playlist</button>
      <button id="pl-share" class="pl-generate pl-share" type="button" hidden>Copy share link</button></p>
    </div>
    <div id="pl-now" class="pl-now" hidden></div>
    <div id="pl-queue" class="pl-queue"></div>
  </section>''',
        extra_scripts='\n<script src="/assets/playlist.js"></script>',
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

def build_process():
    return page_shell(
        title="The Process — The Hannan Tapes",
        description="How a 25-year-old DAT tape becomes a track-listed show page — the archive's full audio pipeline, step by step.",
        url="https://renedebos.com/process/",
        eyebrow="The Hannan Tapes",
        heading="The Process",
        tagline="From DAT tape to show page, step by step",
        nav=site_nav(),
        main=content("process.html"),
    )

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

    if show.get("tracks"):
        has_flac = any(t.get("flac") for t in show["tracks"])
        rows = []
        for t in show["tracks"]:
            # Version the stream URL with the track's MD5 (when known) so the edge
            # caches hard yet a re-normalized upload goes live instantly.
            ver = (proc_tracks.get(str(t["num"]), {}).get("md5") or "")[:12] or None
            stream = stream_url(t["file"], ver)
            sizes = []
            if t.get("flac_size_mb"):
                sizes.append(f'FLAC {t["flac_size_mb"]} MB')
            if t.get("size_mb"):
                sizes.append(f'MP3 {t["size_mb"]} MB')
            # A track may override the show artist (e.g. a guest singer).
            track_artist = t.get("artist") or artist["name"]
            info_rows = [
                ["Artist", track_artist],
                ["Song", t["title"]],
                ["Venue", show["venue"] or "—"],
                ["Date", show["date"] or "Unknown date"],
                ["Format", "FLAC + MP3" if t.get("flac") else "MP3"],
                ["Size", " · ".join(sizes) or "—"],
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
            # Password-protected lossless FLAC download when a FLAC exists;
            # otherwise the track is stream-only.
            dl_btns = []
            if t.get("flac"):
                flac_title = "Download FLAC (password protected)" + (f" · {t['flac_size_mb']} MB" if t.get("flac_size_mb") else "")
                dl_btns.append(dl_button(t["flac"], title=flac_title))
            if has_waves:
                # waveform replaces the progress bar; the download (if any) keeps the
                # .ws-dl wrapper so the mobile grouping styles apply (matches the lab page).
                dl = ('\n        <div class="ws-dl">' +
                      "".join("\n          " + b for b in dl_btns) +
                      "\n        </div>") if dl_btns else ""
                rows.append(f'''      <div class="track-row ws-track" id="track-{t["num"]}" data-trackid="{t["num"]}" data-src="{esc(stream)}">
        <button class="play-btn" aria-label="Play">{PLAY_SVG}</button>
        <span class="track-num">{t["num"]:02d}</span>
        {title_html}
        <div class="ws-wave"></div>
        <span class="time-label current" data-duration="{esc(t["duration"])}">{esc(t["duration"])}</span>{dl}
      </div>''')
            else:
                dl = "".join("\n        " + b for b in dl_btns)
                rows.append(f'''      <div class="track-row custom-player" id="track-{t["num"]}" data-src="{esc(stream)}">
        <button class="play-btn" aria-label="Play">{PLAY_SVG}</button>
        <span class="track-num">{t["num"]:02d}</span>
        {title_html}
        <span class="time-label current" data-duration="{esc(t["duration"])}">{esc(t["duration"])}</span>{dl}
        <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
      </div>''')
        hint = ("Every song streams in full &middot; lossless FLAC downloads are password protected"
                if has_flac else "Every song streams in full")
        parts.append(f'''
  <section id="tracks">
    <div class="group-label-bare">Tracks &middot; {len(show["tracks"])} songs &middot; {track_total(show["tracks"])}</div>
    <p class="track-hint">{hint}</p>
    <div class="track-list" data-autoplay-next>
{chr(10).join(rows)}
    </div>
  </section>''')

    # Technical-data table for shows that have been through the audio_processing
    # workflow (renders all tracks; loudness columns filled where measured).
    if proc:
        parts.append(tech_data_section(show, proc))

    cards = []
    for r in canon:
        title = r["label"] or "Complete show"
        meta = [("Source", r["source"]), ("Format", r["format"]), ("Size", r["size"])]
        cards.append(recording_card(title, meta, r["source"], r["file"], r.get("stream")))
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
            cards.append(recording_card(r["alt_label"], meta, r["source"], r["file"], r.get("stream")))
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

    extra_scripts = ""
    if has_waves:
        # Emit the peaks to a served, cacheable path (data/ is .assetsignore'd) and
        # point wavesurfer.js at it, rather than inlining ~58 KB into every page.
        write(f"assets/peaks/{show['slug']}.json", open(peaks_path).read())
        extra_scripts = (f'\n<script>window.WS_PEAKS_URL = "/assets/peaks/{show["slug"]}.json";</script>\n'
                         f'<script type="module" src="/assets/wavesurfer.js"></script>')

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
    )

WAVESURFER_LAB_SLUG = "sean-19-broadway-unknown"

def build_wavesurfer_lab():
    """Standalone prototype page rendering one show's tracks with wavesurfer.js
    waveforms (drawn from pre-computed peaks). Non-destructive: not in nav, the
    real show page is untouched."""
    show = next(s for s in M["shows"] if s["slug"] == WAVESURFER_LAB_SLUG)
    artist = next(a for a in M["artists"] if a["id"] == show["artist"])
    peaks_json = open(os.path.join(ROOT, "data", "peaks", f"{WAVESURFER_LAB_SLUG}.json")).read()

    rows = []
    for t in show["tracks"]:
        stream = stream_url(t["file"])
        track_artist = t.get("artist") or artist["name"]
        info = esc(json.dumps([
            ["Artist", track_artist],
            ["Song", t["title"]],
            ["Venue", show["venue"] or "—"],
            ["Date", show["date"] or "Unknown date"],
        ], ensure_ascii=False))
        dl_btns = []
        if t.get("flac"):
            flac_title = "Download FLAC (password protected)" + (f" · {t['flac_size_mb']} MB" if t.get("flac_size_mb") else "")
            dl_btns.append(dl_button(t["flac"], title=flac_title))
        dl_inner = "".join("\n          " + b for b in dl_btns)
        dl = f'\n        <div class="ws-dl">{dl_inner}\n        </div>' if dl_btns else ""
        rows.append(f'''      <div class="ws-row" id="track-{t["num"]}" data-trackid="{t["num"]}" data-src="{esc(stream)}">
        <button class="play-btn" aria-label="Play">{PLAY_SVG}</button>
        <span class="track-num">{t["num"]:02d}</span>
        <span class="track-title" data-info="{info}">{esc(t["title"])}</span>
        <div class="ws-wave"></div>
        <span class="time-label current" data-duration="{esc(t["duration"])}">{esc(t["duration"])}</span>{dl}
      </div>''')

    main = f'''
  <section class="about">
    <h2>wavesurfer.js prototype</h2>
    <p>Experimental waveform player for the track rows. Compare it with the current player on the <a href="{show_url(show)}">live show page</a>. Each waveform is drawn instantly from pre-computed peaks; the audio itself only streams once you press play.</p>
  </section>
  <section>
    <div class="ws-list" data-autoplay-next>
{chr(10).join(rows)}
    </div>
  </section>'''

    extra = (f'\n<script>window.WS_PEAKS = {peaks_json};</script>\n'
             f'<script type="module" src="/assets/wavesurfer.js"></script>')

    return page_shell(
        title="Waveform prototype — The Hannan Tapes",
        description="Experimental wavesurfer.js waveform player prototype.",
        url="https://renedebos.com/lab/wavesurfer/",
        eyebrow="Lab &middot; Prototype",
        heading="Waveform <em>prototype</em>",
        tagline=esc(show_title(show)),
        nav=site_nav(),
        main=main,
        extra_scripts=extra,
    )

def build_songs_index():
    songs, cols = collect_songs()
    n_other = len(M["shows"]) - len(cols)
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
        occs = "\n".join(_song_occ_html(o) for o in s["occ"])
        items.append(f'''    <details class="song-item" data-artists="{' '.join(s['artists'])}" data-plays="{s['plays']}" data-title="{esc(song_norm(s['canonical']))}">
      <summary>
        <span class="song-plays">{s['plays']}&times;</span>
        <a class="song-name" href="/songs/{s['slug']}/">{esc(s['canonical'])}</a>
        <span class="song-chips">{chips}</span>
      </summary>
      <div class="song-occs">
{occs}
      </div>
    </details>''')

    col_head = "".join(
        f'<th class="artist-{c["artist"]}" data-artist="{c["artist"]}"><span class="g-venue">{esc(c.get("venue_short") or c.get("venue") or "—")}</span>'
        f'<span class="g-date">{esc((c.get("date") or "??")[:10])}</span></th>' for c in cols)
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
    <p class="about-note">The {n_other} other shows in the archive aren&rsquo;t split into individual songs yet, so they don&rsquo;t appear here.</p>
  </section>
  <div class="songs-controls">
    <input type="search" id="song-search" class="song-search" placeholder="Search songs&hellip;" autocomplete="off" aria-label="Search songs">
    <div class="seg" data-role="view"><button data-view="list" class="active">List</button><button data-view="grid">Grid</button></div>
    <div class="seg" data-role="sort"><button data-sort="plays" class="active">Most&nbsp;played</button><button data-sort="az">A&ndash;Z</button></div>
    <div class="seg" data-role="artist"><button data-artist="all" class="active">All</button><button data-artist="jerry">Jerry</button><button data-artist="mad">Mad</button><button data-artist="sean">Sean</button></div>
  </div>
  <div class="song-legend" aria-hidden="true">{legend}</div>
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
        extra_scripts='\n<script src="/assets/songs.js"></script>')

def build_song_page(s):
    plural = "s" if s["plays"] != 1 else ""
    arts = ", ".join(artist_name(a) for a in s["artists"])
    parts = ['\n  <p class="song-back"><a href="/songs/">&larr; All songs</a></p>']
    if len(s["variants"]) > 1:
        alt = ", ".join(esc(v) for v in s["variants"] if v != s["canonical"])
        if alt:
            parts.append(f'''
  <section class="about"><p class="song-variants">Also listed as: {alt}</p></section>''')
    occs = "\n".join(_song_occ_html(o) for o in s["occ"])
    parts.append(f'''
  <section id="tracks">
    <div class="group-label-bare">Played {s['plays']} time{plural} &middot; {esc(arts)}</div>
    <p class="track-hint">Every performance streams in full. &ldquo;Open on show page&rdquo; jumps to the song within its full set.</p>
    <div class="song-occs">
{occs}
    </div>
  </section>''')
    return page_shell(
        title=f"{s['canonical']} — The Hannan Tapes",
        description=f"{s['canonical']} — {s['plays']} live performance{plural} by {arts} in the Hannan archive.",
        url=f"https://renedebos.com/songs/{s['slug']}/", eyebrow="The Hannan Tapes &middot; Song",
        heading=esc(s["canonical"]), tagline=f"Played {s['plays']} time{plural} across the archive",
        nav=site_nav("Songs"), main="".join(parts), extra_head=song_jsonld(s))

def build_404():
    main = '''
  <section class="about">
    <h2>Page not found</h2>
    <p>This page doesn&rsquo;t exist &mdash; it may have moved, or a song may have been renamed or merged into another. A few good places to pick back up:</p>
    <ul class="notfound-links">
      <li><a href="/archive/">Browse all shows</a></li>
      <li><a href="/songs/">Every song, cross-referenced</a></li>
      <li><a href="/search/">Search the archive</a></li>
      <li><a href="/">Back to the home page</a></li>
    </ul>
  </section>'''
    return page_shell(
        title="Page not found — The Hannan Tapes",
        description="That page couldn't be found in the Hannan live recordings archive.",
        url="https://renedebos.com/404", eyebrow="The Hannan Tapes",
        heading="404", tagline="Page not found",
        nav=site_nav(), main=main)


__all__ = ['WAVESURFER_LAB_SLUG', 'build_404', 'build_archive', 'build_contact', 'build_history', 'build_home', 'build_manual', 'build_playlist', 'build_process', 'build_search', 'build_show', 'build_song_page', 'build_songs_index', 'build_updates', 'build_wavesurfer_lab']
