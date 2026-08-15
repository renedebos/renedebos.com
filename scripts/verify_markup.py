#!/usr/bin/env python3
"""Verify the data-item markup in the generated show pages.

Guards the player-consolidation work (plans/player-consolidation/): every
playable thing on a show page carries a normalized item as a data-item JSON
attribute, which the shared player reads instead of fetching a catalog. That
markup is generated, so nothing in build.py --check (which validates *source*
data) looks at it.

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


ENGINE_FLAG = "window.PLAYER_ENGINE = 'controller'"
BOOT_TAG = '<script type="module" src="/assets/player-boot.js"></script>'
PLAYER_TAG = '<script src="/assets/player.js"></script>'


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


PLAYLIST_BOOT_TAG = '<script type="module" src="/assets/playlist-boot.js"></script>'
PLAYLIST_TAG = '<script src="/assets/playlist.js"></script>'
PLAYLIST_ENGINE_SNIPPET = "window.PLAYLIST_ENGINE='controller'"
# Matches the literal boolean pages.py's build_playlist() bakes into the
# resolver's default-decision branch -- see the f-string at
# `f"if(p==='controller'||(p!=='legacy'&&{'true' if PLAYLIST_CONTROLLER_ENGINE else 'false'}))"`.
PLAYLIST_DEFAULT_LITERAL_RE = re.compile(r"p!=='legacy'&&(true|false)\)")


def check_playlist_engine_wiring(src, playlist_controller_engine):
    """The /playlist/ analogue of check_engine_wiring() above, but a
    single-page boolean rather than an N-page slug-set check -- Step 5b's
    coverage-checking machinery (CONTROLLER_ENGINE_SLUGS et al.) is built for
    a catalog of interchangeable show pages and doesn't map to one
    architecturally distinct page.

    Two SEPARATE invariants, not one "presence matches the constant" check --
    that single-check version is wrong for Stage 2a itself: the constant is
    False there, but the resolver script and playlist-boot.js must both still
    be present (that's the entire mechanism the `?engine=controller` canary
    depends on -- the assets have to exist for the param to activate them at
    runtime). So:
      (1) the resolver snippet and the boot module always travel together
          (asset presence -- true in every stage except after the eventual
          Stage 2c deletion, when both must be ABSENT instead);
      (2) the resolver's DEFAULT decision (what it emits when no `?engine=`
          param is present) matches `playlist_controller_engine` -- a
          build-time string check on the resolver's baked-in literal, not an
          asset-presence check (fixed 2026-08-15 Codex review: this
          invariant was documented in this docstring but never actually
          implemented -- the parameter was accepted and never read, so
          Stage 2b could flip PLAYLIST_CONTROLLER_ENGINE in pages.py without
          rebuilding, and this gate would have accepted the stale HTML).
      (3) window.PLAYLIST_ENGINE_MOUNTED being reachable at all requires the
          resolver to run before playlist.js, and playlist-boot.js to load
          after it -- checked positionally, same reasoning as
          check_engine_wiring()'s player.js ordering checks.
    playlist.js itself must remain on the page throughout 2a/2b -- it's the
    runtime fallback.

    Fixed 2026-08-15 (Codex post-deploy review finding #2): invariant (1)
    used to only fire when has_resolver and has_boot DISAGREED -- if a
    template regression dropped BOTH the resolver and the boot tag at once
    (has_resolver == has_boot == False), that comparison is False == False,
    no error, and every other check lives inside `if has_resolver:` so
    nothing else caught it either. During 2a/2b (playlist.js still present)
    both must exist regardless of whether they happen to agree; only after
    Stage 2c deletes playlist.js is "both absent" the correct state. Gate on
    PLAYLIST_TAG's presence (the pre-2c/post-2c signal) instead of on
    has_resolver alone.
    """
    errors = []
    has_resolver = PLAYLIST_ENGINE_SNIPPET in src
    has_boot = PLAYLIST_BOOT_TAG in src
    has_legacy = PLAYLIST_TAG in src

    if has_legacy:
        # Pre-2c: playlist.js is still the runtime fallback, so both the
        # resolver and the boot module must be present -- the canary
        # mechanism doesn't work without either one.
        if not has_resolver or not has_boot:
            errors.append("/playlist/: engine resolver and playlist-boot.js must both be present "
                          f"while playlist.js is still shipped (resolver={has_resolver}, boot={has_boot})")
    else:
        # Post-2c: playlist.js was deleted, so neither the resolver nor the
        # boot module should still be emitted.
        if has_resolver or has_boot:
            errors.append("/playlist/: playlist.js is gone but the engine resolver and/or "
                          f"playlist-boot.js are still present (resolver={has_resolver}, boot={has_boot}) "
                          "-- stale post-Stage-2c wiring")
    if has_resolver and has_legacy:
        if src.index(PLAYLIST_ENGINE_SNIPPET) > src.index(PLAYLIST_TAG):
            errors.append("/playlist/: engine resolver must come BEFORE playlist.js")
        if has_boot and src.index(PLAYLIST_BOOT_TAG) < src.index(PLAYLIST_TAG):
            errors.append("/playlist/: playlist-boot.js must load after playlist.js")

    if has_resolver:
        m = PLAYLIST_DEFAULT_LITERAL_RE.search(src)
        if not m:
            errors.append("/playlist/: could not find the resolver's default-decision literal to verify "
                          "(pages.py's resolver template may have changed shape)")
        else:
            emitted_default = m.group(1) == "true"
            if emitted_default != bool(playlist_controller_engine):
                errors.append(
                    f"/playlist/: resolver's baked-in default is {emitted_default} but "
                    f"PLAYLIST_CONTROLLER_ENGINE is {bool(playlist_controller_engine)!r} -- "
                    "the page is stale, rebuild with scripts/build.py")

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

    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    from sitegen.pages import CONTROLLER_ENGINE_SLUGS, CONTROLLER_ENGINE_EXCLUDED_SLUGS, PLAYLIST_CONTROLLER_ENGINE
    from sitegen.core import PUBLIC_SHOWS

    playlist_page = os.path.join(ROOT, "playlist", "index.html")
    if os.path.exists(playlist_page):
        playlist_src = open(playlist_page).read()
        errors += check_playlist_engine_wiring(playlist_src, PLAYLIST_CONTROLLER_ENGINE)
        errors += check_assets_exist("playlist/index.html", playlist_src)
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

    # Song pages deliberately stay on the legacy engine this phase.
    for path in glob.glob(os.path.join(ROOT, "songs", "*", "index.html")):
        if "data-item" in open(path).read():
            errors.append(f"{os.path.relpath(path, ROOT)}: song pages must not carry data-item yet "
                          "(they migrate in a later phase)")

    return errors, n_track, n_rec, n_pages


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

    # check_playlist_engine_wiring()'s invariant (2), fixed 2026-08-15 (Codex
    # review) after the parameter was accepted but never actually checked.
    # Both mismatch directions, plus the matching case for each literal.
    def _playlist_html(default_literal):
        return (
            f"<script>(function(){{var p=new URLSearchParams(location.search).get('engine');"
            f"if(p==='controller'||(p!=='legacy'&&{default_literal}))"
            f"window.PLAYLIST_ENGINE='controller';window.WORKER_ORIGIN='https://x';}})();</script>\n"
            + PLAYLIST_TAG + "\n" + PLAYLIST_BOOT_TAG
        )

    matching_false = check_playlist_engine_wiring(_playlist_html("false"), False)
    assert matching_false == [], f"expected no errors when both are False, got {matching_false}"

    matching_true = check_playlist_engine_wiring(_playlist_html("true"), True)
    assert matching_true == [], f"expected no errors when both are True, got {matching_true}"

    stale_true_page = check_playlist_engine_wiring(_playlist_html("true"), False)
    assert any("resolver's baked-in default is True" in e for e in stale_true_page), \
        f"expected a mismatch error (page says True, constant is False), got {stale_true_page}"

    stale_false_page = check_playlist_engine_wiring(_playlist_html("false"), True)
    assert any("resolver's baked-in default is False" in e for e in stale_false_page), \
        f"expected a mismatch error (page says False, constant is True), got {stale_false_page}"

    # Fixed 2026-08-15 (Codex post-deploy review finding #2): a template
    # regression that drops BOTH the resolver and playlist-boot.js at once
    # (has_resolver == has_boot == False) used to slip past every check in
    # this function -- invariant (1) only fired on disagreement, and every
    # other check lived inside `if has_resolver:`. During 2a/2b, with
    # playlist.js still on the page, that combination must be flagged.
    both_missing_pre_2c = check_playlist_engine_wiring(PLAYLIST_TAG, False)
    assert any("must both be present" in e for e in both_missing_pre_2c), \
        f"expected an error when playlist.js ships alone with no resolver/boot, got {both_missing_pre_2c}"

    # The mirror case: only one of the pair present (not both, not neither)
    # while playlist.js is still shipped.
    resolver_only = check_playlist_engine_wiring(
        f"<script>window.PLAYLIST_ENGINE='controller';</script>\n{PLAYLIST_TAG}", False)
    assert any("must both be present" in e for e in resolver_only), \
        f"expected an error when only the resolver is present, got {resolver_only}"

    # Post-2c (playlist.js deleted): resolver/boot must both be ABSENT.
    # Leftover wiring after the deletion is a real regression, not the
    # "both present" case invariant (1) already covers.
    post_2c_clean = check_playlist_engine_wiring("<p>no playlist engine here</p>", False)
    assert post_2c_clean == [], f"expected no errors once playlist.js and its wiring are all gone, got {post_2c_clean}"

    post_2c_leftover = check_playlist_engine_wiring(
        f"<script>window.PLAYLIST_ENGINE='controller';</script>\n{PLAYLIST_BOOT_TAG}", False)
    assert any("stale post-Stage-2c wiring" in e for e in post_2c_leftover), \
        f"expected an error for leftover resolver/boot wiring after playlist.js is deleted, got {post_2c_leftover}"


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
          f"across {n_pages} generated show pages")


if __name__ == "__main__":
    main()
