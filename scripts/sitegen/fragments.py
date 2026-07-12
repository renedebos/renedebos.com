"""sitegen.fragments: page chrome and reusable HTML bits (players, rows, cards, blocks, JSON-LD)."""
import datetime
import html
import json
import os
import re
import sys
import urllib.parse

from .core import *  # noqa: F401,F403

# scripts/ directory — prose fragments live in scripts/content/
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DL_SVG = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
          'stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v13"/>'
          '<path d="M6 12l6 6 6-6"/><path d="M8 21h8"/></svg>')

PLAY_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>'

def dl_button(file, *, title="Download"):
    # Icon-only (no text label): with only the password-protected lossless
    # download left, the format doesn't need spelling out in the button —
    # it's in the hover title, and the password modal makes the gating clear
    # on first click. `title` doubles as the accessible name.
    url = stream_url(file)
    name = file.split("/")[-1]
    return (f'<a class="download-btn" href="{esc(url)}" aria-label="{esc(title)}" '
            f'download="{esc(name)}" title="{esc(title)}">{DL_SVG}</a>')

def player(file, duration=None, download_file=None, version=None, label=None):
    """A custom-player row: play button, progress bar, and (optionally) a
    password-protected download button.

    Streams `file` (the lossy MP3 proxy). When `download_file` is given — the
    lossless original — the row offers its password-gated download; there are
    no free downloads, streaming is the only ungated path. `version`
    cache-busts the stream URL (pass a track's MD5) so a re-normalized upload
    goes live immediately. `label` (song/artist/date) becomes the play
    button's accessible name — otherwise a screen reader hears "Play" on
    every single instance with no way to tell them apart.
    """
    stream = stream_url(file, version)
    end_label = f'<span class="time-label">{esc(duration)}</span>' if duration else ""
    if download_file:
        loss_fmt = download_file.rsplit(".", 1)[-1].upper()
        downloads = dl_button(download_file,
                              title=f"Download lossless {loss_fmt} (password protected)")
    else:
        downloads = ""
    play_label = f' {esc(label)}' if label else ""
    play_data = f' data-play-label="{esc(label)}"' if label else ""
    seek_label = f'Seek{play_label}' if label else "Seek"
    return f'''<div class="custom-player" data-src="{esc(stream)}">
          <button class="play-btn" aria-label="Play{play_label}"{play_data}>{PLAY_SVG}</button>
          <div class="progress-wrap">
            <input type="range" class="progress-range" min="0" max="1000" value="0" step="1" aria-label="{seek_label}" aria-valuetext="0:00">
            <div class="time-row"><span class="time-label current">0:00</span>{end_label}</div>
          </div>
          {downloads}
        </div>'''

def recording_card(title, meta_pairs, badge, file, stream_file=None, play_label=None):
    # Stream the lossy proxy (stream_file) when one exists; the lossless `file`
    # is only reachable through the download/password flow.
    grid = "".join(f'<span class="meta-label">{esc(k)}</span><span class="meta-value">{esc(v)}</span>'
                   for k, v in meta_pairs if v)
    lossless = file.rsplit(".", 1)[-1].lower() in ("wav", "flac")
    play = player(stream_file or file,
                  download_file=file if lossless else None, label=play_label)
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

def page_shell(*, title, description, url, eyebrow, heading, tagline, nav, main, extra_scripts="", extra_head=""):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{esc(url)}">
<meta name="theme-color" content="#f5f2ed" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#17150f" media="(prefers-color-scheme: dark)">
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
<link rel="alternate" type="application/rss+xml" title="The Hannan Tapes &mdash; Updates" href="https://renedebos.com/feed.xml">
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/site.css">{extra_head}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<header>
  <a class="mark" href="/" aria-label="The Hannan Tapes &mdash; home">&#9834;</a>
  <nav>
{nav}
  </nav>
</header>

<div class="page-title">
  <p class="site-eyebrow">{eyebrow}</p>
  <h1>{heading}</h1>
  <p class="site-tagline">{tagline}</p>
</div>

<main id="main">
{main}
</main>

<footer>
  Part of <a href="/">The Hannan Tapes</a> archive
  <span class="footer-links">
    <a href="/history/">The Story So Far</a> &middot;
    <a href="/process/">The Process</a> &middot;
    <a href="/contact/">Contact</a> &middot;
    <a href="/feed.xml">RSS</a>
  </span>
</footer>

<script src="/assets/player.js"></script>{extra_scripts}
</body>
</html>
'''

SITE_PAGES = [
    ("Home", "/"),
    ("Archive", "/archive/"),
    ("Songs", "/songs/"),
    ("Playlist", "/playlist/"),
    ("Search", "/search/"),
    ("Updates", "/updates/"),
]

EXTRA_PAGES = [
    ("History", "/history/"),
    ("Process", "/process/"),
    ("Manual", "/manual/"),
    ("Contact", "/contact/"),
]

def site_nav(active=None):
    links = []
    for label, href in SITE_PAGES[1:]:  # skip Home — the header's logo mark covers it
        cls = ' class="active"' if label == active else ""
        links.append(f'  <a href="{href}"{cls}>{label}</a>')
    return "\n".join(links)

def content(name):
    """Long-form prose lives in scripts/content/*.html so editing the site's
    narrative (a standing weekly task) never touches Python."""
    return open(os.path.join(HERE, "content", name)).read()

def md_to_html(md):
    """Render the subset of Markdown that repo docs (PUBLISHING.md) use into
    site HTML: #/##/### headings, ---, paragraphs, tables, bullet + numbered
    lists (one nesting level), **bold**, *italic*, `code`, [text](url).
    Dependency-free on purpose — CI builds on stock python3."""
    def inline(s):
        s = esc(s)
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
        s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
        return s

    out, i, lines = [], 0, md.splitlines()
    para = []
    def flush_para():
        if para:
            out.append(f"<p>{inline(' '.join(para))}</p>")
            para.clear()

    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            flush_para(); i += 1; continue
        if s.startswith("#"):
            flush_para()
            level = len(s) - len(s.lstrip("#"))
            text = s.lstrip("# ")
            hid = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-",
                         re.sub(r"[*`]", "", text).lower())).strip("-")
            out.append(f'<h{level} id="{hid}">{inline(text)}</h{level}>')
            i += 1; continue
        if s == "---":
            flush_para(); out.append("<hr>"); i += 1; continue
        if s.startswith(">"):
            flush_para()
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip("> ").strip())
                i += 1
            body = inline(" ".join(q for q in quote if q))
            # bolded lead-in decides the callout flavor (warnings vs notes)
            kind = ("warn" if re.match(
                r"<strong>(Rule|Before|Important|Warning|Never|Do not)",
                body) else "note")
            out.append(f'<blockquote class="callout {kind}"><p>{body}</p></blockquote>')
            continue
        if s.startswith("|"):
            flush_para()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", c) for c in cells):
                    rows.append(cells)
                i += 1
            head, body = rows[0], rows[1:]
            th = "".join(f"<th>{inline(c)}</th>" for c in head)
            tb = "\n".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>"
                           for r in body)
            out.append(f'<div class="md-scroll"><table><thead><tr>{th}</tr></thead>'
                       f"<tbody>\n{tb}\n</tbody></table></div>")
            continue
        m = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)$", ln)
        if m:
            flush_para()
            # gather the whole list block: items, indented continuations, nested
            # items, and blank lines *between* items (common in numbered lists)
            item_re = re.compile(r"^(\s*)([-*]|\d+\.)\s+")
            block = []
            while i < len(lines):
                cur = lines[i]
                if cur.strip() == "":
                    nxt = lines[i + 1] if i + 1 < len(lines) else ""
                    if block and (item_re.match(nxt) or
                                  (nxt.startswith("  ") and nxt.strip())):
                        i += 1; continue
                    break
                if item_re.match(cur) or (block and cur.startswith("  ")):
                    block.append(cur); i += 1
                else:
                    break
            out.append(_md_list(block, inline))
            continue
        para.append(s); i += 1
    flush_para()
    return "\n".join(out)

def _md_list(block, inline):
    """One list block -> <ul>/<ol>, supporting continuation lines and one
    level of nested bullets under a top-level item."""
    first_num = re.match(r"^(\d+)\.", block[0].strip())
    ordered = bool(first_num)
    items = []          # each: [text, [nested-bullet-texts]]
    for ln in block:
        m = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)$", ln)
        if m and not m.group(1):                       # top-level item
            items.append([m.group(3), []])
        elif m and items:                              # nested bullet
            items[-1][1].append(m.group(3))
        elif items:                                    # continuation line
            tgt = items[-1][1] if items[-1][1] else items[-1]
            tgt[-1 if items[-1][1] else 0] += " " + ln.strip()
    lis = []
    for k, (text, nested) in enumerate(items):
        sub = ("<ul>" + "".join(f"<li>{inline(n)}</li>" for n in nested) + "</ul>"
               if nested else "")
        # ordered items carry their literal number (data-n for styling), so a
        # callout can interrupt a numbered list without resetting the steps
        n = f' data-n="{int(first_num.group(1)) + k}"' if ordered else ""
        lis.append(f"<li{n}>{inline(text)}{sub}</li>")
    if ordered:
        start = f' start="{first_num.group(1)}"' if first_num.group(1) != "1" else ""
        return f"<ol{start}>" + "\n".join(lis) + "</ol>"
    return "<ul>" + "\n".join(lis) + "</ul>"

def _pre_edit_label(pre_edits):
    """Short badge text for a show's recorded pre_edits provenance: only
    actual noise reduction gets called "noise-reduced" / "NR" — any other
    manual Audacity work (EQ, etc.) gets the generic "pre-edited" bucket."""
    return "noise-reduced" if "noise reduction" in pre_edits.lower() else "pre-edited"

def _pre_edit_class(label):
    """CSS modifier so the NR badge and the generic pre-edited badge don't
    share a color with each other or with the "done" status badge."""
    return "pre-edit-nr" if label == "noise-reduced" else "pre-edit-pe"

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
    # Pre-edit pill: shows whose provenance records manual pre-edits get a
    # marker on the listing, mirroring the show page's tech-table badge.
    # Rendered inside the venue cell — the row is a fixed 5-column grid, so
    # it must not be an extra grid child.
    proc = load_processing(show["slug"])
    nr_html = ""
    if proc and proc.get("pre_edits"):
        label = _pre_edit_label(proc["pre_edits"])
        tag = "NR" if label == "noise-reduced" else "PE"
        nr_html = (f' <span class="proc-status pre-edit {_pre_edit_class(label)} show-nr" '
                   f'title="{esc(proc["pre_edits"])}">{tag}</span>')
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
        <span class="show-venue">{artist_prefix}{esc(show["venue"] or "")}{subtitle}{extra_html}{nr_html}</span>
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

def date_sorted_list(only_tracks=False):
    # One flat chronological list across all artists (oldest first; undated shows
    # sort last via sort_key). Used by the Archive's "By date" view.
    shows = sorted((s for s in M["shows"] if s.get("tracks") or not only_tracks), key=sort_key)
    rows = "\n".join(show_row(s, with_artist=True) for s in shows)
    return f'''
  <section class="artist-section">
    <div class="show-list">
{rows}
    </div>
  </section>'''

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
    # noise-reduced pill next to the status badge, same source of truth as
    # the tech-table badge and the archive-row pill (sidecar pre_edits)
    proc = load_processing(show["slug"])
    nr = ""
    if proc and proc.get("pre_edits"):
        label = _pre_edit_label(proc["pre_edits"])
        nr = (f'<span class="proc-status pre-edit {_pre_edit_class(label)}" '
              f'title="{esc(proc["pre_edits"])}">{label}</span>')
    return (f'''
  <p class="proc-status-line">Audio processing'''
            f'<span class="proc-status status-{esc(st)}">{esc(st)}</span>{nr}'
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
    if proc.get("pre_edits"):
        head_bits.append(f'Pre-edits: {esc(proc["pre_edits"])}')
    if proc.get("filters"):
        head_bits.append(f'Filters: {esc(proc["filters"])}')
    head_bits.append(esc(proc.get("tool", "ffmpeg loudnorm")))
    if proc.get("workflow_version") is not None:
        head_bits.append(f'workflow&nbsp;v{esc(proc["workflow_version"])}')
    if proc.get("date"):
        head_bits.append(esc(proc["date"]))
    head_bits.append('<a href="/process/">how these tracks were made</a>')
    head = " &middot; ".join(head_bits)
    # show-level status badge (from recordings.json, written by `status --write`)
    status = show.get("processing_status")
    badge = (f' <span class="proc-status status-{esc(status)}">{esc(status)}</span>'
             if status else "")
    # pre-edits badge: manual Audacity work beyond standard fades/clip-fixes stands
    # out even while the table is collapsed; hover shows the recorded detail.
    if proc.get("pre_edits"):
        label = _pre_edit_label(proc["pre_edits"])
        badge += (f' <span class="proc-status pre-edit {_pre_edit_class(label)}" '
                  f'title="{esc(proc["pre_edits"])}">{label}</span>')
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

def _song_occ_html(o, song_title):
    label = f'{song_title}, {o["artist_name"]}, {o["date"]}'
    p = player(o["file"], duration=o.get("duration"), version=o["ver"], label=label)
    anchor = f'{esc(o["url"])}#track-{o["num"]}'
    return f'''<div class="song-occ">
        <div class="song-occ-head">
          <a class="artist-chip artist-{o['artist']}" href="{anchor}">{esc(o['artist_name'])}</a>
          <span class="song-occ-where">{esc(o['venue'])} &middot; {esc(o['date'])}</span>
          <a class="song-occ-open" href="{anchor}">open on show page &rarr;</a>
        </div>
        {p}
      </div>'''

def jsonld(*objs):
    """Wrap schema.org object(s) in a JSON-LD <script> for the page <head>."""
    objs = [o for o in objs if o]
    if not objs:
        return ""
    payload = objs[0] if len(objs) == 1 else objs
    return ('\n<script type="application/ld+json">'
            + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            + "</script>")

def home_jsonld():
    return jsonld({
        "@context": "https://schema.org", "@type": "WebSite",
        "name": "The Hannan Tapes", "url": "https://renedebos.com/",
        "description": "Live recordings archive — Jerry Hannan, Sean Hannan, and Mad Hannans.",
        "potentialAction": {
            "@type": "SearchAction",
            "target": {"@type": "EntryPoint",
                       "urlTemplate": "https://renedebos.com/search/?q={search_term_string}"},
            "query-input": "required name=search_term_string",
        },
    })

def show_jsonld(show, artist):
    ev = {
        "@context": "https://schema.org", "@type": "MusicEvent",
        "name": f"{artist['name']} live at {show.get('venue_short') or show.get('venue')}",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "eventStatus": "https://schema.org/EventScheduled",
        "performer": {"@type": "MusicGroup", "name": artist["name"]},
        "location": {"@type": "MusicVenue", "name": show.get("venue") or show.get("venue_short")},
        "url": f"https://renedebos.com{show_url(show)}",
        "image": "https://renedebos.com/assets/og.png",
    }
    if show.get("date"):
        ev["startDate"] = show["date"]
    objs = [ev]
    tracks = show.get("tracks") or []
    if tracks:
        items = []
        for t in tracks:
            rec = {"@type": "MusicRecording", "position": t["num"], "name": t["title"],
                   "byArtist": {"@type": "MusicGroup", "name": artist["name"]}}
            d = iso_duration(t.get("duration"))
            if d:
                rec["duration"] = d
            items.append(rec)
        objs.append({
            "@context": "https://schema.org", "@type": "MusicPlaylist",
            "name": f"{show_title(show)} — {show.get('date') or ''}".strip(" —"),
            "url": f"https://renedebos.com{show_url(show)}",
            "numTracks": len(tracks), "track": items,
        })
    return jsonld(*objs)

def song_jsonld(s):
    return jsonld({
        "@context": "https://schema.org", "@type": "MusicComposition",
        "name": s["canonical"],
        "url": f"https://renedebos.com/songs/{s['slug']}/",
        "recordedAs": [{
            "@type": "MusicRecording", "name": s["canonical"],
            "byArtist": {"@type": "MusicGroup", "name": artist_name(o["artist"])},
            "url": f"https://renedebos.com{o['url']}#track-{o['num']}",
        } for o in s["occ"]],
    })


__all__ = ['DL_SVG', 'EXTRA_PAGES', 'PLAY_SVG', 'SITE_PAGES', 'STATUS_BLURB', '_show_label', '_song_occ_html', '_src_tag', 'artist_sections', 'contact_block', 'content', 'date_sorted_list', 'dl_button', 'home_jsonld', 'jsonld', 'md_to_html', 'page_shell', 'player', 'recording_card', 'show_jsonld', 'show_row', 'site_nav', 'song_jsonld', 'status_line', 'tech_data_section', 'updates_list']
