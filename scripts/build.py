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


def stream_url(file):
    return f"{WORKER}/stream?file={urllib.parse.quote(file)}"


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
SHARE_SVG = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
             'stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/>'
             '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/>'
             '<path d="M8.2 13.3l7.6 4.4M15.8 6.3l-7.6 4.4"/></svg>')


def player(file, free=False, duration=None, download_file=None):
    """A custom-player row: play button, progress bar, download button.

    Streams `file`; downloads `download_file` if given (e.g. stream MP3 but
    download lossless FLAC), otherwise downloads the streamed file.
    """
    stream = stream_url(file)
    dl = download_file or file
    dl_url = stream_url(dl)
    name = dl.split("/")[-1]
    end_label = f'<span class="time-label">{esc(duration)}</span>' if duration else ""
    free_attr = ' data-free="true"' if free else ""
    return f'''<div class="custom-player" data-src="{esc(stream)}">
          <button class="play-btn" aria-label="Play">{PLAY_SVG}</button>
          <div class="progress-wrap">
            <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
            <div class="time-row"><span class="time-label current">0:00</span>{end_label}</div>
          </div>
          <a class="download-btn"{free_attr} href="{esc(dl_url)}" download="{esc(name)}" title="Download">{DL_SVG}</a>
        </div>'''


def recording_card(title, meta_pairs, badge, file, free):
    grid = "".join(f'<span class="meta-label">{esc(k)}</span><span class="meta-value">{esc(v)}</span>'
                   for k, v in meta_pairs if v)
    return f'''      <div class="recording-item">
        <div class="recording-meta">
          <div>
            <div class="recording-title">{esc(title)}</div>
            <div class="recording-meta-grid">{grid}</div>
          </div>
          <span class="recording-badge">{esc(badge)}</span>
        </div>
        {player(file, free)}
      </div>'''


def page_shell(*, title, description, url, eyebrow, heading, tagline, nav, main):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="{esc(url)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♪</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
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

<script src="/assets/player.js"></script>
</body>
</html>
'''


# ── site navigation ─────────────────────────────────────────────────────────

SITE_PAGES = [
    ("Home", "/"),
    ("Archive", "/archive/"),
    ("Shows", "/shows/"),
    ("Updates", "/updates/"),
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
      This is very much a work in progress. I&rsquo;m steadily working through the show tapes &mdash; splitting them into individual songs and, where it helps the listening experience, cleaning up the free MP3 versions: normalizing the volume, adding gentle fades, and removing clicks where possible.
    </p>
    <p>
      The lossless files are kept close to the original transfer: the full-show WAV downloads and the individual-song FLAC downloads are only minimally processed, for anyone who wants the rawest version. All lossless downloads are password protected.
    </p>
    <p class="about-note">
      Most full-show recordings are large lossless WAV files (1&ndash;3 GB) and may take a moment to begin playing.
    </p>
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


def show_row(show):
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
    return f'''      <a class="show-row" href="{show_url(show)}" data-info="{info}">
        <span class="show-date">{esc(show["date"] or "Unknown date")}</span>
        <span class="show-venue">{esc(show["venue"] or "")}{subtitle}{extra_html}</span>
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


def updates_list():
    shows = sorted((s for s in M["shows"] if s.get("added")),
                   key=lambda s: (s["added"], s["slug"]), reverse=True)
    items = []
    for show in shows:
        artist = next(a for a in M["artists"] if a["id"] == show["artist"])
        label = f'{esc(artist["name"])} &middot; {esc(show["venue_short"])} &middot; {esc(show["date"] or "")}'
        src = show["source"]
        src_tag = f'<span class="src-tag src-{src.lower()}">{esc(src)}</span>'
        n = len(show["tracks"]) if show.get("tracks") else 0
        items.append(f'''      <li class="update-item">
        <span class="update-date">{esc(show["added"])}</span>
        <div class="update-text">Added <a href="{show_url(show)}">{label}</a> &mdash; {n} split tracks {src_tag}</div>
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
        main=about_block() + featured_card() + artist_notes_block(),
    )


def build_archive():
    return page_shell(
        title="Archive — The Hannan Recordings",
        description="Every Jerry Hannan, Sean Hannan, and Mad Hannans recording in the archive, grouped by artist.",
        url="https://renedebos.com/archive/",
        eyebrow="The Hannan Recordings",
        heading="Archive",
        tagline="Every show &middot; grouped by artist",
        nav=site_nav("Archive"),
        main=artist_sections(only_tracks=False),
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

    parts = []

    if show.get("description"):
        desc = "".join(f"\n    <p>{p}</p>" for p in show["description"])
        parts.append(f'''
  <section class="about">
    <h2>About This Show</h2>{desc}
  </section>''')

    if show.get("tracks"):
        has_flac = any(t.get("flac") for t in show["tracks"])
        downloads = has_flac and show.get("track_downloads", True)
        rows = []
        for t in show["tracks"]:
            stream = stream_url(t["file"])
            sizes = []
            if t.get("flac_size_mb"):
                sizes.append(f'FLAC {t["flac_size_mb"]} MB')
            if t.get("size_mb"):
                sizes.append(f'MP3 {t["size_mb"]} MB')
            info = esc(json.dumps([
                ["Artist", artist["name"]],
                ["Song", t["title"]],
                ["Venue", show["venue"] or "—"],
                ["Date", show["date"] or "Unknown date"],
                ["Format", "FLAC + MP3" if t.get("flac") else "MP3"],
                ["Size", " · ".join(sizes) or "—"],
            ], ensure_ascii=False))
            share = esc(f'{artist["name"]} — “{t["title"]}” ({show["venue_short"]} · {show["date"] or "live"})')
            # Download button only when the show offers downloads and the
            # track has a lossless FLAC; otherwise the track is stream-only.
            dl_btn = ""
            if downloads and t.get("flac"):
                dl_url = stream_url(t["flac"])
                name = t["flac"].split("/")[-1]
                dl_title = "Download FLAC" + (f" · {t['flac_size_mb']} MB" if t.get("flac_size_mb") else "")
                dl_btn = f'\n        <a class="download-btn" href="{esc(dl_url)}" download="{esc(name)}" title="{esc(dl_title)}">{DL_SVG}</a>'
            rows.append(f'''      <div class="track-row custom-player" id="track-{t["num"]}" data-src="{esc(stream)}">
        <button class="play-btn" aria-label="Play">{PLAY_SVG}</button>
        <span class="track-num">{t["num"]:02d}</span>
        <span class="track-title" data-info="{info}">{esc(t["title"])}</span>
        <span class="time-label current" data-duration="{esc(t["duration"])}">{esc(t["duration"])}</span>
        <button class="share-btn" data-text="{share}" aria-label="Share">{SHARE_SVG}</button>{dl_btn}
        <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
      </div>''')
        hint = ("Play streams free (MP3) &middot; download is lossless FLAC, password protected"
                if downloads else "Play streams each song free (MP3)")
        parts.append(f'''
  <section id="tracks">
    <div class="group-label-bare">Tracks &middot; {len(show["tracks"])} songs &middot; {track_total(show["tracks"])}</div>
    <p class="track-hint">{hint}</p>
    <div class="track-list" data-autoplay-next>
{chr(10).join(rows)}
    </div>
  </section>''')

    cards = []
    for r in canon:
        title = r["label"] or "Complete show"
        meta = [("Source", r["source"]), ("Format", r["format"]), ("Size", r["size"])]
        cards.append(recording_card(title, meta, r["source"], r["file"], r["free"]))
    label = "Full Recording" if len(canon) == 1 else "Full Recording &middot; " + f"{len(canon)} parts"
    parts.append(f'''
  <section>
    <div class="group-label-bare">{label}</div>
    <div class="recording-list">
{chr(10).join(cards)}
    </div>
  </section>''')

    if alts:
        cards = []
        for r in alts:
            meta = [("Source", r["source"]), ("Format", r["format"]), ("Size", r["size"])]
            cards.append(recording_card(r["alt_label"], meta, r["source"], r["file"], r["free"]))
        parts.append(f'''
  <section>
    <details class="alt-details">
      <summary>Alternate transfers ({len(alts)}) &mdash; other digitizations of the same tape</summary>
      <div class="recording-list">
{chr(10).join(cards)}
      </div>
    </details>
  </section>''')

    wav_note = ('\n  <p class="wav-note">Full-show WAV downloads are password protected. '
                'Streaming is free, and may take a moment to start for large files.</p>'
                if any(r["format"] == "WAV" and not r["free"] for r in show["recordings"]) else "")

    venue_city = show["venue"].split(", ")[-1] if show["venue"] and ", " in show["venue"] else None
    tagline_bits = [b for b in [
        f"{venue_city}, California" if venue_city else show["venue"],
        date_with_subtitle(show),
        SOURCE_LABEL.get(show["source"], show["source"]),
    ] if b]

    return page_shell(
        title=f"{show_title(show)} — {show['date'] or 'Unknown date'}",
        description=f"{show_title(show)}, {date_with_subtitle(show)} — {SOURCE_LABEL.get(show['source'], show['source'])}. Stream or download.",
        url=f"https://renedebos.com{show_url(show)}",
        eyebrow="The Hannan Recordings",
        heading=f"{esc(artist['name'])}<br><em>Live at {esc(show['venue_short'])}</em>",
        tagline=" &middot; ".join(esc(b) for b in tagline_bits),
        nav=site_nav(),
        main="".join(parts) + wav_note,
    )


# ── write everything ──────────────────────────────────────────────────────────

def write(path, content):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


def stamp_added_dates():
    """Stamp today's date on any show that has tracks but no `added` date yet,
    and persist it to recordings.json so the Updates page is hands-off."""
    today = datetime.date.today().isoformat()
    stamped = [s["slug"] for s in M["shows"] if s.get("tracks") and not s.get("added")]
    for s in M["shows"]:
        if s.get("tracks") and not s.get("added"):
            s["added"] = today
    if stamped:
        with open(os.path.join(ROOT, "data", "recordings.json"), "w") as f:
            json.dump(M, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Stamped added={today} on: {', '.join(stamped)}")
    return stamped


def main():
    stamp_added_dates()
    here = os.path.dirname(os.path.abspath(__file__))
    write("assets/site.css", open(os.path.join(here, "site.css")).read())
    write("assets/player.js", open(os.path.join(here, "player.js")).read())
    write("index.html", build_home())
    write("archive/index.html", build_archive())
    write("shows/index.html", build_shows())
    write("updates/index.html", build_updates())
    write("contact/index.html", build_contact())
    n = 0
    for show in M["shows"]:
        out = (show["page"] or f"shows/{show['slug']}") + "/index.html"
        write(out, build_show(show))
        n += 1
    total = sum(len(s["recordings"]) for s in M["shows"]) + len(M["singles"])
    print(f"Built 5 site pages + {n} show pages ({total} recordings, "
          f"{sum(len(s['tracks'] or []) for s in M['shows'])} curated tracks)")


if __name__ == "__main__":
    main()
