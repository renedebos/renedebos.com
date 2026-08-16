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

import verify_markup  # noqa: E402  (needs the path insert above)

from sitegen.core import *       # noqa: F401,F403
from sitegen.fragments import *  # noqa: F401,F403
from sitegen.pages import *      # noqa: F401,F403
from sitegen.pages import CONTROLLER_ENGINE_EXCLUDED_SLUGS  # not in __all__ (internal to the escape hatch)
from sitegen.feeds import *      # noqa: F401,F403

def main():
    validate()
    check_orphan_song_dirs()
    check_rarity_drift()
    if "--check" in sys.argv[1:]:
        n_shows = len(M["shows"])
        n_tracks = sum(len(s["tracks"] or []) for s in M["shows"])
        print(f"integrity OK — {n_shows} shows, {n_tracks} curated tracks, no orphan song pages")
        return
    stamp_added_dates()
    here = os.path.dirname(os.path.abspath(__file__))
    write("assets/site.css", open(os.path.join(here, "site.css")).read())
    write("assets/player.js", open(os.path.join(here, "player.js")).read())
    # Shared PlaybackController — see plans/player-consolidation/. Loaded only
    # by the show pages in pages.CONTROLLER_ENGINE_SLUGS so far (Phase 1
    # Step 4); every other page still runs the legacy player.js.
    write("assets/player-controller.js", open(os.path.join(here, "player-controller.js")).read())
    write("assets/player-views.js", open(os.path.join(here, "player-views.js")).read())
    write("assets/player-boot.js", open(os.path.join(here, "player-boot.js")).read())
    write("assets/wavesurfer.esm.js", open(os.path.join(here, "vendor", "wavesurfer.esm.js")).read())
    # client-zip@2.4.5 (MIT) — assembles multiple fetch() Responses into a
    # streamed ZIP Response in the browser, no server-side buffering.
    write("assets/client-zip.js", open(os.path.join(here, "vendor", "client-zip.js")).read())
    write("assets/search.js", open(os.path.join(here, "search.js")).read())
    # /playlist/ views + boot on the shared PlaybackController (Phase 2;
    # legacy playlist.js deleted in Stage 2c) -- playlist-views.js is
    # separate from player-views.js/player-boot.js since it must never
    # import WaveSurfer (see its own header comment).
    write("assets/playlist-views.js", open(os.path.join(here, "playlist-views.js")).read())
    write("assets/playlist-boot.js", open(os.path.join(here, "playlist-boot.js")).read())
    # Song-page migration onto the shared controller (Phase 3 Stage
    # 3a-foundation) -- reuses player-views.js's CompactPlayerView, so no
    # separate song-views.js exists.
    write("assets/song-boot.js", open(os.path.join(here, "song-boot.js")).read())
    write("assets/miniplayer-state.js", open(os.path.join(here, "miniplayer-state.js")).read())
    write("assets/songs.js", open(os.path.join(here, "songs.js")).read())
    write("assets/track-select.js", open(os.path.join(here, "track-select.js")).read())
    write("assets/archive-data.js", open(os.path.join(here, "archive-data.js")).read())
    write("assets/continuous-player.js", open(os.path.join(here, "continuous-player.js")).read())
    write("assets/home.js", open(os.path.join(here, "home.js")).read())
    write("assets/feed.xsl", open(os.path.join(here, "feed.xsl")).read())
    write("assets/home.css", open(os.path.join(here, "home.css")).read())
    write("assets/fonts.css", open(os.path.join(here, "fonts.css")).read())
    write("assets/search-index.json", json.dumps(build_search_index(), ensure_ascii=False))
    write("assets/tracks.json", json.dumps(build_track_catalog(), ensure_ascii=False))
    write("assets/track-spec.json", json.dumps(build_track_spec_catalog(), ensure_ascii=False))
    write("assets/song-occurrences.json", json.dumps(build_song_occurrences(), ensure_ascii=False))
    write("assets/home-shows.json", json.dumps(build_home_shows(), ensure_ascii=False))
    write("assets/controller-excluded-slugs.json", json.dumps(sorted(CONTROLLER_ENGINE_EXCLUDED_SLUGS)))
    write("index.html", build_home())
    write("songs/index.html", build_songs_index())
    write("search/index.html", build_search())
    write("playlist/index.html", build_playlist())
    write("updates/index.html", build_updates())
    write("history/index.html", build_history())
    write("process/index.html", build_process())
    write("manual/index.html", build_manual())
    write("player/index.html", build_player())
    write("archive-data/index.html", build_archive_data())
    write("contact/index.html", build_contact())
    write("sitemap.xml", build_sitemap())
    write("feed.xml", build_feed())
    write("404.html", build_404())
    write("robots.txt", "User-agent: *\nAllow: /\nSitemap: https://renedebos.com/sitemap.xml\n")
    n = 0
    for show in M["shows"]:
        if show.get("hidden"):
            continue
        out = (show["page"] or f"shows/{show['slug']}") + "/index.html"
        write(out, build_show(show))
        n += 1
    songs, _ = collect_songs()
    for s in songs:
        write(f"songs/{s['slug']}/index.html", build_song_page(s))
    total = sum(len(s["recordings"]) for s in M["shows"]) + len(M["singles"])
    print(f"Built 7 site pages + {n} show pages + {len(songs)} song pages ({total} recordings, "
          f"{sum(len(s['tracks'] or []) for s in M['shows'])} curated tracks)")
    # Integrity of the *generated* player markup — validate() covers source data
    # but never reads the emitted data-item attributes. Cheap (a regex pass over
    # the show pages), so it runs on every full build rather than on demand.
    verify_markup.main()


if __name__ == "__main__":
    main()
