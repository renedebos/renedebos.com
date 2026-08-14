"""sitegen.core: data, constants, small helpers, validation, and the song concordance."""
import datetime
import html
import json
import os
import re
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
M = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
WORKER = M["worker"]

# Shows flagged "hidden" (e.g. not yet processed and not planned for a while)
# are kept in recordings.json for provenance but excluded from every public
# listing/page/feed. validate()/stamp_added_dates() still see the full M["shows"].
PUBLIC_SHOWS = [s for s in M["shows"] if not s.get("hidden")]

SOURCE_LABEL = {"SBD": "Soundboard", "AUD": "Audience recording"}

TAG_VOCAB = {
    "original", "cover",                              # provenance
    "ballad", "upbeat", "rocker",                    # mood
    "irish", "folk", "country", "blues", "rock", "beatles",  # flavor
    "instrumental", "medley", "banter",              # format
    "guest", "improv",
    "favorite", "rarity",                            # curated
}

DURATION_RE = re.compile(r"^\d+:[0-5]\d$")

LEGACY_KEY_NAMING = {"mad-sweetwater-2000-02-17"}

def esc(s):
    return html.escape(str(s), quote=True)

def stream_url(file, version=None):
    u = f"{WORKER}/stream?file={urllib.parse.quote(file)}"
    if version:
        u += f"&v={version}"
    return u

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
    secs = sum(_duration_sec(t["duration"]) for t in tracks)
    return f"{secs // 3600}h {secs % 3600 // 60}m" if secs >= 3600 else f"{secs // 60}m"

def sanitize_filename(s):
    """Strip characters illegal in Windows/macOS/Linux filenames so ZIP
    folder/entry names stay portable once extracted. Windows also rejects a
    trailing dot/space (e.g. venue names like "Marin Brewing Co." would
    otherwise collide with an appended ".zip" into "Co..zip")."""
    s = re.sub(r'[<>:"/\\|?*]', "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.rstrip(". ")

def show_zip_folder(show):
    venue = show.get("venue_short") or show.get("venue") or "Unknown Venue"
    return sanitize_filename(f'{artist_name(show["artist"])} - {show["date"] or "Unknown Date"} - {venue}')

def show_zip_entries(show):
    """(folder, entries) for a show's curated FLAC tracks — {key, name} pairs
    mapping each R2 object to its path inside the ZIP. Shared by the live
    per-show download button (build_show) and the offline complete-archive
    snapshot script (build_archive_zip.py) so the two can never drift apart."""
    folder = show_zip_folder(show)
    entries = [{"key": t["flac"], "name": f'{folder}/{t["num"]:02d} - {sanitize_filename(t["title"])}.flac'}
               for t in (show.get("tracks") or []) if t.get("flac")]
    return folder, entries

def singles_for_show(show):
    return [s for s in M["singles"]
            if s["artist"] == show["artist"] and s["venue"] == show["venue"]
            and s["date"] and s["date"] == show["date"]]

def added_sort_key(s):
    # Order by full timestamp when available so same-day additions sort
    # most-recent-first; fall back to the date (treated as midnight).
    return (s.get("added_ts") or f'{s["added"]}T00:00:00', s["slug"])

def load_processing(slug):
    """Per-show audio-processing provenance written by the audio_processing
    workflow (data/processing/<slug>.json): target, tool, date, and per-track
    achieved loudness/true-peak/LRA. Returns the dict, or None if the show has
    never been run through the workflow. data/ is .assetsignore'd, so this is a
    build-time source only — its data is rendered into the show page HTML."""
    path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
    return json.load(open(path)) if os.path.exists(path) else None

def artist_name(aid):
    return next((a["name"] for a in M["artists"] if a["id"] == aid), aid)

def show_city(show):
    v = show.get("venue") or ""
    return v.split(", ")[-1] if ", " in v else ""

def _duration_sec(d):
    m, s = d.split(":")
    return int(m) * 60 + int(s)

def stamp_added_dates():
    """Stamp any show that has tracks but no `added` date yet, recording both a
    display date (`added`) and a full timestamp (`added_ts`) so same-day
    additions sort most-recent-first on the Updates page. Older shows stamped
    before `added_ts` existed are backfilled to midnight. Persists to
    recordings.json so the Updates page is hands-off."""
    today = datetime.date.today().isoformat()
    changed = []
    for s in M["shows"]:
        if s.get("tracks") and not s.get("added"):
            s["added"] = today
            s["added_ts"] = datetime.datetime.now().isoformat(timespec="microseconds")
            changed.append(s["slug"])
        elif s.get("added") and not s.get("added_ts"):
            s["added_ts"] = f'{s["added"]}T00:00:00'
            changed.append(s["slug"])
    if changed:
        with open(os.path.join(ROOT, "data", "recordings.json"), "w") as f:
            json.dump(M, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Stamped/backfilled added_ts on: {', '.join(changed)}")
    return changed

def validate():
    """Fail fast on the recordings.json footguns that otherwise produce broken
    pages or a mid-build crash. The whole site is generated from this one
    hand/tool-edited file, so a cheap up-front check is worth it."""
    errors = []
    artist_ids = {a["id"] for a in M["artists"]}
    seen_slugs = set()
    for i, s in enumerate(M["shows"]):
        where = s.get("slug") or f"shows[{i}]"
        if not s.get("slug"):
            errors.append(f"{where}: missing slug")
        elif s["slug"] in seen_slugs:
            errors.append(f"{where}: duplicate slug")
        else:
            seen_slugs.add(s["slug"])
        if s.get("artist") not in artist_ids:
            errors.append(f"{where}: artist {s.get('artist')!r} is not a known artist id {sorted(artist_ids)}")
        # null/absent means "no description" (build skips it); only a non-list
        # value such as a bare string is the footgun (renders char-by-char).
        if s.get("description") is not None and not isinstance(s["description"], list):
            errors.append(f"{where}: description must be a list of paragraph strings, not {type(s['description']).__name__}")
        # highlight is an editorial flag on the performance itself (independent of
        # recording quality); omit the key entirely rather than storing false.
        if "highlight" in s and s["highlight"] is not True:
            errors.append(f"{where}: highlight must be true, or the key omitted (not {s['highlight']!r})")
        folders = set()
        for t in s.get("tracks") or []:
            tw = f"{where} track {t.get('num')}"
            if not isinstance(t.get("num"), int):
                errors.append(f"{tw}: num must be an integer")
            if not t.get("title"):
                errors.append(f"{tw}: missing title")
            if not t.get("file"):
                errors.append(f"{tw}: missing file (MP3 R2 key)")
            bad_tags = set(t.get("tags") or []) - TAG_VOCAB
            if bad_tags:
                errors.append(f"{tw}: tags not in the TAGS.md vocabulary: {sorted(bad_tags)}")
            if "songwriter" in t and not (isinstance(t["songwriter"], str) and t["songwriter"].strip()):
                errors.append(f"{tw}: songwriter must be a non-empty string (omit the key if unknown)")
            if t.get("duration") and not DURATION_RE.match(t["duration"]):
                errors.append(f"{tw}: duration {t['duration']!r} is not M:SS")
            if bool(t.get("flac")) != bool(t.get("flac_size_mb")):
                errors.append(f"{tw}: flac and flac_size_mb must be set together")
            # R2 key conventions: MP3/<folder>/NN Title.mp3 + matching FLAC key.
            if isinstance(t.get("num"), int) and t.get("file"):
                legacy = s.get("slug") in LEGACY_KEY_NAMING
                parts = t["file"].split("/")
                if parts[0] != "MP3" or len(parts) != 3:
                    errors.append(f"{tw}: file key must look like MP3/<show folder>/<NN Title>.mp3")
                else:
                    folders.add(parts[1])
                    if not legacy and not parts[2].startswith(f"{t['num']:02d} "):
                        errors.append(f"{tw}: file basename {parts[2]!r} doesn't start with {t['num']:02d}")
                if t.get("flac"):
                    fparts = t["flac"].split("/")
                    if fparts[0] != "FLAC" or len(fparts) != 3 or fparts[1] != parts[1]:
                        errors.append(f"{tw}: flac key must be FLAC/<same show folder>/…")
                    elif not legacy and fparts[2] != parts[2][:-4] + ".flac":
                        errors.append(f"{tw}: flac basename doesn't mirror the MP3 basename")
        if len(folders) > 1:
            errors.append(f"{where}: tracks span multiple R2 folders: {sorted(folders)}")
        # Referential integrity: waveforms + processing provenance for curated shows.
        if s.get("tracks"):
            peaks_path = os.path.join(ROOT, "data", "peaks", f"{s['slug']}.json")
            if not os.path.exists(peaks_path):
                errors.append(f"{where}: missing data/peaks/{s['slug']}.json (run scripts/gen_peaks.py --slug {s['slug']})")
            else:
                # Per-TRACK coverage, not just "the file exists". A show with a
                # peaks file renders every track as a waveform row, which has no
                # native range input — so a track missing from the peaks map
                # would get neither a waveform nor a seek bar, i.e. a silently
                # unseekable row. Enforcing the invariant here is better than
                # writing a fallback for what would mean a corrupt peaks file.
                have = set(json.load(open(peaks_path)))
                missing = sorted(t["num"] for t in s["tracks"] if str(t["num"]) not in have)
                if missing:
                    errors.append(f"{where}: data/peaks/{s['slug']}.json is missing track(s) {missing} "
                                  f"(re-run scripts/gen_peaks.py --slug {s['slug']})")
            if any(t.get("processed") for t in s["tracks"]):
                proc_path = os.path.join(ROOT, "data", "processing", f"{s['slug']}.json")
                if not os.path.exists(proc_path):
                    errors.append(f"{where}: tracks marked processed but data/processing/{s['slug']}.json is missing")
                else:
                    nums = {t["num"] for t in s["tracks"] if isinstance(t.get("num"), int)}
                    stray = [n for n in json.load(open(proc_path)).get("tracks", {}) if int(n) not in nums]
                    if stray:
                        errors.append(f"{where}: processing sidecar has track number(s) {stray} not present in tracks[]")
    # Curated playlists (top-level "playlists"): every referenced track id
    # must exist, since a typo'd id would silently vanish from the queue
    # (hydrateFromHash drops unknown ids without complaint).
    valid_ids = {f'{s["slug"]}-{t["num"]:02d}'
                 for s in M["shows"] for t in (s.get("tracks") or [])
                 if isinstance(t.get("num"), int)}
    pl_slugs = set()
    playlists = M.get("playlists", [])
    if not isinstance(playlists, list):
        errors.append("playlists: must be a list")
        playlists = []
    for i, pl in enumerate(playlists):
        pw = f"playlists[{i}] ({pl.get('slug') or pl.get('name') or '?'})"
        if not (isinstance(pl.get("name"), str) and pl["name"].strip()):
            errors.append(f"{pw}: missing name")
        slug = pl.get("slug")
        if not (isinstance(slug, str) and re.fullmatch(r"[a-z0-9-]+", slug or "")):
            errors.append(f"{pw}: slug must be lowercase [a-z0-9-]")
        elif slug in pl_slugs:
            errors.append(f"{pw}: duplicate slug")
        else:
            pl_slugs.add(slug)
        ids = pl.get("ids")
        if not (isinstance(ids, list) and ids):
            errors.append(f"{pw}: ids must be a non-empty list of track ids")
        else:
            if len(ids) != len(set(ids)):
                errors.append(f"{pw}: duplicate track id(s) in ids")
            for tid in ids:
                if tid not in valid_ids:
                    errors.append(f"{pw}: unknown track id {tid!r}")
    # One songwriter per canonical song — the editor edits per-track, so a
    # per-song decision can silently miss variant titles or other shows.
    writers = {}
    for s in M["shows"]:
        for t in s.get("tracks") or []:
            if t.get("songwriter") and t.get("title"):
                key = song_norm(SONG_MANUAL_MERGE.get(t["title"], t["title"]))
                writers.setdefault(key, {})[t["songwriter"]] = t["title"]
    for key, seen in writers.items():
        if len(seen) > 1:
            print(f"WARNING: song {key!r} has conflicting songwriters: {seen}", file=sys.stderr)
    if errors:
        raise SystemExit("recordings.json validation failed:\n  - " + "\n  - ".join(errors))

def check_orphan_song_dirs():
    """A retitled or merged song silently strands its old /songs/<slug>/ page —
    build never deletes output. Fail loudly with the exact cleanup commands
    (replaces the manual runbook step)."""
    valid = {s["slug"] for s in collect_songs()[0]}
    existing = {d for d in os.listdir(os.path.join(ROOT, "songs"))
                if os.path.isdir(os.path.join(ROOT, "songs", d))}
    orphans = sorted(existing - valid)
    if orphans:
        cmds = "\n  ".join(f"git rm -r 'songs/{d}/'" for d in orphans)
        raise SystemExit(f"orphaned song page dir(s) no longer produced by the build:\n  {cmds}")

def check_rarity_drift():
    """'rarity' means played once or almost never (TAGS.md) — but it's applied
    at publish time and goes stale as later shows add appearances. Warn (never
    fail: the final call is Rene's) when a rarity-tagged song now has 3+
    appearances in the songs matrix."""
    warned = []
    for song in collect_songs()[0]:
        if song["plays"] < 3:
            continue
        by_show = {(o["slug"], o["num"]) for o in song["occ"]}
        for s in M["shows"]:
            for t in (s.get("tracks") or []):
                if (s["slug"], t["num"]) in by_show and "rarity" in (t.get("tags") or []):
                    warned.append(f'{song["canonical"]!r} plays {song["plays"]}x '
                                  f'but is tagged rarity on {s["slug"]} #{t["num"]:02d}')
    if warned:
        print(f"⚠ rarity drift — {len(warned)} track(s) tagged 'rarity' on songs "
              "with 3+ appearances (warning only, review the tags):")
        for w in sorted(set(warned)):
            print(f"    {w}")

SONG_MANUAL_MERGE = {
    "ABC - Sesame Street": "ABC",
    "The German Clock Winder": "The German Clockwinder",
    "Plastic Melons": "Plastic Lemons",
    "Dysfuctional Guy": "Dysfunctional Guy",
    "Don't Think Twice It's Alright": "Don't Think Twice It's All Right",
    "Hard Drinking": "Hard Drinkin'",
    "You're Pulling Me Leg / The Ted Kennedy Song": "You're Pulling Me Leg",
    "Rocky Road to Dublin / Star of County Down": "The Rocky Road to Dublin",
    "Me and Eddie Vedder": "Houses of the Holy",
    "Lover": "I Need a Lover",
    "I Need a Dream": "I Need a Lover",
    "My Dear": "Ride On",
    "My Dear (Ride On)": "Ride On",
    "Drift Away w_Demuir": "Drift Away",
}

SONG_CANONICAL_OVERRIDE = {"german clockwinder": "The German Clockwinder",
                           "ride on": "Ride On"}

ARTIST_SHORT = {"jerry": "Jerry", "mad": "Mad Hannans", "sean": "Sean",
                "seanjerry": "Sean & Jerry"}

_ARTIST_ORDER = ["jerry", "mad", "sean", "seanjerry"]

def song_norm(t):
    """Grouping key: lowercase, drop parentheticals + punctuation, ignore 'The'."""
    t = re.sub(r"\(.*?\)", "", t.lower().strip())
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    t = re.sub(r"\s+", " ", t)
    return re.sub(r"^the ", "", t)

def song_slug(t):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", song_norm(t))).strip("-")

def collect_songs():
    """Group every curated track across track-listed shows into canonical songs.
    Returns (songs, columns) where columns are the shows (chronological) that make
    up the grid, and each song carries its occurrences with playable stream info."""
    tl = [s for s in M["shows"] if s.get("tracks")]
    cols = sorted(tl, key=sort_key)
    groups = {}
    for s in tl:
        proc = load_processing(s["slug"])
        ptracks = proc.get("tracks", {}) if proc else {}
        for t in s["tracks"]:
            key = song_norm(SONG_MANUAL_MERGE.get(t["title"], t["title"]))
            g = groups.setdefault(key, {"variants": {}, "occ": []})
            g["variants"][t["title"]] = g["variants"].get(t["title"], 0) + 1
            ver = (ptracks.get(str(t["num"]), {}).get("md5") or "")[:12] or None
            proc_ver = ptracks.get(str(t["num"]), {}).get("ver")
            g["occ"].append({
                "artist": s["artist"], "artist_name": artist_name(s["artist"]),
                "venue": s.get("venue_short") or s.get("venue") or "—",
                "date": s["date"] or "Unknown date", "slug": s["slug"],
                "url": show_url(s), "num": t["num"], "duration": t.get("duration"),
                "file": t["file"], "ver": ver, "title": t["title"],
                "flac": t.get("flac"), "flac_size_mb": t.get("flac_size_mb"),
                "source": s.get("source"),
                "size_mb": t.get("size_mb"), "proc_ver": proc_ver,
            })
    songs, used = [], set()
    for key, g in groups.items():
        variants = sorted(g["variants"])
        canonical = SONG_CANONICAL_OVERRIDE.get(key) or sorted(
            variants, key=lambda v: (-g["variants"][v], "(" in v, len(v)))[0]
        slug = song_slug(canonical) or re.sub(r"\s+", "-", key) or "song"
        while slug in used:
            slug += "-x"
        used.add(slug)
        occ = sorted(g["occ"], key=lambda o: (o["date"] == "Unknown date", o["date"], o["slug"]))
        artists = sorted({o["artist"] for o in g["occ"]},
                         key=lambda a: _ARTIST_ORDER.index(a) if a in _ARTIST_ORDER else 9)
        songs.append({"canonical": canonical, "slug": slug, "variants": variants,
                      "plays": len(occ), "artists": artists, "occ": occ})
    songs.sort(key=lambda s: (-s["plays"], s["canonical"].lower()))
    return songs, cols

def iso_duration(mmss):
    """'3:27' -> 'PT3M27S' (ISO-8601 duration); None if unparseable."""
    if not mmss or ":" not in mmss:
        return None
    p = [int(x) for x in mmss.split(":")]
    h, m, s = ([0] + p)[-3:] if len(p) == 2 else p
    return (f"PT{h}H{m}M{s}S" if h else f"PT{m}M{s}S")


def write(path, content):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


__all__ = ['write', 'ARTIST_SHORT', 'DURATION_RE', 'LEGACY_KEY_NAMING', 'M', 'PUBLIC_SHOWS', 'ROOT', 'SONG_CANONICAL_OVERRIDE', 'SONG_MANUAL_MERGE', 'SOURCE_LABEL', 'TAG_VOCAB', 'WORKER', '_ARTIST_ORDER', '_duration_sec', 'added_sort_key', 'artist_name', 'check_orphan_song_dirs', 'check_rarity_drift', 'collect_songs', 'date_with_subtitle', 'esc', 'iso_duration', 'load_processing', 'sanitize_filename', 'show_city', 'show_title', 'show_url', 'show_zip_entries', 'show_zip_folder', 'singles_for_show', 'song_norm', 'song_slug', 'sort_key', 'stamp_added_dates', 'stream_url', 'track_total', 'validate']
