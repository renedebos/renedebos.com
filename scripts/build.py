#!/usr/bin/env python3
"""Static site generator for renedebos.com.

Reads data/recordings.json and writes:
  index.html                          homepage (about, featured, show index, contact)
  shows/<slug>/index.html             one page per show
  jerry-hannan-19-broadway-2001/...   curated show keeps its original URL
  assets/site.css, assets/player.js   shared styles and player logic

Usage: python3 scripts/build.py
"""
import datetime
import html
import json
import os
import re
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
WORKER = M["worker"]

SOURCE_LABEL = {"SBD": "Soundboard", "AUD": "Audience recording"}


def esc(s):
    return html.escape(str(s), quote=True)


def stream_url(file, version=None):
    u = f"{WORKER}/stream?file={urllib.parse.quote(file)}"
    if version:
        u += f"&v={version}"
    return u


def show_url(show):
    return f"/{show['page']}/" if show.get("page") else f"/shows/{show['slug']}/"


def show_title(show):
    artist = next(a for a in M["artists"] if a["id"] == show["artist"])
    return f"{artist['name']} Live at {show['venue_short']}"


def date_with_subtitle(show):
    d = show["date"] or "Unknown date"
    return f"{d} · {show['subtitle']}" if show.get("subtitle") else d


def sort_key(show):
    return (show["date"] is None, show["date"] or "9999", show["slug"])


def track_total(tracks):
    secs = sum(int(t["duration"].split(":")[0]) * 60 + int(t["duration"].split(":")[1])
               for t in tracks)
    return f"{secs // 3600}h {secs % 3600 // 60}m" if secs >= 3600 else f"{secs // 60}m"


def singles_for_show(show):
    return [s for s in M["singles"]
            if s["artist"] == show["artist"] and s["venue"] == show["venue"]
            and s["date"] and s["date"] == show["date"]]


# ── shared fragments ──────────────────────────────────────────────────────────

DL_SVG = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" '
          'stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/>'
          '<path d="M7 10l5 5 5-5"/><path d="M3 18h18"/></svg>')
PLAY_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>'


def dl_button(file, *, free, label=None, title="Download"):
    url = stream_url(file)
    name = file.split("/")[-1]
    free_attr = ' data-free="true"' if free else ""
    label_html = f'<span class="dl-label">{esc(label)}</span>' if label else ""
    return (f'<a class="download-btn"{free_attr} href="{esc(url)}" '
            f'download="{esc(name)}" title="{esc(title)}">{DL_SVG}{label_html}</a>')


def player(file, free=False, duration=None, download_file=None):
    """A custom-player row: play button, progress bar, download button(s).

    Streams `file`. When `download_file` differs (e.g. stream a lossy 320 kbps
    MP3 proxy but keep the lossless original available), the row offers two
    downloads: the free MP3 and the lossless original. Otherwise a single
    download button for the streamed file.
    """
    stream = stream_url(file)
    end_label = f'<span class="time-label">{esc(duration)}</span>' if duration else ""
    if download_file and download_file != file:
        mp3_fmt = file.rsplit(".", 1)[-1].upper()
        loss_fmt = download_file.rsplit(".", 1)[-1].upper()
        downloads = (
            dl_button(file, free=True, label=mp3_fmt, title="Download 320 kbps MP3")
            + "\n          "
            + dl_button(download_file, free=free, label=loss_fmt,
                        title=f"Download lossless {loss_fmt}"))
    else:
        downloads = dl_button(download_file or file, free=free)
    return f'''<div class="custom-player" data-src="{esc(stream)}">
          <button class="play-btn" aria-label="Play">{PLAY_SVG}</button>
          <div class="progress-wrap">
            <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
            <div class="time-row"><span class="time-label current">0:00</span>{end_label}</div>
          </div>
          {downloads}
        </div>'''


def recording_card(title, meta_pairs, badge, file, free, stream_file=None):
    # If a lossy stream proxy exists (stream_file), play it for free and gate the
    # lossless `file` behind the download/password flow; otherwise stream `file`.
    grid = "".join(f'<span class="meta-label">{esc(k)}</span><span class="meta-value">{esc(v)}</span>'
                   for k, v in meta_pairs if v)
    play = player(stream_file or file, free,
                  download_file=file if stream_file else None)
    return f'''      <div class="recording-item">
        <div class="recording-meta">
          <div>
            <div class="recording-title">{esc(title)}</div>
            <div class="recording-meta-grid">{grid}</div>
          </div>
          <span class="recording-badge">{esc(badge)}</span>
        </div>
        {play}
      </div>'''


def page_shell(*, title, description, url, eyebrow, heading, tagline, nav, main, extra_scripts=""):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{esc(url)}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="{esc(url)}">
<meta property="og:image" content="https://renedebos.com/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(description)}">
<meta name="twitter:image" content="https://renedebos.com/assets/og.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♪</text></svg>">
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

<header>
  <p class="site-eyebrow">{eyebrow}</p>
  <h1>{heading}</h1>
  <p class="site-tagline">{tagline}</p>
</header>

<nav>
{nav}
</nav>

<main>
{main}
</main>

<footer>
  Part of <a href="/">The Hannan Recordings</a> archive
</footer>

<script src="/assets/player.js"></script>{extra_scripts}
</body>
</html>
'''


# ── site navigation ─────────────────────────────────────────────────────────

SITE_PAGES = [
    ("Home", "/"),
    ("Archive", "/archive/"),
    ("Shows", "/shows/"),
    ("Search", "/search/"),
    ("Updates", "/updates/"),
    ("History", "/history/"),
    ("Contact", "/contact/"),
]


def site_nav(active=None):
    links = []
    for label, href in SITE_PAGES:
        cls = ' class="active"' if label == active else ""
        links.append(f'  <a href="{href}"{cls}>{label}</a>')
    return "\n".join(links)


# ── reusable content fragments ──────────────────────────────────────────────

def about_block():
    return '''
  <section class="about">
    <h2>About This Archive</h2>
    <p>
      These recordings were captured on a Sony portable DAT recorder at clubs in Marin and the Bay Area in the late 1990s and early 2000s. Audio quality varies &mdash; the tapes have aged, the microphone was small, and some shows had significant background noise.
    </p>
    <p>
      This is very much a work in progress. I&rsquo;m steadily working through the show tapes &mdash; splitting them into individual songs and, where it helps the listening experience, cleaning up the MP3 versions: normalizing the volume, adding gentle fades, and removing clicks where possible.
    </p>
    <p>
      Most of these tracks have <em>not</em> been processed to bring them up to the loudness you&rsquo;d expect from a normal streaming service, so when you play a song or a show you may need to turn the volume on your device up &mdash; or down &mdash; to taste. The main goal of this site is simply to give these tapes a home. As time allows, the recordings may get a proper cleanup down the road.
    </p>
    <p>
      The lossless files are kept close to the original transfer: the full-show WAV downloads and the individual-song FLAC downloads are only minimally processed, for anyone who wants the rawest version. All lossless downloads are password protected.
    </p>
    <p class="about-note">
      Most full-show recordings are large lossless WAV files (1&ndash;3 GB) and may take a moment to begin playing.
    </p>
  </section>'''


def why_block():
    return '''
  <section class="about">
    <h2>Why I&rsquo;m Doing This</h2>
    <p>
      The real catalyst was wanting to hand these recordings over to Jerry and Sean. Passing on the DAT tapes meant more than copying a few files &mdash; the tapes had to be digitized to disc and kept in a form that could actually be handed on. It quickly became clear that dropping everything onto a memory stick wouldn&rsquo;t do anyone any favors, so I set out to identify the songs, catalog them, and make the whole thing easier to take in.
    </p>
    <p>
      A website was always in the back of my mind, but never something I had the time or bandwidth for &mdash; until AI tools like Claude made it surprisingly easy. Once I started building, it became clear I could use the whole project as an excuse to learn: how to work with AI, how to grow a site like this, and how to lean on Audacity to clean up the old recordings. That&rsquo;s really where the three reasons below come from.
    </p>
    <p>There are three reasons I keep working on this archive:</p>
    <ol class="reasons">
      <li>
        <strong>To give these tapes a home.</strong> I want these old recordings to have a place where the people who were around in those days can stream them, enjoy them again, and relive those moments &mdash; back when Jerry and Sean were playing the local bars and venues.
      </li>
      <li>
        <strong>To learn audio restoration.</strong> Working through these shows is teaching me how to improve recordings in Audacity &mdash; experimenting with normalization, limiters, filters, and the other tools it provides to get the best possible sound from aging tape.
      </li>
      <li>
        <strong>To learn to work with AI.</strong> Building and maintaining this site is also how I&rsquo;m getting familiar with AI &mdash; learning to use a tool like Claude and figuring out how to make the most of it.
      </li>
    </ol>
  </section>'''


def featured_card():
    featured = next(s for s in M["shows"] if s["slug"] in M["featured"])
    tracks = featured["tracks"]
    return f'''
  <a class="featured-card" href="{show_url(featured)}">
    <div>
      <p class="featured-eyebrow">Featured &middot; Curated Show</p>
      <p class="featured-title">{esc(show_title(featured))}</p>
      <p class="featured-sub">{esc(date_with_subtitle(featured))} &middot; {SOURCE_LABEL.get(featured["source"], featured["source"])} &middot; {len(tracks)} tracks &middot; {track_total(tracks)}</p>
      <p class="featured-note">Every song split out and streamable.</p>
    </div>
    <span class="featured-cta">Listen &rarr;</span>
  </a>'''


def show_row(show, with_artist=False):
    artist = next(a for a in M["artists"] if a["id"] == show["artist"])
    n_alt = sum(1 for r in show["recordings"] if r["alternate"])
    n_can = len(show["recordings"]) - n_alt
    extra = []
    if n_can > 1:
        extra.append(f"{n_can} parts")
    if n_alt:
        extra.append(f"{n_alt} alt transfer{'s' if n_alt > 1 else ''}")
    extra_html = f' <span class="show-extra">&middot; {" &middot; ".join(extra)}</span>' if extra else ""
    if show.get("tracks"):
        n = len(show["tracks"])
        marker = f'<span class="show-tracks" title="{n} songs available">&#9834; {n}</span>'
    else:
        marker = '<span class="show-tracks"></span>'
    subtitle = f' &middot; <em>{esc(show["subtitle"])}</em>' if show.get("subtitle") else ""
    primary_size = next((r["size"] for r in show["recordings"] if not r["alternate"]), "—")
    info = esc(json.dumps([
        ["Artist", artist["name"]],
        ["Venue", show["venue"] or "—"],
        ["Date", show["date"] or "Unknown date"],
        ["Source", SOURCE_LABEL.get(show["source"], show["source"])],
        ["Tracks", str(len(show["tracks"])) if show.get("tracks") else "—"],
        ["Size", primary_size],
    ], ensure_ascii=False))
    # In the cross-artist date view each row carries the artist, since the
    # grouping header that would otherwise name it is gone.
    artist_prefix = f'<span class="show-artist">{esc(artist["name"])}</span> &middot; ' if with_artist else ""
    return f'''      <a class="show-row" href="{show_url(show)}" data-info="{info}">
        <span class="show-date">{esc(show["date"] or "Unknown date")}</span>
        <span class="show-venue">{artist_prefix}{esc(show["venue"] or "")}{subtitle}{extra_html}</span>
        {marker}
        <span class="show-src src-{show["source"].lower()}">{esc(show["source"])}</span>
        <span class="show-arrow">&rarr;</span>
      </a>'''


def artist_sections(only_tracks=False):
    out = []
    for artist in M["artists"]:
        shows = sorted((s for s in M["shows"]
                        if s["artist"] == artist["id"] and (s.get("tracks") if only_tracks else True)),
                       key=sort_key)
        if not shows:
            continue
        rows = "\n".join(show_row(s) for s in shows)
        out.append(f'''
  <section class="artist-section" id="{artist["id"]}">
    <div class="artist-header">
      <h2 class="artist-name">{esc(artist["name"])}</h2>
      <span class="recording-count">{len(shows)} show{"s" if len(shows) != 1 else ""}</span>
    </div>
    <div class="artist-divider"></div>
    <div class="show-list">
{rows}
    </div>
  </section>''')
    return "".join(out)


def date_sorted_list():
    # One flat chronological list across all artists (oldest first; undated shows
    # sort last via sort_key). Used by the Archive's "By date" view.
    shows = sorted(M["shows"], key=sort_key)
    rows = "\n".join(show_row(s, with_artist=True) for s in shows)
    return f'''
  <section class="artist-section">
    <div class="show-list">
{rows}
    </div>
  </section>'''


def artist_notes_block():
    notes = [a for a in M["artists"] if a.get("note")]
    if not notes:
        return ""
    lines = "\n".join(
        f'    <p class="artist-note"><strong>{esc(a["name"])}</strong> &mdash; {a["note"]}</p>'
        for a in notes)
    return f'''
  <section class="home-notes">
{lines}
  </section>'''


def added_sort_key(s):
    # Order by full timestamp when available so same-day additions sort
    # most-recent-first; fall back to the date (treated as midnight).
    return (s.get("added_ts") or f'{s["added"]}T00:00:00', s["slug"])


def load_processing(slug):
    """Per-show audio-processing provenance written by the audio_processing
    workflow (data/processing/<slug>.json): target, tool, date, and per-track
    achieved loudness/true-peak/LRA. Returns the dict, or None if the show has
    never been run through the workflow. data/ is .assetsignore'd, so this is a
    build-time source only — its data is rendered into the show page HTML."""
    path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    return json.load(open(path)) if os.path.exists(path) else None


STATUS_BLURB = {
    "done": "All tracks loudness-normalized through the audio workflow.",
    "partial": "Some tracks loudness-normalized; the rest are pending.",
    "redo": "Previously normalized outside the current workflow — queued to be re-processed to standard.",
    "needs-processing": "Not yet loudness-normalized.",
}


def status_line(show):
    """A standalone audio-processing status badge shown on every show page,
    independent of the technical-data table (which only exists for processed
    shows). Reads `processing_status` written into recordings.json by
    `audio_process.py status --write`."""
    st = show.get("processing_status")
    if not st:
        return ""
    blurb = STATUS_BLURB.get(st, "")
    return (f'''
  <p class="proc-status-line">Audio processing'''
            f'<span class="proc-status status-{esc(st)}">{esc(st)}</span>'
            f'<span class="proc-status-blurb">{esc(blurb)}</span></p>''')


def tech_data_section(show, proc):
    """Render a collapsible "Technical data" table for a processed show: every
    track's duration + sizes (from recordings.json) merged with its input/achieved
    loudness, true peak, LRA, and gain applied (from the processing provenance,
    where measured). The per-track audio MD5 is carried in the sidecar for
    integrity/drift checks but is not displayed."""
    head_bits = [f'Loudness-normalized to {proc["target_lufs"]} LUFS / '
                 f'{proc["tp_ceiling"]} dBTP']
    if proc.get("source"):
        head_bits.append(f'Source: {esc(proc["source"])}')
    if proc.get("filters"):
        head_bits.append(f'Filters: {esc(proc["filters"])}')
    head_bits.append(esc(proc.get("tool", "ffmpeg loudnorm")))
    if proc.get("workflow_version") is not None:
        head_bits.append(f'workflow&nbsp;v{esc(proc["workflow_version"])}')
    if proc.get("date"):
        head_bits.append(esc(proc["date"]))
    head = " &middot; ".join(head_bits)
    # show-level status badge (from recordings.json, written by `status --write`)
    status = show.get("processing_status")
    badge = (f' <span class="proc-status status-{esc(status)}">{esc(status)}</span>'
             if status else "")
    pt = proc.get("tracks", {})
    rows = []
    for t in show["tracks"]:
        d = pt.get(str(t["num"]), {})
        inl = f'{d["in_lufs"]:.1f}' if "in_lufs" in d else "&mdash;"
        out = f'{d["lufs"]:.2f}' if "lufs" in d else "&mdash;"
        gain = f'{d["lufs"] - d["in_lufs"]:+.1f}' if ("lufs" in d and "in_lufs" in d) else "&mdash;"
        tp = f'{d["tp"]:.1f}' if "tp" in d else "&mdash;"
        lra = f'{d["lra"]:.1f}' if "lra" in d else "&mdash;"
        # per-track workflow version (with the exact process chain on hover);
        # blank for an untouched track in a partially-processed show.
        if "ver" in d:
            ver = (f'<span title="{esc(d["chain"])}">v{esc(d["ver"])}</span>'
                   if d.get("chain") else f'v{esc(d["ver"])}')
        else:
            ver = "&mdash;"
        mp3 = f'{t["size_mb"]} MB' if t.get("size_mb") else "&mdash;"
        flac = f'{t["flac_size_mb"]} MB' if t.get("flac_size_mb") else "&mdash;"
        rows.append(
            f'        <tr><td class="tnum">{t["num"]:02d}</td><td>{esc(t["title"])}</td>'
            f'<td class="tnum">{esc(t["duration"])}</td><td class="tnum">{mp3}</td>'
            f'<td class="tnum">{flac}</td><td class="tnum">{inl}</td>'
            f'<td class="tnum">{out}</td><td class="tnum">{gain}</td>'
            f'<td class="tnum">{tp}</td><td class="tnum">{lra}</td>'
            f'<td class="tver">{ver}</td></tr>')
    return f'''
  <section>
    <details class="tech-details" id="technical-data">
      <summary>Technical data &mdash; loudness, peaks &amp; sizes{badge}</summary>
      <p class="tech-head">{head}</p>
      <div class="tech-scroll">
      <table class="tech-table">
        <thead><tr><th>#</th><th>Song</th><th>Time</th><th>MP3</th><th>FLAC</th>
          <th>In&nbsp;LUFS</th><th>Out&nbsp;LUFS</th><th>Gain</th>
          <th>True&nbsp;Pk</th><th>LRA</th><th>Ver</th></tr></thead>
        <tbody>
{chr(10).join(rows)}
        </tbody>
      </table>
      </div>
    </details>
  </section>'''


def _show_label(show):
    artist = next(a for a in M["artists"] if a["id"] == show["artist"])
    return f'{esc(artist["name"])} &middot; {esc(show["venue_short"])} &middot; {esc(show["date"] or "")}'


def _src_tag(show):
    src = show["source"]
    return f'<span class="src-tag src-{src.lower()}">{esc(src)}</span>'


def updates_list():
    # Two kinds of events share the Updates feed, sorted most-recent-first by
    # timestamp: auto-stamped show additions and manual entries (e.g. a later
    # re-normalization pass) listed under the top-level "updates" key.
    by_slug = {s["slug"]: s for s in M["shows"]}
    events = []  # (sort_ts, slug, date, html)
    for show in M["shows"]:
        if show.get("added"):
            ts = show.get("added_ts") or f'{show["added"]}T00:00:00'
            n = len(show["tracks"]) if show.get("tracks") else 0
            link = f'<a href="{show_url(show)}">{_show_label(show)}</a>'
            html = f'Added {link} &mdash; {n} split tracks {_src_tag(show)}'
            events.append((ts, show["slug"], show["added"], html))
    for upd in M.get("updates", []):
        ts = upd.get("ts") or f'{upd["date"]}T00:00:00'
        slug = upd.get("slug")
        if slug:
            show = by_slug.get(slug)
            if not show:
                continue
            link = f'<a href="{show_url(show)}">{_show_label(show)}</a>'
            html = f'{esc(upd["text"])} &mdash; {link} {_src_tag(show)}'
            # Workflow-generated entries can link straight to the show's
            # technical-data table (rendered when a processing report exists).
            if upd.get("report"):
                html += f' &middot; <a href="{show_url(show)}#technical-data">view data</a>'
        else:
            # Site-wide note (e.g. a feature change) — no show link or source tag.
            html = esc(upd["text"])
        events.append((ts, slug or "", upd["date"], html))
    events.sort(key=lambda e: (e[0], e[1]), reverse=True)
    items = []
    for _ts, _slug, date, html in events:
        items.append(f'''      <li class="update-item">
        <span class="update-date">{esc(date)}</span>
        <div class="update-text">{html}</div>
      </li>''')
    return "\n".join(items)


def contact_block():
    return '''
  <section class="contact-section">
    <p class="contact-sub">Questions or comments about the recordings? Send a message below.</p>
    <form class="contact-form" id="contactForm">
      <div class="form-group">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" required autocomplete="name">
      </div>
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required autocomplete="email">
      </div>
      <div class="form-group">
        <label for="message">Message</label>
        <textarea id="message" name="message" required></textarea>
      </div>
      <button type="submit" class="form-submit" id="submitBtn">Send Message</button>
      <p id="formStatus"></p>
    </form>
  </section>
  <script>
  document.getElementById('contactForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('submitBtn');
    const status = document.getElementById('formStatus');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    status.textContent = '';
    status.className = '';
    try {
      const res = await fetch('https://contact-form.renedebos.workers.dev', {
        method: 'POST',
        body: new FormData(this)
      });
      if (res.ok) {
        status.textContent = 'Message sent — thank you!';
        status.className = 'success';
        this.reset();
      } else {
        throw new Error();
      }
    } catch {
      status.textContent = 'Something went wrong. Please try again.';
      status.className = 'error';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Message';
    }
  });
  </script>'''


# ── top-level pages ─────────────────────────────────────────────────────────

def build_home():
    return page_shell(
        title="The Hannan Recordings",
        description="Live recordings archive — Jerry Hannan, Sean Hannan, and Mad Hannans performing at clubs in Marin and the Bay Area in the late 1990s and early 2000s.",
        url="https://renedebos.com",
        eyebrow="Live Recordings Archive",
        heading="The <em>Hannan</em><br>Recordings",
        tagline="Live performances &mdash; San Francisco Bay Area",
        nav=site_nav("Home"),
        main=about_block() + why_block() + featured_card() + artist_notes_block(),
    )


def build_archive():
    toggle = '''
  <div class="view-toggle" role="group" aria-label="Sort shows">
    <button type="button" class="seg active" data-view="artist">By artist</button>
    <button type="button" class="seg" data-view="date">By date</button>
  </div>'''
    views = f'''
  <div class="archive-view" data-view="artist">{artist_sections(only_tracks=False)}
  </div>
  <div class="archive-view" data-view="date" hidden>{date_sorted_list()}
  </div>'''
    script = '''
<script>
(function () {
  var KEY = 'archiveView';
  var segs = document.querySelectorAll('.view-toggle .seg');
  var views = document.querySelectorAll('.archive-view');
  function apply(v) {
    segs.forEach(function (s) { s.classList.toggle('active', s.dataset.view === v); });
    views.forEach(function (x) { x.hidden = x.dataset.view !== v; });
  }
  segs.forEach(function (s) {
    s.addEventListener('click', function () {
      apply(s.dataset.view);
      try { localStorage.setItem(KEY, s.dataset.view); } catch (e) {}
    });
  });
  var saved;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === 'date') apply('date');
})();
</script>'''
    return page_shell(
        title="Archive — The Hannan Recordings",
        description="Every Jerry Hannan, Sean Hannan, and Mad Hannans recording in the archive, by artist or by date.",
        url="https://renedebos.com/archive/",
        eyebrow="The Hannan Recordings",
        heading="Archive",
        tagline="Every show &middot; by artist or by date",
        nav=site_nav("Archive"),
        main=toggle + views,
        extra_scripts=script,
    )


def build_shows():
    return page_shell(
        title="Shows — The Hannan Recordings",
        description="Shows that have been split into individual, streamable songs.",
        url="https://renedebos.com/shows/",
        eyebrow="The Hannan Recordings",
        heading="Shows",
        tagline="Split into individual songs &middot; by artist",
        nav=site_nav("Shows"),
        main=artist_sections(only_tracks=True),
    )


def artist_name(aid):
    return next((a["name"] for a in M["artists"] if a["id"] == aid), aid)


def show_city(show):
    v = show.get("venue") or ""
    return v.split(", ")[-1] if ", " in v else ""


def build_search_index():
    """Flat, denormalised index the /search/ page loads — one row per curated
    track plus one per show, with show fields resolved onto each track so a single
    text search spans song / artist / venue / city / date / source / tags."""
    rows = []
    for show in M["shows"]:
        aname = artist_name(show["artist"])
        city = show_city(show)
        year = (show.get("date") or "")[:4]
        ctx = " · ".join(x for x in [aname, show.get("venue_short") or "",
                                     show.get("date") or "Unknown date"] if x)
        base = {
            "showArtist": aname,             # always the show's artist (for filtering)
            "venue": show.get("venue_short") or "",
            "venueFull": show.get("venue") or "",
            "city": city,
            "date": show.get("date") or "",
            "year": year,
            "source": show.get("source") or "",
            "context": ctx,
        }
        rows.append(dict(base, **{
            "type": "show",
            "artist": aname,
            "subtitle": show.get("subtitle") or "",
            "tracks": len(show.get("tracks") or []),
            "url": show_url(show),
        }))
        for t in (show.get("tracks") or []):
            rows.append(dict(base, **{
                "type": "track",
                "song": t["title"],
                "artist": t.get("artist") or aname,
                "duration": t.get("duration") or "",
                "tags": t.get("tags") or [],
                "url": f'{show_url(show)}#track-{t["num"]}',
            }))
    return rows


def build_search():
    return page_shell(
        title="Search — The Hannan Recordings",
        description="Search the Hannan Recordings archive by song, artist, venue, date, or source.",
        url="https://renedebos.com/search/",
        eyebrow="The Hannan Recordings",
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


def build_updates():
    return page_shell(
        title="Updates — The Hannan Recordings",
        description="Recently added to the Hannan Recordings archive.",
        url="https://renedebos.com/updates/",
        eyebrow="The Hannan Recordings",
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
        title="The Story So Far — The Hannan Recordings",
        description="A behind-the-scenes history of how the Hannan Recordings archive came together.",
        url="https://renedebos.com/history/",
        eyebrow="The Hannan Recordings",
        heading="The Story So Far",
        tagline="A behind-the-scenes history of the archive",
        nav=site_nav("History"),
        main='''
  <section class="about">
    <p>
      This site is an ongoing labor of love &mdash; digitizing, cleaning up, and sharing the live recordings of Jerry Hannan, the Mad Hannans, and Sean Hannan. Here&rsquo;s how it has come together so far.
    </p>

    <h2>Week one &mdash; getting it online (June&nbsp;9&ndash;13, 2026)</h2>
    <p>
      The archive went live as a simple homepage and quickly grew a proper foundation.
    </p>
    <ul class="reasons">
      <li>Put up the first <strong>&ldquo;About This Archive&rdquo;</strong> page explaining what these recordings are and why I&rsquo;m sharing them.</li>
      <li><strong>Password-protected the lossless WAV masters</strong> so the big files stay controlled, while keeping the music easy to listen to.</li>
      <li>Set up <strong>automatic publishing</strong> &mdash; every change now deploys itself to the web.</li>
      <li>Rebuilt the site around a <strong>data-driven generator</strong>, giving each show its own page with a proper track list.</li>
      <li>Posted the first track-listed shows: <strong>Jerry Hannan at 19 Broadway</strong> (Jan&nbsp;8,&nbsp;2001), the <strong>Mad Hannans at Sweetwater</strong> (Feb&nbsp;17,&nbsp;2000), and <strong>Sean Hannan at 19 Broadway</strong> (Jan&nbsp;24,&nbsp;2000) &mdash; followed by a redesign of the archive and per-song sharing links.</li>
    </ul>

    <h2>Week two &mdash; more shows, more polish (June&nbsp;14&ndash;20, 2026)</h2>
    <p>
      The site split into proper sections &mdash; Home, Archive, Shows, Updates, and Contact &mdash; and an <strong>Updates feed</strong> began tracking changes as they happen. New shows kept arriving:
    </p>
    <ul class="reasons">
      <li><strong>Sean Hannan at 19 Broadway</strong> (Feb&nbsp;21,&nbsp;2000)</li>
      <li><strong>Jerry Hannan at 19 Broadway</strong> (Jan&nbsp;15,&nbsp;2001) &mdash; later volume-normalized across all 31 tracks</li>
      <li><strong>The Mad Hannans at Sweetwater</strong> (Oct&nbsp;17,&nbsp;2000) &mdash; the Birthday Show, with a full lossless download</li>
      <li><strong>Jerry Hannan at 19 Broadway</strong> (June&nbsp;21,&nbsp;1999)</li>
    </ul>
    <p>
      I also added notes about audio levels and the purpose of the archive, and began marking which recordings came straight off the soundboard (SBD) versus from the audience (AUD).
    </p>

    <h2>Week three &mdash; listening, searching, restoring (June&nbsp;21&ndash;26, 2026)</h2>
    <p>
      The biggest leap in how the archive <em>feels</em> to use:
    </p>
    <ul class="reasons">
      <li>Every full show now <strong>streams as a clean 320&nbsp;kbps MP3</strong>, with <strong>free MP3 downloads</strong> on the show pages.</li>
      <li>Added the <strong>Sean Hannan 19 Broadway</strong> (unknown date) set and the <strong>Mad Hannans at Cafe Java</strong> (Sept&nbsp;9,&nbsp;1999).</li>
      <li>Introduced <strong>waveform players</strong> so you can see each song as you listen.</li>
      <li>Added an <strong>Archive sort toggle</strong> (browse by date or by artist) and a <strong>search engine</strong> to find any song or show by title, artist, venue, date, or tag &mdash; backed by an ongoing effort to tag covers and songwriters.</li>
      <li>Posted the <strong>Mad Hannans at Sweetwater</strong> (Jan&nbsp;6,&nbsp;2001) &mdash; a rough, muffled audience tape that I then went back and <strong>cleaned up with EQ and loudness normalization</strong> to make it easier on the ears.</li>
      <li>Gave the <strong>Sean Hannan</strong> (Feb&nbsp;21,&nbsp;2000) set the same loudness treatment, and corrected a long-mislabeled song: <em>&ldquo;Irish Song&rdquo;</em> is really <strong>&ldquo;Ode to Biddy McGee.&rdquo;</strong></li>
    </ul>

    <h2>Week four &mdash; a real audio pipeline (June&nbsp;27&ndash;28, 2026)</h2>
    <p>
      The cleanup work grew up into a proper, repeatable process. Instead of treating each show by hand, there&rsquo;s now an <strong>automated audio-engineering workflow</strong> that takes the original lossless masters and brings every track to one consistent, comfortable listening level across the whole archive &mdash; solo sets and full-band shows alike &mdash; all with a ceiling that prevents digital clipping.
    </p>
    <ul class="reasons">
      <li>Each processed show now carries a <strong>&ldquo;Technical data&rdquo; panel</strong> &mdash; the before-and-after loudness, true peak, and dynamic range for every song, plus exactly which version of the workflow touched each track.</li>
      <li>Every show page shows its <strong>processing status at a glance</strong> &mdash; whether it&rsquo;s been through the new workflow yet, or is still on the list.</li>
      <li>Re-mastered to the new standard: <strong>Jerry Hannan at 19 Broadway</strong> &mdash; June&nbsp;21,&nbsp;1999; Jan&nbsp;8,&nbsp;2001 (now with <strong>lossless FLAC downloads</strong> added); and Jan&nbsp;15,&nbsp;2001 (redone from the masters to the new loudness standard).</li>
      <li>Settled on <strong>one loudness standard for the entire archive</strong> &mdash; after A/B testing confirmed the full-band shows gained nothing audible from being louder, the Mad Hannans sets now sit at the same comfortable level as everything else. The earlier −16 passes are being redone to match. First through the new process: the <strong>Mad Hannans at Sweetwater</strong> (Feb&nbsp;17,&nbsp;2000), the Oct&nbsp;17,&nbsp;2000 <strong>Birthday Show</strong>, the <strong>Cafe Java</strong> set (Sept&nbsp;9,&nbsp;1999), and <strong>Sean Hannan</strong>&rsquo;s Feb&nbsp;21,&nbsp;2000 set.</li>
      <li>Added <strong>corrective EQ to the workflow</strong> for salvaging poor source tapes, and used it to rebuild the muddy <strong>Mad Hannans at Sweetwater</strong> (Jan&nbsp;6,&nbsp;2001) straight from the raw transfer &mdash; cutting the low-mid mud and lifting presence and air to bring the vocals forward, then normalizing to the −20 standard. The exact EQ is recorded with each track.</li>
      <li>Behind the scenes: <strong>faster page loads</strong>, better link previews when a show is shared, and more reliable, properly protected lossless downloads.</li>
    </ul>

    <h2>Week five &mdash; repairing the damaged peaks (June&nbsp;29&ndash;30, 2026)</h2>
    <p>
      Some older recordings have a flaw that volume adjustment alone can&rsquo;t fix: bursts of applause so loud they overloaded the original tape and distorted. This week the focus turned to <strong>repairing that damage by hand</strong> before normalizing.
    </p>
    <ul class="reasons">
      <li>Went back to one of the very first shows posted &mdash; <strong>Sean Hannan at 19 Broadway</strong> (Jan&nbsp;24,&nbsp;2000), a 31-song solo set &mdash; and found nine tracks where loud audience clapping had clipped into distortion. Each one was <strong>hand-edited in Audacity</strong> to smooth out the overloaded peaks, then the whole show was brought to the archive&rsquo;s −20 loudness standard.</li>
      <li>Brought the undated <strong>Sean Hannan at 19 Broadway</strong> set (18 songs, with guest turns from Jerry Hannan and Kelly Peterson) through the same workflow &mdash; replacing an earlier &minus;16 pass with a clean &minus;20 normalization from the source.</li>
      <li>Kept the whole archive in sync: the original masters, the hand-edited versions, and the final normalized tracks are now all preserved together in the cloud backup.</li>
    </ul>

    <h2>Week six &mdash; New George&rsquo;s, split and faded (July&nbsp;5, 2026)</h2>
    <p>
      Added the <strong>Mad Hannans at New George&rsquo;s</strong> in San Rafael (Oct&nbsp;13,&nbsp;1999) as 14 individual tracks. The show survives as two audience DAT transfers, so I <strong>A/B&rsquo;d them side by side</strong> and went with the one that sounded best. Each song was split out, the applause <strong>gently faded</strong> at the end for easier back-to-back listening, and the whole set brought to the archive&rsquo;s &minus;20 loudness standard. The set opens with a short soundcheck.
    </p>

    <p class="about-note">The work continues &mdash; more shows, better audio, and small fixes are always in progress.</p>
  </section>''',
    )


def build_contact():
    return page_shell(
        title="Contact — The Hannan Recordings",
        description="Questions or comments about the recordings? Get in touch.",
        url="https://renedebos.com/contact/",
        eyebrow="The Hannan Recordings",
        heading="Contact",
        tagline="Questions or comments about the recordings",
        nav=site_nav("Contact"),
        main=contact_block(),
    )


# ── show pages ────────────────────────────────────────────────────────────────

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
            # Free MP3 download, plus a password-protected lossless FLAC
            # download when a FLAC exists.
            mp3_title = "Download MP3" + (f" · {t['size_mb']} MB" if t.get("size_mb") else "")
            dl_btns = [dl_button(t["file"], free=True, label="MP3", title=mp3_title)]
            if t.get("flac"):
                flac_title = "Download FLAC" + (f" · {t['flac_size_mb']} MB" if t.get("flac_size_mb") else "")
                dl_btns.append(dl_button(t["flac"], free=False, label="FLAC", title=flac_title))
            if has_waves:
                # waveform replaces the progress bar; downloads share the .ws-dl wrapper
                # so the mobile download-grouping styles apply (matches the lab page).
                dl = '\n        <div class="ws-dl">' + \
                     "".join("\n          " + b for b in dl_btns) + "\n        </div>"
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
        hint = ("Play streams free (MP3) &middot; download is lossless FLAC, password protected"
                if has_flac else "Play streams each song free (MP3)")
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
        cards.append(recording_card(title, meta, r["source"], r["file"], r["free"], r.get("stream")))
    label = "Full Recording" if len(canon) == 1 else "Full Recording &middot; " + f"{len(canon)} parts"
    streamed = any(r.get("stream") for r in canon)
    hint = ('\n    <p class="track-hint">Full shows stream as 320&nbsp;kbps MP3 &mdash; '
            'download the free MP3, or the lossless original (password protected).</p>'
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
            cards.append(recording_card(r["alt_label"], meta, r["source"], r["file"], r["free"], r.get("stream")))
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
                'Streaming is free, and may take a moment to start for large files.</p>'
                if any(r["format"] in ("WAV", "FLAC") and not r["free"] for r in show["recordings"]) else "")

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
        eyebrow="The Hannan Recordings",
        heading=f"{esc(artist['name'])}<br><em>Live at {esc(show['venue_short'])}</em>",
        tagline=" &middot; ".join(esc(b) for b in tagline_bits),
        nav=site_nav(),
        main="".join(parts) + wav_note,
        extra_scripts=extra_scripts,
    )


# ── wavesurfer.js prototype (unlinked /lab/ page) ─────────────────────────────

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
        mp3_title = "Download MP3" + (f" · {t['size_mb']} MB" if t.get("size_mb") else "")
        dl_btns = [dl_button(t["file"], free=True, label="MP3", title=mp3_title)]
        if t.get("flac"):
            flac_title = "Download FLAC" + (f" · {t['flac_size_mb']} MB" if t.get("flac_size_mb") else "")
            dl_btns.append(dl_button(t["flac"], free=False, label="FLAC", title=flac_title))
        dl_inner = "".join("\n          " + b for b in dl_btns)
        dl = f'\n        <div class="ws-dl">{dl_inner}\n        </div>'
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
        title="Waveform prototype — The Hannan Recordings",
        description="Experimental wavesurfer.js waveform player prototype.",
        url="https://renedebos.com/lab/wavesurfer/",
        eyebrow="Lab &middot; Prototype",
        heading="Waveform <em>prototype</em>",
        tagline=esc(show_title(show)),
        nav=site_nav(),
        main=main,
        extra_scripts=extra,
    )


# ── write everything ──────────────────────────────────────────────────────────

def write(path, content):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


def stamp_added_dates():
    """Stamp any show that has tracks but no `added` date yet, recording both a
    display date (`added`) and a full timestamp (`added_ts`) so same-day
    additions sort most-recent-first on the Updates page. Older shows stamped
    before `added_ts` existed are backfilled to midnight. Persists to
    recordings.json so the Updates page is hands-off."""
    today = datetime.date.today().isoformat()
    changed = []
    for s in M["shows"]:
        if s.get("tracks") and not s.get("added"):
            s["added"] = today
            s["added_ts"] = datetime.datetime.now().isoformat(timespec="microseconds")
            changed.append(s["slug"])
        elif s.get("added") and not s.get("added_ts"):
            s["added_ts"] = f'{s["added"]}T00:00:00'
            changed.append(s["slug"])
    if changed:
        with open(os.path.join(ROOT, "data", "recordings.json"), "w") as f:
            json.dump(M, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Stamped/backfilled added_ts on: {', '.join(changed)}")
    return changed


def validate():
    """Fail fast on the recordings.json footguns that otherwise produce broken
    pages or a mid-build crash. The whole site is generated from this one
    hand/tool-edited file, so a cheap up-front check is worth it."""
    errors = []
    artist_ids = {a["id"] for a in M["artists"]}
    seen_slugs = set()
    for i, s in enumerate(M["shows"]):
        where = s.get("slug") or f"shows[{i}]"
        if not s.get("slug"):
            errors.append(f"{where}: missing slug")
        elif s["slug"] in seen_slugs:
            errors.append(f"{where}: duplicate slug")
        else:
            seen_slugs.add(s["slug"])
        if s.get("artist") not in artist_ids:
            errors.append(f"{where}: artist {s.get('artist')!r} is not a known artist id {sorted(artist_ids)}")
        # null/absent means "no description" (build skips it); only a non-list
        # value such as a bare string is the footgun (renders char-by-char).
        if s.get("description") is not None and not isinstance(s["description"], list):
            errors.append(f"{where}: description must be a list of paragraph strings, not {type(s['description']).__name__}")
        for t in s.get("tracks") or []:
            tw = f"{where} track {t.get('num')}"
            if not isinstance(t.get("num"), int):
                errors.append(f"{tw}: num must be an integer")
            if not t.get("title"):
                errors.append(f"{tw}: missing title")
            if not t.get("file"):
                errors.append(f"{tw}: missing file (MP3 R2 key)")
    if errors:
        raise SystemExit("recordings.json validation failed:\n  - " + "\n  - ".join(errors))


def build_sitemap():
    base = "https://renedebos.com"
    urls = [base + p for _, p in SITE_PAGES]
    urls += [base + show_url(s) for s in M["shows"]]
    items = "\n".join(f"  <url><loc>{esc(u)}</loc></url>" for u in urls)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{items}\n</urlset>\n")


def main():
    validate()
    stamp_added_dates()
    here = os.path.dirname(os.path.abspath(__file__))
    write("assets/site.css", open(os.path.join(here, "site.css")).read())
    write("assets/player.js", open(os.path.join(here, "player.js")).read())
    write("assets/wavesurfer.esm.js", open(os.path.join(here, "vendor", "wavesurfer.esm.js")).read())
    write("assets/wavesurfer.js", open(os.path.join(here, "wavesurfer.js")).read())
    write("assets/search.js", open(os.path.join(here, "search.js")).read())
    write("assets/search-index.json", json.dumps(build_search_index(), ensure_ascii=False))
    write("lab/wavesurfer/index.html", build_wavesurfer_lab())
    write("index.html", build_home())
    write("archive/index.html", build_archive())
    write("shows/index.html", build_shows())
    write("search/index.html", build_search())
    write("updates/index.html", build_updates())
    write("history/index.html", build_history())
    write("contact/index.html", build_contact())
    write("sitemap.xml", build_sitemap())
    write("robots.txt", "User-agent: *\nAllow: /\nSitemap: https://renedebos.com/sitemap.xml\n")
    n = 0
    for show in M["shows"]:
        out = (show["page"] or f"shows/{show['slug']}") + "/index.html"
        write(out, build_show(show))
        n += 1
    total = sum(len(s["recordings"]) for s in M["shows"]) + len(M["singles"])
    print(f"Built 6 site pages + {n} show pages ({total} recordings, "
          f"{sum(len(s['tracks'] or []) for s in M['shows'])} curated tracks)")


if __name__ == "__main__":
    main()
