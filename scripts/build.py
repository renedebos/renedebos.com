#!/usr/bin/env python3
"""Static site generator for renedebos.com — entry point.

The generator lives in the sitegen package:
  sitegen/core.py       data, constants, helpers, validation, song concordance
  sitegen/fragments.py  page chrome + reusable HTML bits
  sitegen/pages.py      one build_* function per page
  sitegen/feeds.py      search index, playlist catalog, RSS, sitemap
Long-form prose is in scripts/content/*.html.

Usage:
  python3 scripts/build.py           build the whole site into the repo root
  python3 scripts/build.py --check   integrity checks only, write nothing
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sitegen.core import *       # noqa: F401,F403
from sitegen.fragments import *  # noqa: F401,F403
from sitegen.pages import *      # noqa: F401,F403
from sitegen.feeds import *      # noqa: F401,F403

def main():
    validate()
    check_orphan_song_dirs()
    if "--check" in sys.argv[1:]:
        n_shows = len(M["shows"])
        n_tracks = sum(len(s["tracks"] or []) for s in M["shows"])
        print(f"integrity OK — {n_shows} shows, {n_tracks} curated tracks, no orphan song pages")
        return
    stamp_added_dates()
    here = os.path.dirname(os.path.abspath(__file__))
    write("assets/site.css", open(os.path.join(here, "site.css")).read())
    write("assets/player.js", open(os.path.join(here, "player.js")).read())
    write("assets/wavesurfer.esm.js", open(os.path.join(here, "vendor", "wavesurfer.esm.js")).read())
    write("assets/wavesurfer.js", open(os.path.join(here, "wavesurfer.js")).read())
    write("assets/search.js", open(os.path.join(here, "search.js")).read())
    write("assets/playlist.js", open(os.path.join(here, "playlist.js")).read())
    write("assets/songs.js", open(os.path.join(here, "songs.js")).read())
    write("assets/search-index.json", json.dumps(build_search_index(), ensure_ascii=False))
    write("assets/tracks.json", json.dumps(build_track_catalog(), ensure_ascii=False))
    write("lab/wavesurfer/index.html", build_wavesurfer_lab())
    write("index.html", build_home())
    write("archive/index.html", build_archive())
    write("songs/index.html", build_songs_index())
    write("search/index.html", build_search())
    write("playlist/index.html", build_playlist())
    write("updates/index.html", build_updates())
    write("history/index.html", build_history())
    write("contact/index.html", build_contact())
    write("sitemap.xml", build_sitemap())
    write("feed.xml", build_feed())
    write("404.html", build_404())
    write("robots.txt", "User-agent: *\nAllow: /\nSitemap: https://renedebos.com/sitemap.xml\n")
    n = 0
    for show in M["shows"]:
        out = (show["page"] or f"shows/{show['slug']}") + "/index.html"
        write(out, build_show(show))
        n += 1
    songs, _ = collect_songs()
    for s in songs:
        write(f"songs/{s['slug']}/index.html", build_song_page(s))
    total = sum(len(s["recordings"]) for s in M["shows"]) + len(M["singles"])
    print(f"Built 7 site pages + {n} show pages + {len(songs)} song pages ({total} recordings, "
          f"{sum(len(s['tracks'] or []) for s in M['shows'])} curated tracks)")


if __name__ == "__main__":
    main()
