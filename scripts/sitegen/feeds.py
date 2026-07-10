"""sitegen.feeds: machine-readable outputs — search index, playlist catalog, RSS, sitemap."""
import datetime
import html
import json
import os
import re
import sys
import urllib.parse

from .core import *       # noqa: F401,F403
from .fragments import *  # noqa: F401,F403

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
                "songwriter": t.get("songwriter") or "",
                "duration": t.get("duration") or "",
                "tags": t.get("tags") or [],
                "url": f'{show_url(show)}#track-{t["num"]}',
            }))
    return rows

def build_track_catalog():
    """Flat playlist catalog (assets/tracks.json) — one row per curated track,
    self-contained so the playlist page can filter and queue without loading
    recordings.json. `file` is the R2 MP3 key; stream via WORKER/stream?file=.
    `song` is the canonical song slug so the player can avoid queueing two
    performances of the same song under variant titles.
    Spec: PLAYLIST FEATURE.md, Phase 1."""
    song_of = {}
    for s in collect_songs()[0]:
        for o in s["occ"]:
            song_of[(o["slug"], o["num"])] = s["slug"]
    rows = []
    for show in sorted([s for s in M["shows"] if s.get("tracks")], key=sort_key):
        proc = load_processing(show["slug"])
        ptracks = proc.get("tracks", {}) if proc else {}
        for t in show["tracks"]:
            rows.append({
                "id": f'{show["slug"]}-{t["num"]:02d}',
                "title": t["title"],
                "song": song_of.get((show["slug"], t["num"])),
                "artist": show["artist"],
                "performer": t.get("artist"),
                "songwriter": t.get("songwriter"),
                "showDate": show.get("date"),
                "venue": show.get("venue_short") or "",
                "sourceType": (show.get("source") or "").lower(),
                "tags": t.get("tags") or [],
                "durationSec": _duration_sec(t["duration"]),
                "file": t["file"],
                "ver": (ptracks.get(str(t["num"]), {}).get("md5") or "")[:12] or None,
                "url": f'{show_url(show)}#track-{t["num"]}',
            })
    return rows

def _xesc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def build_feed():
    base = "https://renedebos.com"
    ups = sorted(M.get("updates", []),
                 key=lambda u: u.get("ts") or u.get("date") or "", reverse=True)[:40]
    by_slug = {s["slug"]: s for s in M["shows"]}
    items = []
    for u in ups:
        slug = u.get("slug")
        link = f"{base}{show_url(by_slug[slug])}" if slug in by_slug else f"{base}/updates/"
        raw = u.get("text", "")
        plain = _xesc(html.unescape(re.sub(r"<[^>]+>", "", raw)))
        title = plain if len(plain) <= 90 else plain[:89] + "…"
        ts = u.get("ts") or ((u.get("date") or "1999-01-01") + "T12:00:00")
        try:
            dt = datetime.datetime.fromisoformat(ts)
        except Exception:
            dt = datetime.datetime(1999, 1, 1)
        pub = dt.strftime("%a, %d %b %Y %H:%M:%S +0000")
        guid = f"{base}/updates/#{u.get('date','')}-{slug or 'site'}"
        items.append(
            f"  <item>\n    <title>{title}</title>\n    <link>{esc(link)}</link>\n"
            f"    <guid isPermaLink=\"false\">{esc(guid)}</guid>\n"
            f"    <pubDate>{pub}</pubDate>\n    <description>{plain}</description>\n  </item>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<?xml-stylesheet type="text/xsl" href="/assets/feed.xsl"?>\n'
            '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n'
            "  <title>The Hannan Tapes &#8212; Updates</title>\n"
            f"  <link>{base}/updates/</link>\n"
            "  <description>New shows, re-masters, and fixes in the Hannan live archive.</description>\n"
            "  <language>en-us</language>\n"
            f'  <atom:link href="{base}/feed.xml" rel="self" type="application/rss+xml"/>\n'
            + "\n".join(items) + "\n</channel>\n</rss>\n")

def build_sitemap():
    base = "https://renedebos.com"
    urls = [base + p for _, p in SITE_PAGES + EXTRA_PAGES]
    urls += [base + show_url(s) for s in M["shows"]]
    urls += [f"{base}/songs/{s['slug']}/" for s in collect_songs()[0]]
    items = "\n".join(f"  <url><loc>{esc(u)}</loc></url>" for u in urls)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{items}\n</urlset>\n")


__all__ = ['_xesc', 'build_feed', 'build_search_index', 'build_sitemap', 'build_track_catalog']
