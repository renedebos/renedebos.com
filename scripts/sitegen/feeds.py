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
    for show in PUBLIC_SHOWS:
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
                "num": t["num"],
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
        var = load_variant(show["slug"])
        vtracks = var.get("tracks", {}) if var else {}
        for t in show["tracks"]:
            v = vtracks.get(str(t["num"]))
            rows.append({
                "id": f'{show["slug"]}-{t["num"]:02d}',
                "title": t["title"],
                "num": t["num"],
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
                "flac": t.get("flac"),
                "flac_size_mb": t.get("flac_size_mb"),
                # Archive MP3 size -- and, because both renders are 320 kbps
                # CBR of the same audio, the loud variant's size too (measured
                # within 7 bytes on all 680; see _loud_zip() in fragments.py).
                # The playlist page sums it for the loud ZIP's size label.
                "size_mb": t.get("size_mb"),
                # Loud variant: emitted per track, and ONLY when that track has
                # variant provenance — the player must never be handed a key
                # that was not actually rendered.
                "loud": variant_key(t["file"]) if v else None,
                "loudVer": (v.get("mp3_md5") or "")[:12] if v else None,
                "ver": (ptracks.get(str(t["num"]), {}).get("md5") or "")[:12] or None,
                # workflow version, named distinctly from "ver" above (that's an
                # unrelated md5-prefix cache-buster) — same field as track-spec.json's procVer.
                "procVer": ptracks.get(str(t["num"]), {}).get("ver"),
                "url": f'{show_url(show)}#track-{t["num"]}',
            })
    return rows

def build_home_shows():
    """Show-level catalog (assets/home-shows.json) for the homepage's merged
    archive listing — one row per track-listed show, sortable client-side by
    date/artist/venue (scripts/home.js) without loading recordings.json."""
    rows = []
    for show in sorted([s for s in PUBLIC_SHOWS if s.get("tracks")], key=sort_key):
        proc = load_processing(show["slug"])
        pre_edit, pre_edit_title = None, None
        if proc and proc.get("pre_edits"):
            label = _pre_edit_label(proc["pre_edits"])
            pre_edit = "NR" if label == "noise-reduced" else "PE"
            pre_edit_title = proc["pre_edits"]
        rows.append({
            "slug": show["slug"],
            "artist": artist_name(show["artist"]),
            "date": show.get("date"),
            "dateDisplay": show.get("date_display") or "Unknown date",
            "venue": show.get("venue") or show.get("venue_short") or "",
            "n": len(show["tracks"]),
            "dur": track_total(show["tracks"]),
            "source": show["source"],
            "highlight": bool(show.get("highlight")),
            "preEdit": pre_edit,
            "preEditTitle": pre_edit_title,
            "url": show_url(show),
        })
    return rows

def build_track_spec_catalog():
    """Flat per-track spec/provenance catalog (assets/track-spec.json) for the
    /archive-data/ page — every track in the archive (not just processed ones;
    "not yet processed" is itself a useful filter state), merging recordings.json
    catalog fields with data/processing/<slug>.json provenance where it exists.
    `procVer` is the workflow version (see WORKFLOW_VERSIONS in audio_process.py)
    — named distinctly from tracks.json's `ver`, which is an unrelated md5-prefix
    cache-buster, not a version number."""
    rows = []
    for show in sorted(M["shows"], key=sort_key):
        if not show.get("tracks"):
            continue
        proc = load_processing(show["slug"])
        ptracks = proc.get("tracks", {}) if proc else {}
        var = load_variant(show["slug"])
        vtracks = var.get("tracks", {}) if var else {}
        for t in show["tracks"]:
            p = ptracks.get(str(t["num"]), {})
            v = vtracks.get(str(t["num"]), {})
            gain = (round(p["lufs"] - p["in_lufs"], 2)
                    if "lufs" in p and "in_lufs" in p else None)
            rows.append({
                "id": f'{show["slug"]}-{t["num"]:02d}',
                "num": t["num"],
                "title": t["title"],
                "artist": show["artist"],
                "performer": t.get("artist"),
                "songwriter": t.get("songwriter"),
                "tags": t.get("tags") or [],
                "dropouts": bool(t.get("dropouts")),
                "showSlug": show["slug"],
                "venue": show.get("venue_short") or show.get("venue") or "",
                "showDate": show.get("date"),
                "sourceType": (show.get("source") or "").lower(),
                "duration": t.get("duration"),
                "mp3SizeMb": t.get("size_mb"),
                "flacSizeMb": t.get("flac_size_mb"),
                "url": f'{show_url(show)}#track-{t["num"]}',
                "procVer": p.get("ver"),
                "inLufs": p.get("in_lufs"),
                "outLufs": p.get("lufs"),
                "gain": gain,
                "truePeak": p.get("tp"),
                "mp3TruePeak": p.get("mp3_tp"),
                "lra": p.get("lra"),
                "plr": p.get("plr"),
                "maxM": p.get("max_m"),
                "maxS": p.get("max_s"),
                "treatment": p.get("mode"),
                "chain": p.get("chain"),
                # v8 transient-cap guardrail record (None for other modes):
                # cap depth + engagement stats for auditing capped tracks
                "tcap": p.get("transient_cap"),
                # The -14 loud variant, if rendered. `loudFrom` records that it
                # is DERIVED FROM the -20 archive rather than from source, and
                # loudSrcMd5 is the proof: it equals this track's archive `md5`.
                # Never merge these into the fields above — they describe a
                # different render. See CLAUDE.md, "The -14 loud variant".
                "loud": ({
                    "lufs": v.get("lufs"), "lra": v.get("lra"),
                    "truePeak": v.get("tp"), "mp3TruePeak": v.get("mp3_tp"),
                    "treatment": v.get("mode"), "tcap": v.get("transient_cap"),
                    "lraDelta": (round(v["lra"] - p["lra"], 2)
                                 if "lra" in v and "lra" in p else None),
                    "loudFrom": "archive-20", "loudSrcMd5": v.get("src_md5"),
                } if v else None),
            })
    return rows

def build_song_occurrences():
    """Per-song performance data (assets/song-occurrences.json) — fetched once
    by songs.js and rendered into a song's <details> only when it's opened, so
    the Songs index doesn't have to embed every occurrence's player HTML (400+
    of them) in the initial page. Keyed by song slug; each occurrence carries
    exactly what _song_occ_html() needs to build a row client-side."""
    songs, _ = collect_songs()
    return {s["slug"]: {"title": s["canonical"], "occ": s["occ"]} for s in songs}

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
    urls += [base + show_url(s) for s in PUBLIC_SHOWS]
    urls += [f"{base}/songs/{s['slug']}/" for s in collect_songs()[0]]
    items = "\n".join(f"  <url><loc>{esc(u)}</loc></url>" for u in urls)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{items}\n</urlset>\n")


__all__ = ['_xesc', 'build_feed', 'build_home_shows', 'build_search_index', 'build_sitemap', 'build_song_occurrences', 'build_track_catalog', 'build_track_spec_catalog']
