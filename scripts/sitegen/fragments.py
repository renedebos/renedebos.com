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

# Archive-box glyph for "download this as a ZIP" — distinct from the plain
# down-arrow DL_SVG used for single-file downloads, so a batch action reads
# differently from a per-track one at a glance.
ZIP_SVG = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
           'stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/>'
           '<rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>')

PLAY_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>'

PLUS_SVG = ('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" '
            'stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>')

def track_add_button(track_id):
    """The +/checkmark control that adds one track to the in-progress playlist
    selection (see scripts/track-select.js, PLAYLIST FEATURE.md Phase 5). Server
    always renders the unselected (+) state — selection is a client-only,
    per-page-load concept, so there's nothing to know at build time. JS toggles
    the class/aria-pressed/icon in place on click; keep this markup shape in
    sync with trackAddButtonHtml() in track-select.js."""
    return (f'<button type="button" class="track-add" data-id="{esc(track_id)}" '
            f'aria-pressed="false" aria-label="Add to playlist selection">{PLUS_SVG}</button>')

def playable_item_attr(*, item_id, kind, stream, title, artist=None, venue=None,
                       date=None, date_display=None, duration_label=None,
                       peaks_key=None, page_url=None, play_label=None,
                       lossless_file=None, lossless_size_mb=None, dropouts=False,
                       loud_stream=None):
    """Build the `data-item="..."` attribute the shared player reads.

    One normalized playable item per playable thing, serialized into the markup
    at build time so a show page with 30 tracks still costs zero network round
    trips to know what it can play (same convention as data-info tooltips and
    window.ZIP_MANIFEST). Consumed by itemFromRowElement() in
    scripts/player-views.js and validated by normalizeItem() in
    scripts/player-controller.js — keep the field names in sync with the schema
    documented in plans/player-consolidation/player-consolidation-plan.md.

    Returns the whole attribute (already HTML-escaped) rather than raw JSON, so
    no caller can forget to escape it. Pass RAW values: json.dumps handles JSON
    escaping and esc() handles HTML escaping, so pre-escaped input would be
    double-escaped and show up mangled in the player UI.
    """
    # The lossless original is reachable ONLY through the worker's /auth +
    # /download pair, so what a consumer needs is the R2 key, not a URL:
    # /stream deliberately 403s every .wav/.flac (worker/index.js), so
    # publishing a stream URL here would be publishing an address guaranteed to
    # fail. (The legacy download button's href looks like a stream URL but is
    # never fetched — player.js intercepts the click and reads the key out of
    # it.) Named `lossless`, not `flac`, because 64 of these are WAV.
    lossless = None
    if lossless_file:
        lossless = {"key": lossless_file,
                    "format": lossless_file.rsplit(".", 1)[-1].lower(),
                    "sizeMb": lossless_size_mb,
                    "title": lossless_file.split("/")[-1]}
    item = {
        "id": item_id,
        "kind": kind,
        "streamUrl": stream,
        # The -14 loud variant's URL, or None when this track has no variant
        # rendered. Emitted by the BUILD rather than derived in JS on purpose:
        # the build knows which variants actually exist, so a partial rollout
        # degrades to Archive for that track instead of 404-ing the player.
        "loudUrl": loud_stream or None,
        "title": title,
        "artist": artist or "",
        "venue": venue or None,
        "date": date or None,
        "dateDisplay": date_display or None,
        # Same helper feeds.py uses for tracks.json's durationSec, so the two
        # producers of this schema field can't drift apart.
        "durationSec": _duration_sec(duration_label) if duration_label else None,
        "durationLabel": duration_label or None,
        "peaksKey": peaks_key,
        "pageUrl": page_url or "",
        "playLabel": play_label or title,
        "downloads": {"lossless": lossless},
        "dropouts": bool(dropouts),
    }
    return f'data-item="{esc(json.dumps(item, ensure_ascii=False))}"'

def recording_item_id(show_slug, file):
    """Stable, unique id for a whole-show recording or alternate transfer.

    Needs to be unique *per card*: a player view decides whether it is the
    active one by comparing ids, so two cards sharing one would both render as
    playing at once.

    Keyed on the lossless original's R2 key, NOT the stream key: several shows
    offer two transfers of the same tape (e.g. mad-sweetwater-2000-10-17 has a
    WAV and a FLAC) that share a single MP3 stream proxy, so stream keys are
    not unique per card. The lossless key is the recording's real identity, and
    is stable across rebuilds.
    """
    return f"recording:{show_slug}:{file}"

def dl_button(file, *, title="Download", loud_file=None):
    # Icon-only (no text label): with only the password-protected lossless
    # download left, the format doesn't need spelling out in the button —
    # it's in the hover title, and the password modal makes the gating clear
    # on first click. `title` doubles as the accessible name.
    #
    # `loud_file` is the -14 variant's R2 key, when one exists for this track.
    # It rides as a data attribute rather than a second button because the
    # CHOICE belongs in the password modal (player.js reads it there) — one
    # control for every download surface, and the last moment before the
    # bytes move, so it cannot drift out of sync with what was clicked.
    # Absent on whole-show recordings, which have no -14 render at all; the
    # modal hides its version control when the attribute is missing rather
    # than offering a dead option.
    url = stream_url(file)
    name = file.split("/")[-1]
    loud = ""
    if loud_file:
        loud = (f' data-loud-file="{esc(loud_file)}" '
                f'data-loud-name="{esc(loud_file.split("/")[-1])}"')
    return (f'<a class="download-btn" href="{esc(url)}" aria-label="{esc(title)}" '
            f'download="{esc(name)}" title="{esc(title)}"{loud}>{DL_SVG}</a>')

def _loud_zip(manifest, tracks, slug, info_text):
    """The -14 counterpart of a ZIP manifest, or None.

    All-or-nothing: every file in the archive ZIP must have a rendered variant,
    or the loud option is withheld entirely. A ZIP that silently mixed loud and
    archive files would be indistinguishable from a correct one once unpacked,
    and no filename in it would say which track was which.

    Everything user-visible is renamed — the ZIP, the folder inside it, and the
    info file — so an unpacked loud ZIP cannot be mistaken for the master. The
    per-file names swap .flac for .mp3 for the same reason.
    """
    var = load_variant(slug)
    vt = (var or {}).get("tracks") or {}
    if not vt:
        return None
    by_flac = {t["flac"]: t for t in tracks if t.get("flac")}
    files = []
    for f in manifest["files"]:
        t = by_flac.get(f["key"])
        if not t or str(t["num"]) not in vt or not t.get("file"):
            return None
        files.append({"key": variant_key(t["file"]),
                      "name": f["name"].replace(f'{manifest["zipName"][:-4]}/',
                                                f'{manifest["zipName"][:-4]} (loud -14 LUFS)/', 1)
                                       .rsplit(".", 1)[0] + ".mp3"})
    folder = manifest["zipName"][:-4] + " (loud -14 LUFS)"
    return {
        "zipName": folder + ".zip",
        "files": files,
        "infoName": f"{folder}/show-info.txt",
        "infoText": info_text + LOUD_ZIP_NOTE,
    }

# Appended to a loud ZIP's info file. The download is the one place a visitor
# ends up holding audio with no page around it to say what it is, so the file
# has to carry its own provenance.
LOUD_ZIP_NOTE = (
    "\n-- This is the LOUD version --\n"
    "320 kbps MP3, normalized to -14 LUFS for comfortable listening on phone\n"
    "speakers and in a car. It is NOT the archive master: the masters are\n"
    "lossless FLAC at -20 LUFS, downloadable from the same button.\n"
    "https://renedebos.com/process/\n")


def show_zip_button_html(show):
    """Manifest + 'Download all tracks (.zip)' button for a show page. The ZIP
    itself is assembled client-side (player.js tryBatchDownload) from the same
    per-file /auth + /download flow a single download already uses — no new
    Worker route. show_zip_entries (core.py) is shared with the offline
    complete-archive snapshot script so the two naming schemes can't drift."""
    folder, entries = show_zip_entries(show)
    if not entries:
        return ""
    n = len(entries)
    total_mb = round(sum(t.get("flac_size_mb") or 0 for t in show["tracks"] if t.get("flac")))
    venue = show.get("venue") or show.get("venue_short") or "Unknown venue"
    setlist = "\n".join(f'{t["num"]:2d}. {t["title"]}' for t in show["tracks"])
    info = (f'{artist_name(show["artist"])}\n{venue}\n'
            f'{show.get("date_display") or show.get("date") or "Unknown date"}\n'
            f'{SOURCE_LABEL.get(show.get("source"), show.get("source") or "")}\n\n'
            f'Set list:\n{setlist}\n\nhttps://renedebos.com{show_url(show)}\n')
    manifest = {
        "zipName": f"{folder}.zip",
        "files": [{"key": e["key"], "name": e["name"]} for e in entries],
        "infoName": f"{folder}/show-info.txt",
        "infoText": info,
    }
    # Parallel -14 file list, when every track in the ZIP has a variant
    # rendered. All-or-nothing on purpose: a ZIP that silently mixed loud and
    # archive files would be indistinguishable from a correct one afterwards,
    # and nothing in the filename would say which track was which. The folder
    # and info file are renamed so an unpacked loud ZIP can never be mistaken
    # for the master.
    loud = _loud_zip(manifest, show.get("tracks") or [], show["slug"], info)
    if loud:
        manifest["loud"] = loud
    title = f"Download all {n} tracks (.zip) · {total_mb} MB"
    return (f'<script>window.ZIP_MANIFEST = {json.dumps(manifest, ensure_ascii=False)};</script>'
            f'<button type="button" class="zip-download-btn" title="{esc(title)}">{ZIP_SVG} Download ZIP</button>')

def player(file, duration=None, download_file=None, version=None, label=None, item_attr=""):
    """A custom-player row: play button, progress bar, and (optionally) a
    password-protected download button.

    Streams `file` (the lossy MP3 proxy). When `download_file` is given — the
    lossless original — the row offers its password-gated download; there are
    no free downloads, streaming is the only ungated path. `version`
    cache-busts the stream URL (pass a track's MD5) so a re-normalized upload
    goes live immediately. `label` (song/artist/date) becomes the play
    button's accessible name — otherwise a screen reader hears "Play" on
    every single instance with no way to tell them apart.

    `item_attr` is an already-built `data-item="..."` attribute (see
    playable_item_attr()) to place on the SAME element as `data-src` — the
    shape song-page occurrence rows need so song-boot.js's PlayerView
    can bind directly to this `.custom-player` div (mirroring how a
    waveform-less show-page track row carries both `data-src` and `data-item`
    on `.track-row.custom-player` itself, per build_show()). Default "" keeps
    recording_card()'s Hero cards — which carry their item on the OUTER
    `.recording-item`, not this inner player — byte-identical.
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
    item_html = f" {item_attr}" if item_attr else ""
    return f'''<div class="custom-player" data-src="{esc(stream)}"{item_html}>
          <button class="play-btn" aria-label="Play{play_label}"{play_data}>{PLAY_SVG}</button>
          <div class="progress-wrap">
            <input type="range" class="progress-range" min="0" max="1000" value="0" step="1" aria-label="{seek_label}" aria-valuetext="0:00{f' of {esc(duration)}' if duration else ''}">
            <div class="time-row"><span class="time-label current">0:00</span>{end_label}</div>
          </div>
          {downloads}
        </div>'''

def recording_card(title, meta_pairs, badge, file, stream_file=None, play_label=None,
                   show=None):
    # Stream the lossy proxy (stream_file) when one exists; the lossless `file`
    # is only reachable through the download/password flow.
    grid = "".join(f'<span class="meta-label">{esc(k)}</span><span class="meta-value">{esc(v)}</span>'
                   for k, v in meta_pairs if v)
    is_lossless = file.rsplit(".", 1)[-1].lower() in ("wav", "flac")
    play = player(stream_file or file,
                  download_file=file if is_lossless else None, label=play_label)
    # `show` is optional so the attribute is purely additive: callers that
    # don't pass it emit exactly the markup they did before. The attribute goes
    # on .recording-item (not the inner .custom-player) because that card is
    # what a HeroPlayerView mounts on — which also keeps player() itself, shared
    # with song pages, untouched this phase.
    item_attr = ""
    if show is not None:
        item_attr = " " + playable_item_attr(
            item_id=recording_item_id(show["slug"], file),
            kind="recording",
            stream=stream_url(stream_file or file),
            title=title,
            artist=artist_name(show["artist"]),
            venue=show.get("venue"),
            date=show.get("date"),
            date_display=date_with_subtitle(show),
            page_url=show_url(show),
            play_label=play_label or title,
            lossless_file=file if is_lossless else None,
        )
    return f'''      <div class="recording-item"{item_attr}>
        <div class="recording-meta">
          <div>
            <div class="recording-title">{esc(title)}</div>
            <div class="recording-meta-grid">{grid}</div>
          </div>
          <span class="recording-badge">{esc(badge)}</span>
        </div>
        {play}
      </div>'''

# ── playback-readiness contract (Phase 3 Stage 3a-foundation) ───────────────
# One signal every content page exposes for "this page's own playback boot
# has finished deciding what it's doing" -- a future sticky mini-player (not
# built yet this stage) needs to tell "adopt this page's controller" from
# "this page has nothing, restore my own session" from "a non-controller
# engine is active, stay dormant" apart, without racing a slow-but-healthy
# boot (a generic wall-clock timeout was tried and rejected across two plan
# review rounds -- see plans/dynamic-hugging-rossum.md's Round 3 section --
# because it can fire before a legitimately slower mount finishes and cause a
# second, competing controller to get constructed).
#
# Emitted as the FIRST script in the page, before any module/boot script tag,
# so window.PLAYBACK_HOST_READY exists before any boot module could possibly
# look for it. Two shapes:
#   'none'     -- resolved immediately, synchronously, right after arming the
#                 promise. For pages known at BUILD TIME to load no boot
#                 module (search/contact/updates/history/archive-data/404,
#                 the homepage) -- there is no timing question on these pages
#                 at all, so page_shell() defaults to this.
#   'deferred' -- armed but left unresolved; the page's own boot module
#                 resolves it later, after its real intent (deep-link/
#                 autoplay decision, hash hydration, mount failure) is known.
#                 Used by show pages, song pages, and /playlist/ -- see
#                 player-boot.js/song-boot.js/playlist-boot.js and this
#                 function's callers in pages.py.
# Resolves to a tagged union: {mode:'controller', controller, initialIntent}
# | {mode:'legacy'} | {mode:'none'}, where initialIntent is one of
# 'autoplay' | 'page-queue' | 'none'. See plans/dynamic-hugging-rossum.md's
# "Blocker A continued" section for the full per-page-type resolution timing
# and failure-path reasoning -- nothing consumes this promise yet this stage
# (the mini-player itself ships in a later stage), so this is pure,
# unconsumed infrastructure, verified only by its own shape.
PLAYBACK_READY_ARM = ("window.PLAYBACK_HOST_READY = new Promise(function(resolve){"
                      "window.__resolvePlaybackHost = resolve;});")
# module-script onerror handlers (a boot module 404s/fails to parse) share this
# guarded call so a page whose readiness promise was already settled some other
# way can't throw resolving it a second time -- resolve() itself is a no-op on
# an already-settled promise, but window.__resolvePlaybackHost might not exist
# at all if this snippet's own arming script somehow didn't run.
def playback_ready_onerror(mode):
    return f"window.__resolvePlaybackHost&amp;&amp;window.__resolvePlaybackHost({{mode:'{mode}'}})"

PLAYBACK_READY_SNIPPETS = {
    # Known at build time to load no boot module -- resolved immediately,
    # synchronously, right after arming. No timing question on these pages.
    "none": f"<script>{PLAYBACK_READY_ARM}window.__resolvePlaybackHost({{mode:'none'}});</script>\n",
    # Known at build time to run ONLY the synchronous legacy engine (a show
    # page whose slug is in CONTROLLER_ENGINE_EXCLUDED_SLUGS, so no boot
    # module is emitted at all -- player.js's own top-level `else` branch is
    # the only engine that will ever run here, and it runs synchronously at
    # parse time). Deterministic at build time the same way "none" is, just a
    # different known outcome -- not a runtime signal from player.js itself.
    "legacy": f"<script>{PLAYBACK_READY_ARM}window.__resolvePlaybackHost({{mode:'legacy'}});</script>\n",
    # Armed but left unresolved -- the page's own boot module (player-boot.js,
    # song-boot.js, playlist-boot.js) resolves it later, once its real intent
    # is known. See each module's own resolution-call comments.
    "deferred": f"<script>{PLAYBACK_READY_ARM}</script>\n",
}

def page_shell(*, title, description, url, heading, tagline, nav, main, extra_scripts="",
               extra_head="", pre_scripts="", playback_ready="none"):
    """`pre_scripts` is injected immediately BEFORE player.js.

    Only one thing needs that slot today: the shared-player engine flag
    (window.PLAYER_ENGINE), which has to exist before player.js runs — player.js
    decides at parse time whether to register its playback handlers, so a flag
    set anywhere later could never win. Default "" keeps every other page's
    output byte-identical.

    `playback_ready` selects which PLAYBACK_READY_SNIPPETS entry to emit as
    the page's very first script — see that dict's comment for the contract.
    Default "none" (resolved immediately) keeps every page that doesn't pass
    "deferred" byte-identical apart from this one addition.

    No `eyebrow`: the site name used to print above every <h1> on all 174
    shared-shell pages, where the header mark, the footer and the <title>
    already carry it (page-cleanup rows C1/C2 — see
    plans/page-cleanup/page-cleanup-plan.md). `tagline` is now optional for
    the same reason: a song page's said the same thing as the line below its
    own heading, so passing "" omits the element rather than emitting an
    empty <p>.
    """
    if playback_ready not in PLAYBACK_READY_SNIPPETS:
        raise ValueError(f"page_shell: unknown playback_ready={playback_ready!r}")
    tagline_html = f'\n    <p class="site-tagline">{tagline}</p>' if tagline else ""
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
{PLAYBACK_READY_SNIPPETS[playback_ready]}<meta charset="UTF-8">
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
  <div class="wrap">
    <a class="mark" href="/" aria-label="Shows &mdash; The Hannan Tapes home">Shows</a>
    <nav>
{nav}
    </nav>
  </div>
</header>

<div class="page-title">
  <div class="wrap">
    <h1>{heading}</h1>{tagline_html}
  </div>
</div>

<main id="main">
{main}
</main>

<footer>
  <span class="footer-links">
    <a href="/history/">The Story So Far</a> &middot;
    <a href="/process/">The Process</a> &middot;
    <a href="/contact/">Contact</a> &middot;
    <a href="/feed.xml">RSS</a>
  </span>
</footer>

{pre_scripts}<script src="/assets/player.js"></script>{extra_scripts}
</body>
</html>
'''

SITE_PAGES = [
    ("Home", "/"),
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

def _eq_badge(proc):
    """Corrective-EQ badge for a show whose processing chain applies a
    literal --eq filter before loudnorm (e.g. a muddy tape restored with
    mud-cut/presence-lift EQ) — distinct from the pre_edits-driven pre-edited/
    noise-reduced badges, since the EQ is an engine-applied filter, not
    documented hand-edit provenance. Hover shows the literal filter chain."""
    filters = proc.get("filters")
    if not filters or filters == "none":
        return ""
    return (f' <span class="proc-status pre-edit eq-badge" '
            f'title="{esc(filters)}">corrective-eq</span>')

HIGHLIGHT_STAR_SVG = ('<svg width="12" height="12" viewBox="0 0 12 12">'
                      '<path d="M6 0l1.8 3.8L12 4.4l-3 3 .8 4.4L6 9.8 2.2 11.8 3 7.4 0 4.4l4.2-.6z" '
                      'fill="currentColor"/></svg>')

def highlight_badge(show):
    """Rene's editorial flag for a standout performance — independent of
    recording quality (the pre-edit/NR/PE badges), so a rough tape can still
    be a highlight and vice versa."""
    if not show.get("highlight"):
        return ""
    return (f' <span class="h-badge" title="A particularly good performance">'
            f'{HIGHLIGHT_STAR_SVG}</span>')

def status_line(show):
    """The show page's hand-work pills: "noise-reduced" / "pre-edited", plus
    the corrective-EQ badge. Same source of truth as the tech-table badge and
    the archive-row pill (the sidecar's `pre_edits`).

    This used to lead with an "Audio processing · <status>" badge and a
    one-sentence blurb, both read from `processing_status`. Both were cut in
    the page-cleanup pass (rows A1/A2): every generated show page said `done`,
    so the badge was decoration that looked like data, and the blurb repeated
    what the technical-data table's head and /process/ already say properly.
    The status badge still renders on the tech-table summary, where it sits
    beside the numbers it describes.

    The pills that remain genuinely vary — 8 of 30 shows carry one — which is
    why they stay page-level rather than folding into the collapsed table.
    Returns "" for the 22 shows with neither, so no empty line is emitted.
    """
    proc = load_processing(show["slug"])
    if not proc:
        return ""
    pills = ""
    if proc.get("pre_edits"):
        label = _pre_edit_label(proc["pre_edits"])
        pills = (f'<span class="proc-status pre-edit {_pre_edit_class(label)}" '
                 f'title="{esc(proc["pre_edits"])}">{label}</span>')
    pills += _eq_badge(proc)
    if not pills:
        return ""
    return f'\n  <p class="proc-status-line">{pills}</p>'

def _render_summary(pt):
    """Derive, from each track's own recorded filter chain (never from a single
    blanket label), how loudness was actually rendered. v6+ tracks apply gain
    with a plain `volume` filter — loudnorm/ebur128 only measured it; pre-v6
    tracks had loudnorm itself render (its linear=true mode, so still a single
    constant gain, just a different tool). A show can mix both if only some
    tracks were reprocessed, so this counts per track rather than trusting the
    sidecar's own last-run-only workflow_version."""
    fixed_gain = sum(1 for d in pt.values() if d.get("chain") and "volume=" in d["chain"])
    loudnorm_render = sum(1 for d in pt.values()
                           if d.get("chain") and "loudnorm=" in d["chain"] and "volume=" not in d["chain"])
    if fixed_gain and not loudnorm_render:
        return "fixed-gain (loudnorm/ebur128 measured; ffmpeg volume filter rendered)"
    if loudnorm_render and not fixed_gain:
        return "ffmpeg loudnorm (linear mode, one constant gain)"
    if fixed_gain and loudnorm_render:
        return (f"mixed rendering — {fixed_gain} track(s) fixed-gain volume filter, "
                f"{loudnorm_render} track(s) ffmpeg loudnorm (older workflow)")
    return ""

def _variant_scope_note(var):
    """The scope line for the technical table: every figure in it describes the
    -20 archive, which since 2026-08-18 is NOT what the player streams by
    default. The table was written when there was only one render, so an
    unqualified "Target: -20 LUFS" now reads as a claim about what the visitor
    is hearing. One sentence fixes that, plus the variant's own headline
    numbers so the cost is stated where the measurements are, not only on
    /process/.

    Deliberately measured-not-asserted: the LRA spread is computed from this
    show's own variant sidecar rather than quoting the archive-wide median."""
    if not var:
        return ""
    vt = var.get("tracks", {})
    if not vt:
        return ""
    capped = sum(1 for d in vt.values() if d.get("mode") == "sparse-transient-cap")
    target = abs(var.get("target_lufs", -14))
    bits = [f'Loud variant: &minus;{target}&nbsp;LUFS, MP3 only, '
            f'derived from these same archive files']
    if capped:
        bits.append(f'{capped} of {len(vt)} '
                    f'{"tracks" if capped != 1 else "track"} transient-capped')
    return (f'<p class="tech-head tech-scope"><strong>These figures describe the '
            f'archive master</strong> &mdash; the &minus;20&nbsp;LUFS files you download. '
            f'The player streams the louder version by default; switch to '
            f'<strong>Archive</strong> above to hear what is measured here. '
            f'{" &middot; ".join(bits)} &middot; '
            f'<a href="/archive-data/">per-track variant data</a>.</p>')


def tech_data_section(show, proc, var=None):
    """Render a collapsible "Technical data" table for a processed show: every
    track's duration + sizes (from recordings.json) merged with its input/achieved
    loudness, true peak, LRA, and gain applied (from the processing provenance,
    where measured). The per-track audio MD5 is carried in the sidecar for
    integrity/drift checks but is not displayed.

    `var` is the show's loudness-variant sidecar, used only for the scope note
    above the table -- its numbers are never mixed into the table's own columns,
    which describe the archive and nothing else."""
    pt = proc.get("tracks", {})
    tcap_n = sum(1 for d in pt.values() if d.get("mode") == "sparse-transient-cap")
    limiter_n = sum(1 for d in pt.values() if d.get("mode") == "applause-limiter")
    head_bits = [f'Target: {proc["target_lufs"]} LUFS &middot; '
                 f'{proc["tp_ceiling"]} dBTP true-peak ceiling']
    render = _render_summary(pt)
    if render:
        head_bits.append(render)
    if tcap_n:
        head_bits.append(f'{tcap_n} track(s) transient-capped')
    if limiter_n:
        head_bits.append(f'{limiter_n} track(s) applause-limited')
    if proc.get("source"):
        head_bits.append(f'Source: {esc(proc["source"])}')
    if proc.get("pre_edits"):
        head_bits.append(f'Pre-edits: {esc(proc["pre_edits"])}')
    if proc.get("filters") and proc["filters"] != "none":
        head_bits.append(f'Filters: {esc(proc["filters"])}')
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
    badge += _eq_badge(proc)
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
        # treatment audit trail (workflow v5+): which normalization mode the
        # track got, with the recorded decision note on hover. Pre-v5 tracks
        # show a dash — their sidecars predate the mode record, so claiming
        # "linear" for them would be dishonest (some were silently dynamic).
        mode = d.get("mode")
        label = {"linear": "linear", "linear-reduced": "linear&nbsp;&darr;",
                 "applause-limiter": "applause&#8209;limited",
                 "sparse-transient-cap": "transient&#8209;capped"}.get(mode)
        if label:
            note = d.get("note", "")
            flagged = " treat-review" if "[review:" in note else ""
            treat = (f'<span class="treat treat-{esc(mode)}{flagged}" '
                     f'title="{esc(note)}">{label}</span>' if note
                     else f'<span class="treat treat-{esc(mode)}">{label}</span>')
        else:
            treat = "&mdash;"
        mp3 = f'{t["size_mb"]} MB' if t.get("size_mb") else "&mdash;"
        flac = f'{t["flac_size_mb"]} MB' if t.get("flac_size_mb") else "&mdash;"
        rows.append(
            f'        <tr><td class="tnum">{t["num"]:02d}</td><td>{esc(t["title"])}</td>'
            f'<td class="tnum">{esc(t["duration"])}</td><td class="tnum">{mp3}</td>'
            f'<td class="tnum">{flac}</td><td class="tnum">{inl}</td>'
            f'<td class="tnum">{out}</td><td class="tnum">{gain}</td>'
            f'<td class="tnum">{tp}</td><td class="tnum">{lra}</td>'
            f'<td class="ttreat">{treat}</td><td class="tver">{ver}</td></tr>')
    return f'''
  <section>
    <details class="tech-details" id="technical-data">
      <summary>Technical data &mdash; loudness, peaks &amp; sizes{badge}</summary>
      <p class="tech-head">{head}</p>{_variant_scope_note(var)}
      <div class="tech-scroll">
      <table class="tech-table">
        <thead><tr><th>#</th><th>Song</th><th>Time</th><th>MP3</th><th>FLAC</th>
          <th>In&nbsp;LUFS</th><th>Out&nbsp;LUFS</th><th>Gain</th>
          <th>True&nbsp;Pk</th><th>LRA</th><th>Treatment</th><th>Ver</th></tr></thead>
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
    anchor = f'{esc(o["url"])}#track-{o["num"]}'
    track_id = f'{o["slug"]}-{o["num"]:02d}'
    # song-boot.js reads this the same way player-boot.js reads a show-page
    # track row's data-item -- see playable_item_attr()'s own docstring for the
    # schema. peaks_key is omitted (None): occurrence rows stream the MP3
    # proxy and have no waveform, matching songs.js's occRowHtml() (the
    # lazily-rendered index-page counterpart to this server-rendered row) --
    # keep the two builders in sync if this schema changes.
    item_attr = playable_item_attr(
        item_id=track_id,
        kind="track",
        stream=stream_url(o["file"], o["ver"]),
        title=song_title,
        artist=o["artist_name"],
        venue=o["venue"],
        date=o["date"],
        date_display=o["date"],
        duration_label=o.get("duration"),
        peaks_key=None,
        page_url=anchor,
        play_label=label,
        lossless_file=o.get("flac"),
        lossless_size_mb=o.get("flac_size_mb"),
        dropouts=False,
        # -14 render, only where one exists for that track. `data-src` on the
        # row below stays the ARCHIVE url on purpose: it is what the legacy
        # fallback engine reads, so a page whose module never mounts degrades
        # to the master rather than to a key that might not be there.
        loud_stream=(stream_url(o["loud"], o.get("loud_ver")) if o.get("loud") else None),
    )
    p = player(o["file"], duration=o.get("duration"), version=o["ver"], label=label, item_attr=item_attr)
    add_btn = track_add_button(track_id)
    sizes = []
    if o.get("flac_size_mb"):
        sizes.append(f'FLAC {o["flac_size_mb"]} MB')
    if o.get("size_mb"):
        sizes.append(f'MP3 {o["size_mb"]} MB')
    info_rows = [
        ["Title", song_title],
        ["Venue", o["venue"]],
        ["Date", o["date"]],
        ["Source", SOURCE_LABEL.get(o.get("source"), o.get("source") or "—")],
        ["Duration", o.get("duration") or "—"],
        ["Size", " · ".join(sizes) or "—"],
        ["Process version", f'v{o["proc_ver"]}' if o.get("proc_ver") else "Not yet processed"],
    ]
    info = esc(json.dumps(info_rows, ensure_ascii=False))
    return f'''<div class="song-occ">
        <div class="song-occ-head">
          <a class="artist-chip artist-{o['artist']}" href="{anchor}">{esc(o['artist_name'])}</a>
          <span class="song-occ-where" data-info="{info}">{esc(o['venue'])} &middot; {esc(o['date'])}</span>
          <a class="song-occ-open" href="{anchor}">open on show page &rarr;</a>
          {add_btn}
        </div>
        {p}
      </div>'''

def song_zip_button_html(s):
    """Manifest + 'Download all performances (.zip)' button for a song page —
    every recorded take of one song across the whole archive, assembled
    client-side the same way show_zip_button_html does (see player.js
    tryBatchDownload)."""
    zip_occ = [o for o in s["occ"] if o.get("flac")]
    if not zip_occ:
        return ""
    n = len(zip_occ)
    total_mb = round(sum(o.get("flac_size_mb") or 0 for o in zip_occ))
    folder = sanitize_filename(f'{s["canonical"]} - Live Performances')
    files = [{"key": o["flac"],
              "name": f'{folder}/{sanitize_filename(o["date"])} - {sanitize_filename(o["artist_name"])} '
                      f'- {sanitize_filename(o["venue"])} - {o["num"]:02d}.flac'}
             for o in zip_occ]
    lines = "\n".join(f'{o["date"]} - {o["artist_name"]} - {o["venue"]}' for o in zip_occ)
    plural = "s" if n != 1 else ""
    info = (f'{s["canonical"]}\n{n} live performance{plural}\n\n{lines}\n\n'
            f'https://renedebos.com/songs/{s["slug"]}/\n')
    manifest = {
        "zipName": f"{folder}.zip",
        "files": files,
        "infoName": f"{folder}/collection-info.txt",
        "infoText": info,
    }
    # -14 counterpart, offered only when every performance in the ZIP has one
    # rendered — same all-or-nothing rule as the show ZIP, for the same reason
    # (a silently mixed archive is indistinguishable from a correct one once
    # unpacked). Built from the occurrence list rather than _loud_zip(), whose
    # filenames are keyed on a single show's track numbers.
    if all(o.get("loud") for o in zip_occ):
        lfolder = f"{folder} (loud -14 LUFS)"
        manifest["loud"] = {
            "zipName": f"{lfolder}.zip",
            "files": [{"key": o["loud"],
                       "name": f'{lfolder}/{sanitize_filename(o["date"])} - '
                               f'{sanitize_filename(o["artist_name"])} - '
                               f'{sanitize_filename(o["venue"])} - {o["num"]:02d}.mp3'}
                      for o in zip_occ],
            "infoName": f"{lfolder}/collection-info.txt",
            "infoText": info + LOUD_ZIP_NOTE,
        }
    title = f"Download all {n} performance{plural} (.zip) · {total_mb} MB"
    return (f'<script>window.ZIP_MANIFEST = {json.dumps(manifest, ensure_ascii=False)};</script>'
            f'<button type="button" class="zip-download-btn" title="{esc(title)}">{ZIP_SVG} Download ZIP</button>')

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


__all__ = ['DL_SVG', 'EXTRA_PAGES', 'HIGHLIGHT_STAR_SVG', 'PLAYBACK_READY_ARM', 'PLAYBACK_READY_SNIPPETS', 'PLAY_SVG', 'PLUS_SVG', 'SITE_PAGES', '_pre_edit_class', '_pre_edit_label', '_show_label', '_song_occ_html', '_src_tag', 'contact_block', 'content', 'dl_button', 'highlight_badge', 'home_jsonld', 'jsonld', 'md_to_html', 'page_shell', 'playable_item_attr', 'playback_ready_onerror', 'player', 'recording_card', 'recording_item_id', 'show_jsonld', 'show_zip_button_html', 'site_nav', 'song_jsonld', 'song_zip_button_html', 'status_line', 'tech_data_section', 'track_add_button', 'updates_list', 'variant_toggle']


def variant_toggle(any_loud=True):
    """The Archive/Loud playback control plus its plain-language note.

    Rene's decision 2026-08-18: **Loud is the default**, because -20 LUFS is too
    quiet in a car or on phone speakers. That makes the note mandatory, not
    decorative — a visitor who does nothing is hearing the -14 render, and the
    page has to say so in words rather than leaving them to infer it from a
    highlighted button. The archive stays the master and the download.

    Real <button>s with aria-pressed (not styled spans), so the current value is
    in the accessible name and state — the mockup review called this out
    specifically. Rendered only when the page actually has variants to offer.
    """
    if not any_loud:
        return ""
    return '''
    <div class="variant-pick" data-variant-pick>
      <span class="variant-label" id="variant-label">Playback</span>
      <div class="variant-btns" role="group" aria-labelledby="variant-label">
        <button type="button" class="variant-btn" data-variant="archive" aria-pressed="false">Archive</button>
        <button type="button" class="variant-btn" data-variant="loud" aria-pressed="true">Loud</button>
      </div>
      <p class="variant-note" data-variant-note>
        <strong>You are hearing the Loud version</strong> &mdash; an extra render at
        &minus;14&nbsp;LUFS, about as loud as a streaming service, so it isn\u2019t too quiet
        on phone speakers or in a car. Switch to <strong>Archive</strong> for the
        &minus;20&nbsp;LUFS masters exactly as they were mastered. Downloads default to
        the Archive master &mdash; lossless FLAC &mdash; and the download box offers this
        louder MP3 as an alternative. <a href="/process/">How these were made</a>.
      </p>
    </div>'''
