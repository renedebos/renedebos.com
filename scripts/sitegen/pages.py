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

def build_home():
    return page_shell(
        title="The Hannan Tapes",
        description="Live recordings archive — Jerry Hannan, Sean Hannan, and Mad Hannans performing at clubs in Marin and the Bay Area in the late 1990s and early 2000s.",
        url="https://renedebos.com",
        eyebrow="Live Recordings Archive",
        heading="The <em>Hannan</em><br>Recordings",
        tagline="Live performances &mdash; San Francisco Bay Area",
        nav=site_nav("Home"),
        main=about_block() + why_block() + featured_card() + artist_notes_block(),
        extra_head=home_jsonld(),
    )

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
    <div id="pl-filters" class="search-filters"></div>
    <div id="pl-length" class="search-filters"></div>
    <p id="pl-status" class="search-status">Loading the track catalog…</p>
    <p class="pl-actions"><button id="pl-generate" class="pl-generate" type="button" disabled>Generate playlist</button>
    <button id="pl-share" class="pl-generate pl-share" type="button" hidden>Copy share link</button></p>
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
                    f'<th class="g-song"><a href="/songs/{s["slug"]}/">{esc(s["canonical"])}</a>'
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
    <p class="track-hint">Each performance streams free (MP3). &ldquo;Open on show page&rdquo; jumps to the song within its full set.</p>
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


__all__ = ['WAVESURFER_LAB_SLUG', 'build_404', 'build_archive', 'build_contact', 'build_history', 'build_home', 'build_playlist', 'build_search', 'build_show', 'build_song_page', 'build_songs_index', 'build_updates', 'build_wavesurfer_lab']
