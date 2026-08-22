#!/usr/bin/env python3
"""Verify the data-item markup in the generated show and song pages.

Guards the player-consolidation work (plans/player-consolidation/,
plans/dynamic-hugging-rossum.md): every playable thing on a show page or a
song detail page carries a normalized item as a data-item JSON attribute,
which the shared player reads instead of fetching a catalog. That markup is
generated, so nothing in build.py --check (which validates *source* data)
looks at it. (The /songs/ INDEX page's occurrence rows are inserted lazily
by songs.js and never appear in the static HTML at all -- only their engine
wiring is checkable here; the row markup itself is covered by
scripts/test-song-boot.mjs.)

These assertions are not hypothetical: the one-off version of this check caught
a real recording-ID collision on mad-sweetwater-2000-10-17, where a WAV and a
FLAC transfer of the same tape share one MP3 stream proxy and so produced two
cards claiming the same id.

Run after a build:
  python3 scripts/build.py && python3 scripts/verify_markup.py
"""
import glob
import html
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITEM_RE = re.compile(r'data-item="([^"]*)"')
# A track row carries data-src and data-item on the same element; a recording
# card carries data-item on .recording-item with data-src on the inner player.
ROW_RE = re.compile(r'<div class="track-row[^"]*"[^>]*data-src="([^"]*)"[^>]*data-item="([^"]*)"')
CARD_RE = re.compile(r'<div class="recording-item" data-item="([^"]*)">.*?<div class="custom-player" data-src="([^"]*)"', re.S)

REQUIRED = ("id", "kind", "streamUrl", "title", "playLabel")

# Share-a-song links (plans/share/track-share-plan.md): every curated track
# item carries shareUrl = https://renedebos.com/t/{code}; the build writes the
# code -> deep-link map the Worker resolves. Checked both ways below: the
# item's code must be in the map, and the map's target must be the item's own
# pageUrl (plus the autoplay flag) -- a stale map would otherwise send a
# shared link to whatever track last owned that code.
# Trailing slash required: it is the canonical form the asset server serves
# in one hop (see track_share_url()). A slash-less URL still works -- the
# Worker 301s it -- but the build must never HAND OUT the bouncing form.
SHARE_RE = re.compile(r'^https://renedebos\.com/t/([a-f0-9]{5,64})/$')

def load_track_links():
    path = os.path.join(ROOT, "assets", "track-links.json")
    try:
        return json.load(open(path))
    except Exception:
        return None

def check_share_link(rel, item, links):
    """Errors for one kind=track item's shareUrl against the built map."""
    share = item.get("shareUrl")
    if not share:
        return [f"{rel}: track {item.get('id')!r} has no shareUrl"]
    m = SHARE_RE.match(str(share))
    if not m:
        return [f"{rel}: track {item.get('id')!r} shareUrl {share!r} is not https://renedebos.com/t/<code>/"]
    if links is None:
        return [f"{rel}: assets/track-links.json missing or unreadable -- run scripts/build.py first"]
    target = links.get(m.group(1))
    if target is None:
        return [f"{rel}: track {item.get('id')!r} share code {m.group(1)!r} is not in assets/track-links.json"]
    expected = str(item.get("pageUrl") or "").replace("#", "?autoplay=1#", 1)
    if target != expected:
        return [f"{rel}: share code {m.group(1)!r} resolves to {target!r}, expected {expected!r}"]
    return []


ENGINE_FLAG = "window.PLAYER_ENGINE = 'controller'"
# A tag PREFIX, not the whole tag: both player-boot.js's and song-boot.js's
# script tags carry an onerror="..." attribute (the readiness-contract
# module-load-failure signal — see PLAYBACK_READY_SNIPPETS' own comment in
# fragments.py), so the exact closing `></script>` no longer matches. `in src`
# / `src.index(...)` both work identically against a prefix.
BOOT_TAG = '<script type="module" src="/assets/player-boot.js"'
PLAYER_TAG = '<script src="/assets/player.js"></script>'
# ── song-page engine wiring (Phase 3 Stage 3a-foundation) ──────────────────
SONG_ENGINE_FLAG = ENGINE_FLAG  # the exact same flag show pages use — see SONG_ENGINE_FLAG's own comment in sitegen/pages.py
SONG_BOOT_TAG = '<script type="module" src="/assets/song-boot.js"'
# Occurrence rows on a song DETAIL page (/songs/<slug>/, server-rendered, not
# lazy) carry data-item on the SAME element as data-src (player()'s item_attr
# param) — the non-waveform show-page track-row shape, not the Hero-card
# shape (CARD_RE below), since song occurrence rows never have a waveform.
SONG_OCC_RE = re.compile(r'<div class="track-row custom-player song-occ" data-src="([^"]*)" data-item="([^"]*)"')


def check_engine_wiring(rel, src, slug, allowlist):
    """The three halves of the engine handshake have to agree.

    Getting any of them wrong is silent at build time and only shows up as a
    double-initialized or dead player in a browser, so assert them here:
    the flag and the boot module always travel together; only allowlisted shows
    carry them; the flag precedes player.js (a flag set after it can never win,
    since player.js decides at parse time); and the legacy scripts stay on the
    page, because they are the runtime fallback if the module never mounts.
    """
    errors = []
    has_flag = ENGINE_FLAG in src
    has_boot = BOOT_TAG in src
    want = slug in allowlist

    if has_flag != has_boot:
        errors.append(f"{rel}: engine flag and player-boot.js must be emitted together "
                      f"(flag={has_flag}, boot={has_boot})")
    if want and not has_flag:
        errors.append(f"{rel}: {slug!r} is in CONTROLLER_ENGINE_SLUGS but emits no engine flag")
    if not want and has_flag:
        errors.append(f"{rel}: {slug!r} emits the engine flag but is not in CONTROLLER_ENGINE_SLUGS")
    if has_flag:
        if PLAYER_TAG not in src:
            errors.append(f"{rel}: engine flag set but player.js is missing — "
                          "the legacy engine is the runtime fallback and must stay on the page")
        elif src.index(ENGINE_FLAG) > src.index(PLAYER_TAG):
            errors.append(f"{rel}: engine flag must come BEFORE player.js")
        if has_boot and src.index(BOOT_TAG) < src.index(PLAYER_TAG):
            errors.append(f"{rel}: player-boot.js must load after player.js")
    return errors


def check_song_engine_wiring(rel, src):
    """The song-page analogue of check_engine_wiring() -- simpler, since
    Stage 3a-foundation made song-boot.js unconditional on every song page
    from the start (no per-page allowlist the way show pages' rollout
    needed -- see SONG_ENGINE_FLAG's own comment in sitegen/pages.py): both
    the flag and the boot tag must always be present together, the flag must
    precede player.js, and song-boot.js must load after it (same three-part
    handshake player-boot.js uses, just always-on rather than allowlisted).
    """
    errors = []
    has_flag = SONG_ENGINE_FLAG in src
    has_boot = SONG_BOOT_TAG in src
    if has_flag != has_boot:
        errors.append(f"{rel}: song engine flag and song-boot.js must be emitted together "
                      f"(flag={has_flag}, boot={has_boot})")
    if not has_flag:
        errors.append(f"{rel}: song page emits no engine flag -- song-boot.js is unconditional as of Stage 3a-foundation")
        return errors
    if PLAYER_TAG not in src:
        errors.append(f"{rel}: song engine flag set but player.js is missing — "
                      "initCustomPlayers() is the runtime fallback and must stay on the page")
    elif src.index(SONG_ENGINE_FLAG) > src.index(PLAYER_TAG):
        errors.append(f"{rel}: song engine flag must come BEFORE player.js")
    if has_boot and src.index(SONG_BOOT_TAG) < src.index(PLAYER_TAG):
        errors.append(f"{rel}: song-boot.js must load after player.js")
    return errors


# A tag PREFIX, not the whole tag -- see BOOT_TAG's own comment: the real
# tag now carries an onerror="..." attribute (the readiness-contract
# module-load-failure signal), so the exact closing `></script>` no longer
# matches. `.count()` against the prefix still counts one match per distinct
# tag correctly.
PLAYLIST_BOOT_TAG = '<script type="module" src="/assets/playlist-boot.js"'
PLAYLIST_TAG = '<script src="/assets/playlist.js"></script>'
# The old Stage 2a/2b resolver set this property somewhere in an inline
# <script> before playlist-boot.js -- if any of these three fragments still
# show up in the page source, some part of the deleted engine-selection
# dance survived Stage 2c's cleanup (a stray inline snippet, a leftover
# `?engine=` reference in a comment-adjacent string, etc.).
PLAYLIST_ENGINE_LEFTOVER_SNIPPETS = ("PLAYLIST_ENGINE", "window.PLAYLIST_ENGINE", "?engine=")
WORKER_ORIGIN_SNIPPET = "window.WORKER_ORIGIN="


def check_playlist_engine_wiring(src):
    """The /playlist/ analogue of check_engine_wiring() above -- much
    simpler than that function since Stage 2c (2026-08-14) deleted the
    legacy playlist.js engine and its `?engine=`/PLAYLIST_ENGINE resolver:
    there is now exactly one engine and no runtime selection to verify.

    Invariants:
      (1) playlist-boot.js -- the only engine now -- must be on the page,
          and EXACTLY once (a duplicate script tag would double-mount the
          controller -- playlist-boot.js's own MOUNTED_FLAG guard covers a
          same-content double-execution at runtime, but a build regression
          that emits the tag twice is still worth catching here at the
          source-text level, before it ever reaches a browser).
      (2) legacy playlist.js must NOT be referenced -- a leftover reference
          would mean Stage 2c's deletion was reverted or incomplete.
      (3) no leftover `?engine=`/PLAYLIST_ENGINE resolver wiring anywhere in
          the page source -- Stage 2c deleted that mechanism entirely, so
          any trace of it left behind is stale, not just unused.
      (4) window.WORKER_ORIGIN must still be set -- unrelated to engine
          selection (it's how playlist-boot.js, a module script, reads
          player.js's WORKER constant -- see build_playlist()'s comment),
          but it was previously emitted only inside the resolver script, so
          the resolver's removal is exactly the kind of edit that could have
          silently dropped it too.
    (check_assets_exist() below separately catches playlist-boot.js's tag
    going stale in the *other* direction -- referencing an asset build.py no
    longer writes -- so this only needs to check presence/absence/count.)
    """
    errors = []
    boot_count = src.count(PLAYLIST_BOOT_TAG)
    if boot_count == 0:
        errors.append("/playlist/: playlist-boot.js is missing -- it's the only playback engine now")
    elif boot_count > 1:
        errors.append(f"/playlist/: playlist-boot.js's script tag appears {boot_count} times -- expected exactly 1")
    if PLAYLIST_TAG in src:
        errors.append("/playlist/: legacy playlist.js is still referenced -- "
                      "it was deleted in Stage 2c, this is stale wiring")
    for snippet in PLAYLIST_ENGINE_LEFTOVER_SNIPPETS:
        if snippet in src:
            errors.append(f"/playlist/: found leftover engine-resolver wiring ({snippet!r}) -- "
                          "the `?engine=`/PLAYLIST_ENGINE dance was deleted in Stage 2c")
    if WORKER_ORIGIN_SNIPPET not in src:
        errors.append("/playlist/: window.WORKER_ORIGIN is not set -- "
                      "playlist-boot.js/playlist-views.js need it to reach the download worker")
    return errors


PLAYBACK_READY_MARKER = "window.PLAYBACK_HOST_READY = new Promise"


def check_playback_ready_first(rel, src):
    """Every page_shell()-based page must arm window.PLAYBACK_HOST_READY as
    the very FIRST script in the page -- before any module/boot script tag
    (plans/dynamic-hugging-rossum.md's readiness contract). A boot module
    that runs before the promise even exists could never resolve it, so
    ordering here is load-bearing, not cosmetic.
    """
    errors = []
    idx = src.find(PLAYBACK_READY_MARKER)
    if idx == -1:
        errors.append(f"{rel}: missing window.PLAYBACK_HOST_READY -- every page_shell()-based "
                      "page must arm the readiness contract")
        return errors
    # The marker text sits INSIDE its own <script> tag, so the naive "does
    # <script> appear before the marker" check would always be true (it finds
    # its own opening tag) -- rfind the tag that actually contains the marker,
    # then confirm THAT tag, not the marker text itself, is the page's first.
    own_tag_start = src.rfind("<script", 0, idx)
    if own_tag_start == -1:
        errors.append(f"{rel}: window.PLAYBACK_HOST_READY text found outside any <script> tag")
        return errors
    first_script = src.find("<script")
    if first_script != own_tag_start:
        errors.append(f"{rel}: window.PLAYBACK_HOST_READY must be armed by the FIRST script "
                      "tag in the page, not a later one")
    return errors


TRACK_ROW_TAG_RE = re.compile(r'<div class="track-row[^"]*"[^>]*>')
RECORDING_ITEM_TAG_RE = re.compile(r'<div class="recording-item"[^>]*>')
ID_ATTR_RE = re.compile(r'\bid="([^"]*)"')


def check_every_row_has_item(rel, src):
    """Every .track-row and .recording-item element must carry a valid
    data-item — not just validate whichever data-item attributes happen to be
    present in the page (Step 4 review finding #2).

    ITEM_RE below only sees attributes that exist; it can't notice one that's
    missing. A build regression that dropped playable_item_attr() from one row
    would pass every check that only validates found attributes: the row is
    invisible to ITEM_RE (nothing to parse), invisible to player-boot.js's
    ROW_SELECTOR (nothing to mount), and on an allowlisted page gets neither
    the new engine (suppressed by the flag) nor the legacy one (also
    suppressed) — a silently dead row. This enumerates the ELEMENTS
    independently of the attribute, so a missing one is a build failure
    instead of an invisible gap.
    """
    errors = []
    for tag in TRACK_ROW_TAG_RE.findall(src):
        if 'data-item="' not in tag:
            m = ID_ATTR_RE.search(tag)
            ident = m.group(1) if m else "<no id>"
            errors.append(f"{rel}: track row {ident!r} has no data-item attribute")
    for tag in RECORDING_ITEM_TAG_RE.findall(src):
        if 'data-item="' not in tag:
            errors.append(f"{rel}: a .recording-item element has no data-item attribute")
    return errors


SRC_RE = re.compile(r'src="(/assets/[^"]+)"')
# Covers every JS import shape this project's own scripts might reasonably
# use, single- or double-quoted (Step 4 review finding #5 — the old
# single-quoted-`from`-only version missed player.js:401's dynamic
# `await import('/assets/client-zip.js')`, a real, currently-existing gap):
#   from '/assets/x.js'        static import
#   export ... from '/assets/x.js'   re-export (the bare "from '...'" shape
#                                     is identical, so this falls out for free)
#   import('/assets/x.js')     dynamic import
#   import '/assets/x.js'      side-effect import
# Not a real JS parser (a comment containing this exact shape would still be
# treated as an import) — a conservative regex scan is what the review itself
# offered as an acceptable alternative to a full parser, for a project this
# size.
IMPORT_RE = re.compile(r"""(?:from\s+|import\s*\(\s*|import\s+)['"](/assets/[^'"]+)['"]""")


def check_assets_exist(rel, src):
    """Every /assets/ script a page loads — and everything those scripts
    import — has to actually be written by build.py.

    A missing write() line is invisible in the generated HTML and shows up only
    as a 404 in a browser. For the migrated pages that 404 is *survivable* (it
    is exactly the fallback path player-boot.js is built around), which is
    precisely why it needs catching here instead of being noticed by eye.
    """
    errors, seen = [], set()
    pending = list(SRC_RE.findall(src))
    while pending:
        asset = pending.pop()
        if asset in seen:
            continue
        seen.add(asset)
        path = os.path.join(ROOT, asset.lstrip("/"))
        if not os.path.exists(path):
            errors.append(f"{rel}: references {asset}, which build.py never writes")
            continue
        if asset.endswith(".js"):
            pending += IMPORT_RE.findall(open(path).read())
    return errors


def check():
    errors, n_track, n_rec, n_pages = [], 0, 0, 0
    track_links = load_track_links()

    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    from sitegen.pages import CONTROLLER_ENGINE_SLUGS, CONTROLLER_ENGINE_EXCLUDED_SLUGS
    from sitegen.core import PUBLIC_SHOWS

    playlist_page = os.path.join(ROOT, "playlist", "index.html")
    if os.path.exists(playlist_page):
        playlist_src = open(playlist_page).read()
        errors += check_playlist_engine_wiring(playlist_src)
        errors += check_assets_exist("playlist/index.html", playlist_src)
        errors += check_playback_ready_first("playlist/index.html", playlist_src)
    else:
        errors.append("no generated /playlist/ page found -- run scripts/build.py first")

    show_pages = sorted(glob.glob(os.path.join(ROOT, "shows", "*", "index.html")))
    if not show_pages:
        return ["no generated show pages found — run scripts/build.py first"], 0, 0, 0

    # A slug that generates no page (a hidden show, a typo) would allowlist
    # nothing at all and pass every other check by simply not existing.
    built = {os.path.basename(os.path.dirname(p)) for p in show_pages}
    for slug in sorted(CONTROLLER_ENGINE_SLUGS - built):
        errors.append(f"CONTROLLER_ENGINE_SLUGS lists {slug!r}, which generates no show page")

    # As of Step 5b (2026-08-14) the allowlist is meant to cover every public
    # show, computed from PUBLIC_SHOWS rather than hand-maintained -- this is
    # now a real regression to catch (a future edit that shrinks coverage
    # without updating CONTROLLER_ENGINE_EXCLUDED_SLUGS deliberately), not
    # the "intentionally partial, still-incremental" state check_
    # allowlist_covers_every_public_show()'s own docstring describes for
    # Phase 1's earlier steps.
    errors += check_allowlist_covers_every_public_show(
        CONTROLLER_ENGINE_SLUGS, CONTROLLER_ENGINE_EXCLUDED_SLUGS, [s["slug"] for s in PUBLIC_SHOWS])

    for path in show_pages:
        rel = os.path.relpath(path, ROOT)
        src = open(path).read()
        n_pages += 1
        ids = []

        errors += check_engine_wiring(rel, src, os.path.basename(os.path.dirname(path)),
                                      CONTROLLER_ENGINE_SLUGS)
        errors += check_assets_exist(rel, src)
        errors += check_every_row_has_item(rel, src)
        errors += check_playback_ready_first(rel, src)

        for raw in ITEM_RE.findall(src):
            try:
                item = json.loads(html.unescape(raw))
            except Exception as e:
                errors.append(f"{rel}: unparseable data-item ({e})")
                continue
            ids.append(item.get("id"))
            for field in REQUIRED:
                if not item.get(field):
                    errors.append(f"{rel}: item {item.get('id')!r} missing required field {field!r}")
            if item.get("kind") not in ("track", "recording"):
                errors.append(f"{rel}: item {item.get('id')!r} has bad kind {item.get('kind')!r}")
            if item.get("kind") == "track":
                n_track += 1
                if item.get("durationSec") is None:
                    errors.append(f"{rel}: track {item.get('id')!r} has no durationSec")
                if not item.get("peaksKey"):
                    errors.append(f"{rel}: track {item.get('id')!r} has no peaksKey")
                errors += check_share_link(rel, item, track_links)
            else:
                n_rec += 1
            # The lossless original is only reachable via /auth + /download;
            # /stream 403s it. Publishing a stream URL here would be publishing
            # an address guaranteed to fail.
            loss = (item.get("downloads") or {}).get("lossless")
            if loss and "://" in str(loss.get("key", "")):
                errors.append(f"{rel}: item {item.get('id')!r} downloads.lossless.key is a URL, expected an R2 key")

        # Two views decide which is active by comparing ids, so a duplicate
        # would light up both.
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            errors.append(f"{rel}: DUPLICATE item ids on one page: {dupes}")

        # The new engine must play exactly what the legacy one plays.
        for data_src, raw in ROW_RE.findall(src):
            item = json.loads(html.unescape(raw))
            if html.unescape(data_src) != item["streamUrl"]:
                errors.append(f"{rel}: track {item['id']!r} streamUrl != legacy data-src")
        for raw, data_src in CARD_RE.findall(src):
            item = json.loads(html.unescape(raw))
            if html.unescape(data_src) != item["streamUrl"]:
                errors.append(f"{rel}: recording {item['id']!r} streamUrl != legacy data-src")

    # ── song pages (Phase 3 Stage 3a-foundation) ─────────────────────────
    # /songs/ itself: song-boot.js is unconditional (see SONG_ENGINE_FLAG's
    # comment in sitegen/pages.py), but its occurrence rows are inserted
    # LAZILY by songs.js -- there is no static data-item markup on this page
    # to validate the way show/song-detail pages have; only the engine
    # wiring is checkable here. The row markup itself (occRowHtml() in
    # songs.js) is covered by scripts/test-song-boot.mjs instead.
    songs_index_page = os.path.join(ROOT, "songs", "index.html")
    if os.path.exists(songs_index_page):
        songs_index_src = open(songs_index_page).read()
        errors += check_song_engine_wiring("songs/index.html", songs_index_src)
        errors += check_playback_ready_first("songs/index.html", songs_index_src)
    else:
        errors.append("no generated /songs/ index page found -- run scripts/build.py first")

    # /songs/<slug>/: every occurrence row IS server-rendered (not lazy),
    # same shape as a show page -- validate it the same way, with two
    # deliberate differences from show-page tracks: no peaksKey requirement
    # (occurrence rows never have a waveform) and REQUIRED/kind/lossless-key
    # checks reused as-is (the schema is otherwise identical).
    for path in sorted(glob.glob(os.path.join(ROOT, "songs", "*", "index.html"))):
        rel = os.path.relpath(path, ROOT)
        src = open(path).read()
        n_pages += 1
        errors += check_song_engine_wiring(rel, src)
        errors += check_assets_exist(rel, src)
        errors += check_playback_ready_first(rel, src)

        ids = []
        for data_src, raw in SONG_OCC_RE.findall(src):
            try:
                item = json.loads(html.unescape(raw))
            except Exception as e:
                errors.append(f"{rel}: unparseable data-item ({e})")
                continue
            ids.append(item.get("id"))
            for field in REQUIRED:
                if not item.get(field):
                    errors.append(f"{rel}: item {item.get('id')!r} missing required field {field!r}")
            if item.get("kind") != "track":
                errors.append(f"{rel}: song occurrence item {item.get('id')!r} has bad kind {item.get('kind')!r}")
            else:
                n_track += 1
                errors += check_share_link(rel, item, track_links)
            if html.unescape(data_src) != item.get("streamUrl"):
                errors.append(f"{rel}: item {item.get('id')!r} streamUrl != legacy data-src")
            loss = (item.get("downloads") or {}).get("lossless")
            if loss and "://" in str(loss.get("key", "")):
                errors.append(f"{rel}: item {item.get('id')!r} downloads.lossless.key is a URL, expected an R2 key")
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            errors.append(f"{rel}: DUPLICATE item ids on one page: {dupes}")

    t_errors, t_track, t_pages = check_track_pages(track_links)
    errors += t_errors
    n_track += t_track
    n_pages += t_pages

    return errors, n_track, n_rec, n_pages


# ── single-song share pages (/t/{code}/) ────────────────────────────────────
# plans/share/track-share-plan.md §9. These replaced the Worker's redirect, so
# what used to be a runtime lookup failure ("code not in the map") is now a
# build-time one ("no page for that code") -- checked here in both directions,
# because a shared link that 404s is the single worst outcome this feature has.
TRACK_PAGE_AUTOPLAY = "window.PLAYER_AUTOPLAY = true"
CANONICAL_RE = re.compile(r'<link rel="canonical" href="([^"]+)"')
OG_URL_RE = re.compile(r'<meta property="og:url" content="([^"]+)"')
PEAKS_URL_RE = re.compile(r'window\.WS_PEAKS_URL\s*=\s*"([^"]+)"')

def check_track_pages(track_links):
    """Errors, tracks counted, pages counted for the built /t/{code}/ pages."""
    errors, n_track, n_pages = [], 0, 0
    pages = sorted(glob.glob(os.path.join(ROOT, "t", "*", "index.html")))
    if not pages:
        return ["no generated /t/{code} share pages found -- run scripts/build.py first"], 0, 0

    built = {os.path.basename(os.path.dirname(p)) for p in pages}
    if track_links is not None:
        # Every code the build hands out in a shareUrl must have a page. This
        # is the check that would have caught a half-written /t/ tree.
        for code in sorted(set(track_links) - built):
            errors.append(f"share code {code!r} is in assets/track-links.json but has no /t/{code}/ page")
        # Same failure mode, and the same remedy, as check_orphan_song_dirs():
        # the build never deletes output, so a renumbered track strands the
        # page its old code pointed at. Emit the exact cleanup command.
        for code in sorted(built - set(track_links)):
            errors.append(f"orphaned share page /t/{code}/ -- no track hands out that code "
                          f"any more (a renumber?). Clean up with: git rm -r 't/{code}/' "
                          f"'assets/peaks/t/{code}.json'")

    for path in pages:
        rel = os.path.relpath(path, ROOT)
        code = os.path.basename(os.path.dirname(path))
        src = open(path).read()
        n_pages += 1

        if ENGINE_FLAG not in src or BOOT_TAG not in src:
            errors.append(f"{rel}: share page must emit the engine flag and player-boot.js")
        if TRACK_PAGE_AUTOPLAY not in src:
            errors.append(f"{rel}: share page must set window.PLAYER_AUTOPLAY -- without it the "
                          f"page a recipient opens to hear one song does not start it")
        # canonical/og:url must be the page's OWN canonical address. Pointing
        # them at the redirecting slash-less form is what broke sharing to
        # Facebook on 2026-08-22: og:url is the canonical the crawler adopts,
        # so it fetched a URL that bounced straight back. Checked against the
        # track's shareUrl below rather than reconstructed here, so the two
        # cannot drift apart again.
        m_can = CANONICAL_RE.search(src)
        if not m_can:
            errors.append(f"{rel}: share page has no <link rel=\"canonical\">")
        m_og = OG_URL_RE.search(src)
        if not m_og:
            errors.append(f"{rel}: share page has no og:url")
        if m_can and m_og and m_can.group(1) != m_og.group(1):
            errors.append(f"{rel}: canonical {m_can.group(1)!r} != og:url {m_og.group(1)!r}")
        # A share page must be scrapeable: noindex blocks Facebook's crawler.
        if 'content="noindex"' in src:
            errors.append(f"{rel}: share page must NOT be noindex -- Facebook honours it "
                          f"and refuses to scrape, which is how sharing broke on 2026-08-22")
        errors += check_assets_exist(rel, src)
        errors += check_playback_ready_first(rel, src)

        m = PEAKS_URL_RE.search(src)
        if m and not os.path.exists(os.path.join(ROOT, m.group(1).lstrip("/"))):
            errors.append(f"{rel}: WS_PEAKS_URL points at {m.group(1)}, which build.py never writes")

        rows = ROW_RE.findall(src)
        if len(rows) != 1:
            errors.append(f"{rel}: expected exactly one track row, found {len(rows)} -- "
                          f"a share page is one performance by definition")
        for data_src, raw in rows:
            try:
                item = json.loads(html.unescape(raw))
            except Exception as e:
                errors.append(f"{rel}: unparseable data-item ({e})")
                continue
            n_track += 1
            for field in REQUIRED:
                if not item.get(field):
                    errors.append(f"{rel}: item {item.get('id')!r} missing required field {field!r}")
            if item.get("kind") != "track":
                errors.append(f"{rel}: item {item.get('id')!r} has bad kind {item.get('kind')!r}")
            if html.unescape(data_src) != item.get("streamUrl"):
                errors.append(f"{rel}: item {item.get('id')!r} streamUrl != legacy data-src")
            errors += check_share_link(rel, item, track_links)
            # The page for code X must be the page code X hands out. Without
            # this, a build that paired pages and codes off by one would still
            # pass every other check on this page.
            share = str(item.get("shareUrl") or "")
            if not share.endswith("/" + code + "/"):
                errors.append(f"{rel}: page is /t/{code}/ but its track's shareUrl is {share!r}")
            # The address the page advertises to crawlers and the address the
            # share button hands out have to be the same string.
            if m_can and m_can.group(1) != share:
                errors.append(f"{rel}: canonical {m_can.group(1)!r} != the shareUrl this page "
                              f"hands out ({share!r}) -- a crawler would be sent elsewhere")
    return errors, n_track, n_pages


def check_allowlist_covers_every_public_show(controller_engine_slugs, excluded_slugs, public_show_slugs):
    """As of Step 5b (2026-08-14) this IS part of the default build gate
    (called from check()) -- CONTROLLER_ENGINE_SLUGS is meant to cover every
    public show now, so a regression here is a real bug, not an expected
    incremental-rollout state. Built during Step 4/5a while the allowlist was
    still an intentional 3-page subset (see player-consolidation-codex.md's
    ninth review) -- kept as a standalone function, and also reachable via
    --check-allowlist-coverage below, since isolating this one invariant is
    still occasionally useful on its own.

    This is the reverse of check()'s existing CONTROLLER_ENGINE_SLUGS - built
    invariant (an allowlisted slug that generates no page): here we check
    whether every generated public show is actually accounted for -- either
    allowlisted OR deliberately excluded via CONTROLLER_ENGINE_EXCLUDED_SLUGS.

    Fixed 2026-08-14 (Codex review of Step 5b): the original two-way check
    (public_show_slugs - controller_engine_slugs) broke the rollback escape
    hatch it was supposed to leave alone -- the moment a slug is added to
    CONTROLLER_ENGINE_EXCLUDED_SLUGS, CONTROLLER_ENGINE_SLUGS's own set-
    subtraction construction drops that slug, and the old two-way check then
    flagged it as "missing" even though the exclusion was deliberate. This
    three-way version treats "allowlisted" and "deliberately excluded" as the
    two ways a public show can be accounted for, and only flags a genuine gap
    (neither).
    """
    controller_engine_slugs = set(controller_engine_slugs)
    excluded_slugs = set(excluded_slugs)
    public_show_slugs = set(public_show_slugs)

    errors = []

    bad_excluded = excluded_slugs - public_show_slugs
    if bad_excluded:
        errors.append(f"CONTROLLER_ENGINE_EXCLUDED_SLUGS names non-public show(s): {sorted(bad_excluded)}")

    overlap = controller_engine_slugs & excluded_slugs
    if overlap:
        errors.append(f"CONTROLLER_ENGINE_SLUGS and CONTROLLER_ENGINE_EXCLUDED_SLUGS overlap: {sorted(overlap)}")

    missing = public_show_slugs - controller_engine_slugs - excluded_slugs
    if missing:
        errors.append(f"CONTROLLER_ENGINE_SLUGS is missing public show(s): {sorted(missing)}")

    return errors


def _selftest():
    """In-memory checks that check_every_row_has_item() actually distinguishes
    "attribute present" from "attribute missing" — added after the Step 4
    review (finding #2) showed the old approach (ITEM_RE.findall, which only
    sees attributes that exist) can't tell the difference. Run automatically
    on every invocation, ahead of the real check: cheap, no filesystem, no
    reason to make it opt-in and risk it being skipped.
    """
    ok_row = '<div class="track-row ws-track" id="track-1" data-item="{}">'
    bad_row = '<div class="track-row ws-track" id="track-2">'
    errs = check_every_row_has_item("selftest", ok_row + bad_row)
    assert len(errs) == 1 and "track-2" in errs[0], f"expected one error naming track-2, got {errs}"

    ok_card = '<div class="recording-item" data-item="{}">'
    bad_card = '<div class="recording-item">'
    errs = check_every_row_has_item("selftest", ok_card + bad_card)
    assert len(errs) == 1 and "recording-item" in errs[0], f"expected one recording-item error, got {errs}"

    errs = check_every_row_has_item("selftest", ok_row + ok_card)
    assert errs == [], f"expected no errors when every element has data-item, got {errs}"

    # IMPORT_RE (finding #5): must catch every import shape this project's own
    # scripts might use, not just the single-quoted static `from` it started
    # with — that gap is what let player.js:401's dynamic import go unchecked.
    cases = {
        "from '/assets/a.js'": "/assets/a.js",
        'from "/assets/b.js"': "/assets/b.js",
        "export { x } from '/assets/c.js'": "/assets/c.js",
        "import('/assets/d.js')": "/assets/d.js",
        "await import( '/assets/e.js' )": "/assets/e.js",
        "import '/assets/f.js';": "/assets/f.js",
    }
    for src, expected in cases.items():
        got = IMPORT_RE.findall(src)
        assert got == [expected], f"IMPORT_RE on {src!r}: expected [{expected!r}], got {got}"

    # check_allowlist_covers_every_public_show() -- the reverse invariant from
    # check()'s existing "allowlisted slug generates no page" check. As of
    # Step 5b this runs inside check() itself (see there); tested here in
    # isolation with fake data, same as every other check in this file.
    complete = check_allowlist_covers_every_public_show(
        {"show-a", "show-b"}, set(), ["show-a", "show-b"])
    assert complete == [], f"expected no errors for a complete allowlist, got {complete}"

    # A genuinely missing slug (neither allowlisted nor excluded) is still a
    # real gap -- exactly one error naming it.
    incomplete = check_allowlist_covers_every_public_show(
        {"show-a"}, set(), ["show-a", "show-b"])
    assert len(incomplete) == 1 and "show-b" in incomplete[0], \
        f"expected exactly one error naming show-b, got {incomplete}"

    # The regression this fix exists for: a slug deliberately dropped from
    # CONTROLLER_ENGINE_SLUGS via CONTROLLER_ENGINE_EXCLUDED_SLUGS (the
    # rollback escape hatch) must produce ZERO errors -- it's accounted for,
    # just not allowlisted. Against the old two-arg logic this case fails
    # (see the fail-then-pass proof run before this fix landed).
    deliberate_exclusion = check_allowlist_covers_every_public_show(
        {"show-a"}, {"show-b"}, ["show-a", "show-b"])
    assert deliberate_exclusion == [], \
        f"expected no errors for a deliberately excluded slug, got {deliberate_exclusion}"

    # An excluded slug that isn't actually a public show at all (a typo in
    # CONTROLLER_ENGINE_EXCLUDED_SLUGS) must be flagged, naming it.
    bad_exclusion = check_allowlist_covers_every_public_show(
        {"show-a"}, {"show-does-not-exist"}, ["show-a", "show-b"])
    assert any("show-does-not-exist" in e for e in bad_exclusion), \
        f"expected an error naming show-does-not-exist, got {bad_exclusion}"

    # check_playlist_engine_wiring() post-Stage-2c: single-engine reality --
    # playlist-boot.js must be present exactly once, legacy playlist.js and
    # any leftover engine-resolver wiring must not be, WORKER_ORIGIN must be.
    def _clean_page():
        return f"<script>window.WORKER_ORIGIN='https://x';</script>\n{PLAYLIST_BOOT_TAG}"

    clean = check_playlist_engine_wiring(_clean_page())
    assert clean == [], f"expected no errors on a clean single-engine page, got {clean}"

    missing_boot = check_playlist_engine_wiring("<p>no engine wiring here</p>")
    assert any("playlist-boot.js is missing" in e for e in missing_boot), \
        f"expected an error when playlist-boot.js is absent, got {missing_boot}"

    duplicate_boot = check_playlist_engine_wiring(_clean_page() + f"\n{PLAYLIST_BOOT_TAG}")
    assert any("appears 2 times" in e for e in duplicate_boot), \
        f"expected an error when playlist-boot.js's tag is duplicated, got {duplicate_boot}"

    stale_legacy = check_playlist_engine_wiring(f"{PLAYLIST_TAG}\n{_clean_page()}")
    assert any("legacy playlist.js is still referenced" in e for e in stale_legacy), \
        f"expected an error when legacy playlist.js is still on the page, got {stale_legacy}"

    stale_resolver = check_playlist_engine_wiring(
        f"<script>if(new URLSearchParams(location.search).get('engine')==='legacy')"
        f"window.PLAYLIST_ENGINE='controller';</script>\n{_clean_page()}")
    assert any("leftover engine-resolver wiring" in e for e in stale_resolver), \
        f"expected an error for leftover PLAYLIST_ENGINE/?engine= wiring, got {stale_resolver}"

    missing_worker_origin = check_playlist_engine_wiring(PLAYLIST_BOOT_TAG)
    assert any("WORKER_ORIGIN is not set" in e for e in missing_worker_origin), \
        f"expected an error when WORKER_ORIGIN is missing, got {missing_worker_origin}"

    # check_song_engine_wiring() -- Stage 3a-foundation's always-on analogue
    # of check_engine_wiring(), no allowlist to check against.
    song_clean = (f"{SONG_ENGINE_FLAG}\n{PLAYER_TAG}\n{SONG_BOOT_TAG}></script>")
    assert check_song_engine_wiring("songs/x", song_clean) == [], \
        f"expected no errors on a clean song page, got {check_song_engine_wiring('songs/x', song_clean)}"

    song_missing_flag = check_song_engine_wiring("songs/x", f"{PLAYER_TAG}\n{SONG_BOOT_TAG}></script>")
    assert any("emits no engine flag" in e for e in song_missing_flag), \
        f"expected an error when the song engine flag is missing, got {song_missing_flag}"

    song_missing_boot = check_song_engine_wiring("songs/x", f"{SONG_ENGINE_FLAG}\n{PLAYER_TAG}")
    assert any("must be emitted together" in e for e in song_missing_boot), \
        f"expected an error when song-boot.js is missing but the flag is set, got {song_missing_boot}"

    song_bad_order = check_song_engine_wiring(
        "songs/x", f"{PLAYER_TAG}\n{SONG_ENGINE_FLAG}\n{SONG_BOOT_TAG}></script>")
    assert any("must come BEFORE player.js" in e for e in song_bad_order), \
        f"expected an error when the song engine flag comes after player.js, got {song_bad_order}"

    # check_playback_ready_first() -- the readiness-contract snippet must be
    # present and precede any other <script> tag.
    ready_ok = check_playback_ready_first(
        "x", f"<script>{PLAYBACK_READY_MARKER}(r){{}});</script><script src=\"/assets/player.js\"></script>")
    assert ready_ok == [], f"expected no errors when the readiness snippet is first, got {ready_ok}"

    ready_missing = check_playback_ready_first("x", '<script src="/assets/player.js"></script>')
    assert any("missing window.PLAYBACK_HOST_READY" in e for e in ready_missing), \
        f"expected an error when the readiness snippet is absent, got {ready_missing}"

    ready_late = check_playback_ready_first(
        "x", f"<script src=\"/assets/player.js\"></script><script>{PLAYBACK_READY_MARKER}(r){{}});</script>")
    assert any("must be armed by the FIRST script" in e for e in ready_late), \
        f"expected an error when the readiness snippet is not the first script, got {ready_late}"


def main():
    _selftest()

    # --check-allowlist-coverage: as of Step 5b this same invariant also runs
    # inside check() below (the default path) -- this standalone flag is now
    # just a convenience for checking coverage in isolation, without running
    # the rest of check()'s markup validation.
    if "--check-allowlist-coverage" in sys.argv[1:]:
        sys.path.insert(0, os.path.join(ROOT, "scripts"))
        from sitegen.pages import CONTROLLER_ENGINE_SLUGS, CONTROLLER_ENGINE_EXCLUDED_SLUGS
        from sitegen.core import PUBLIC_SHOWS
        public_show_slugs = [s["slug"] for s in PUBLIC_SHOWS]
        errors = check_allowlist_covers_every_public_show(
            CONTROLLER_ENGINE_SLUGS, CONTROLLER_ENGINE_EXCLUDED_SLUGS, public_show_slugs)
        if errors:
            print("allowlist coverage FAILED:")
            for e in errors:
                print(f"  - {e}")
            sys.exit(1)
        print(f"allowlist coverage OK — CONTROLLER_ENGINE_SLUGS covers all "
              f"{len(public_show_slugs)} public shows")
        return

    errors, n_track, n_rec, n_pages = check()
    if errors:
        print(f"markup integrity FAILED — {len(errors)} problem(s):")
        for e in errors[:40]:
            print(f"  - {e}")
        if len(errors) > 40:
            print(f"  ... and {len(errors) - 40} more")
        sys.exit(1)
    print(f"markup OK — {n_track + n_rec} items ({n_track} tracks, {n_rec} recordings) "
          f"across {n_pages} generated show/song/share pages")


if __name__ == "__main__":
    main()
