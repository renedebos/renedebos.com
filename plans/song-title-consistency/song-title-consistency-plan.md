# Song title consistency: Feature Proposal

Status: proposal — not yet built.
Triggered by the 2026-08-13 archive-wide transient-cap force-cap batch, where
5 of 9 shows needed a manual title fix immediately after `publish` silently
overwrote an established spelling with a fresh export's filename.

## 1. Objective

Stop `draft_tracks.py` from silently overwriting established song titles with
whatever a fresh Drive export happens to be named, and make title corrections
actually propagate everywhere a title appears — the catalog, the archive-data
audit view, and (currently the gap) the filename a visitor downloads.

**Success criterion:** a scoped `publish` for a track whose fresh filename
differs only cosmetically from its established title (case, `/` vs `_`,
whitespace, a dropped article) never changes `recordings.json`; a filename
that looks like a genuine rename gets flagged for a human decision instead of
applied automatically; and `build.py` can catch a title that drifts from the
canonical spelling without a human having to notice by eye.

## 2. Proposed Architecture & System Design

### The problem today

Three separate gaps compound:

1. **The write path trusts the filename, unconditionally.**
   `scripts/draft_tracks.py:93` — `num, title = int(f[:2]), f[3:-5]` — takes
   the title straight from the output filename on disk every time a track is
   drafted, scoped or not. There is no comparison against the show's existing
   `old[num]["title"]` at all. (Tags at least attempt a cross-archive
   majority-vote merge in the same file — title doesn't even do that.)

2. **The check that *would* catch this exists, but isn't wired to the write.**
   `scripts/publish_show.py`'s `preflight_catalog_titles()` (with
   `catalog_title_lookup()`) already does the right comparison at `prepare`
   time: it flags when a fresh filename differs from the catalog title for
   that track number, and cross-references whether the fresh name is an
   established title used elsewhere in the archive. But it's print-only,
   informational, and runs in a different script than the one that actually
   writes `title` into `recordings.json`. Nothing connects the two.

3. **Matching is done by literal lowercase string comparison, duplicated in
   two places.** `draft_tracks.py`'s `song_key()` and `publish_show.py`'s
   `catalog_title_lookup()` are two independent, slightly different
   normalization functions. Neither collapses `/` vs `_`, so
   "Rocky Road to Dublin / Star of County Down" and "...  _ Star..." don't
   automatically register as the same title even though they're the same
   song under the site's own filename convention. There is no single
   canonical source of truth for "what is this song actually called" — only
   `core.py`'s one hardcoded alias entry ("Me and Eddie Vedder" → "Houses of
   the Holy") comes close, and it's a one-off, not a general mechanism.

There's a fourth, separate consequence worth naming even though it's not the
proximate cause: **a title correction in `recordings.json` never reaches what
a visitor actually downloads.** `worker/index.js`'s Content-Disposition
header builds the download filename from `file.split('/').pop()` — the raw
R2 object key's basename — not the catalog `title`. A visitor downloading
"Hear Me" today gets a file named `13 Lover.flac` on their computer, because
that's what the export happened to be named the day it was processed.

### Scale of the actual problem (real scan, not estimated)

A read-only scan of the current catalog (145 distinct songs across all
shows) found only **26 songs with more than one spelling on file**, and
nearly all of that is trivial noise a majority vote resolves safely:

- Capitalization drift: `Black is the Color` (5×) vs. `Black Is The Color`
  (1×) vs. `Black Is the Color` (1×) vs. `Black is The Color` (3×)
- Trailing whitespace: `Butter` (18×) vs. `Butter ` (1×)
- A dropped/added leading "The": `Crystal Rose` (5×) vs. `The Crystal Rose`
  (1×)

Only a couple of true three-way ties exist with no clear majority (e.g.
*That's the Way the World Goes Round*, three different capitalizations, one
occurrence each) — those need a 30-second human pick, not a review project.

This is a small, tractable fix, not an archive-wide cleanup effort.

### Proposed fix

- A single canonical title registry, `data/song-titles.json`: normalized key
  → canonical display spelling, bootstrapped from the current catalog by
  majority vote (ties flagged for Rene).
- A shared normalization/lookup module (new `scripts/song_titles.py`) used by
  **both** `draft_tracks.py` and `publish_show.py`, replacing their two
  independent, slightly-different implementations.
- `draft_tracks.py` changes from "always trust the filename" to "prefer the
  canonical entry when the filename differs only cosmetically; otherwise
  keep the old title and flag for review" — never silently overwrite.
- `build.py`'s existing integrity-check pass gets one more check: warn (don't
  fail) when a track's title doesn't normalize to its canonical entry —
  same severity precedent as the existing rarity-tag-drift warning (Rene's
  call, review don't auto-fix).

## 3. Technical Details

**Files in scope:** `scripts/draft_tracks.py`, `scripts/publish_show.py`
(`catalog_title_lookup()`, `preflight_catalog_titles()`), a new
`scripts/song_titles.py` shared module, `scripts/build.py`, and a new
`data/song-titles.json`. `worker/index.js` and its token-minting caller are
in scope only for the deferred piece in §3.4 below — not this pass.

### 3.1 Normalization function

Same normalization used for the scan above, moved into the shared module:

```python
QUALIFIER = re.compile(r"\s*\((incomplete|early version|cut|partial|reprise|
                          alt version|alt versions)[^)]*\)\s*$", re.IGNORECASE)

def normalize(title):
    t = QUALIFIER.sub("", title).strip()
    t = re.sub(r"^(the)\s+", "", t, flags=re.IGNORECASE)
    t = t.replace("_", "/")
    t = re.sub(r"\s*/\s*", "/", t)
    t = re.sub(r"[^\w/]+", " ", t)
    return re.sub(r"\s+", " ", t).strip().lower()
```

This intentionally does **not** collapse two textually-different real titles
(e.g. "Highway Patrolman" vs. "State Trooper" — two distinct, real Springsteen
songs, correctly never merged by this scheme). It only absorbs
capitalization, punctuation-as-separator, whitespace, a leading "The", and
the known qualifier suffixes. That's a deliberate boundary: normalization
closes cosmetic drift, it never resolves a genuine rename question — that
stays a human call, same as tonight's Highway Patrolman/State Trooper
decision.

### 3.2 `data/song-titles.json` schema

```json
{
  "black is the color": "Black is the Color",
  "rocky road to dublin/star of county down": "Rocky Road to Dublin / Star of County Down"
}
```

Bootstrap script: load `recordings.json`, group every track's title by
`normalize()`, pick the majority raw spelling per group (ties printed for a
manual pick), write the table. One-time script, not part of the regular
pipeline afterward — the table is then maintained incrementally as new songs
are added (see §5, open question on registration).

### 3.3 `draft_tracks.py` change

At the point title is currently set unconditionally from the filename:

- Normalize the filename-derived guess.
- If it matches a canonical entry, use the canonical spelling (fixes
  cosmetic drift automatically — the exact case that bit 5 of 9 shows
  tonight).
- If `old[num]["title"]` exists and its normalized form differs from the
  guess's normalized form (a real semantic difference, not just
  cosmetic), **keep the old title** and add it to the FLAG output instead of
  overwriting — matches the existing "human review gate" pattern already
  used for diagnose findings and review-tier transient-cap flags elsewhere
  in this pipeline.
- If there's no old title (genuinely new track) and no canonical match,
  behavior is unchanged from today: use the filename, flag as NEW.

### 3.4 Deferred: download filename (Content-Disposition)

Not part of this pass — flagged here so it isn't forgotten. Fixing the title
in `recordings.json` doesn't currently change what a visitor downloads,
because `worker/index.js` derives the Content-Disposition filename from the
raw R2 key basename, not the catalog title. The likely fix is to sign the
canonical title into the download token payload (alongside the existing
`${file}:${expires}` message) at mint time, and have the worker build the
header from that instead of the key. Touches the signed-token path across
two Cloudflare Workers deploys plus wherever the token is minted — treating
this as a separate, careful pass rather than bundling it into the title-table
work above.

## 4. Rejected / Out of Scope

- **Renaming the actual R2 objects to match canonical titles.** Visitors
  never see the R2 key directly except through Content-Disposition (§3.4
  fixes that without touching stored files), and renaming stored objects
  would complicate the MD5/fingerprint audit trail the resume-skip and
  dynamic-fallback campaigns depend on for staleness detection.
- **Hard-failing the build on a title/table mismatch.** Matches the existing
  rarity-tag-drift precedent — warn only, so a legitimately new song doesn't
  block a deploy just because it isn't in the table yet.
- **Automating genuine rename decisions.** Normalization only ever collapses
  cosmetic variation. Two different real titles (Highway Patrolman / State
  Trooper; Blarney Stone Blues / Leprechaun) will never be merged by this
  scheme and still need Rene's judgment, cross-referenced the same way
  `preflight_catalog_titles()` already does it.

## 5. Open Questions

- **Alias support:** should the table eventually support one canonical title
  with recognized aliases (the same shape as `core.py`'s one-off "Me and
  Eddie Vedder" → "Houses of the Holy" entry), or stay strictly
  one-normalized-key-to-one-title? An alias mechanism would subsume that
  hardcoded entry, but adds a bit of schema complexity for a case that's
  only occurred once so far.
- **Registration of new songs:** when a genuinely new song is drafted, does
  it get auto-added to `song-titles.json` at draft time, or does someone add
  it by hand as a deliberate step? Auto-adding is more convenient but risks
  locking in a typo as "canonical" on a track's very first appearance.
- **Escalation path:** should `build.py`'s warn-only check eventually become
  a hard fail once the table's been stable for a while, the same way the
  duration-regression check in `publish_show.py` already hard-blocks?
- **Timing of §3.4** (download filename): same batch, or a genuinely separate
  follow-up given it touches signed tokens?

## 6. Implementation Steps

- [ ] Write `scripts/song_titles.py` (normalize function + table load/lookup)
- [ ] Write the one-time bootstrap script, generate `data/song-titles.json`
      from the current catalog
- [ ] Resolve the handful of true ties (no clear majority) — quick picks
- [ ] Update `draft_tracks.py` to consult the shared module: auto-correct
      cosmetic drift, flag-and-keep on real drift, unchanged behavior for
      genuinely new tracks
- [ ] Update `publish_show.py`'s `preflight_catalog_titles()` /
      `catalog_title_lookup()` to use the same shared module, removing the
      duplicate matching logic
- [ ] Add the warn-only title/table check to `build.py`'s integrity pass
- [ ] Test: dry-run a scoped publish against one real show with a known
      cosmetic-drift track, confirm the title is preserved; run full
      `build.py --check`
- [ ] (Deferred, separate pass) §3.4 — sign canonical title into the
      download token, update `worker/index.js`'s Content-Disposition to use
      it instead of the R2 key basename
