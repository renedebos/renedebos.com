# Tag Vocabulary

> **STATUS: approved by Rene 2026-07-07** (full 20-tag vocabulary; Claude
> drafts tags across the existing catalog, Rene reviews and corrects).
> `beatles` added, `singalong` retired 2026-07-16 (net unchanged, 20 tags).
> `story` retired 2026-07-18 (19 tags).

Controlled vocabulary for the per-track `tags` array in
`data/recordings.json`, powering the playlist generator facets
(see `PLAYLIST FEATURE.md`) and site search. Tags are applied at publish
time — step 5 (metadata) of the publishing runbook — and flow into
`assets/tracks.json` automatically at build.

## Two dimensions

**1. `songwriter` field (per track, free text).** Who wrote the song —
a dedicated field, not a tag (changed 2026-07-07; the old attribution tags
like `John Prine`/`Irish` were migrated into it and removed from `tags`):
- Hannan originals → `Jerry Hannan & Sean Hannan`
- covers → the writer/act: `John Prine`, `Bruce Springsteen`, `Paddy Nash`, …
- trad/public-domain → `Traditional`
- unknown provenance → field absent
Searchable on /search/ (shown as a chip on covers/trad; suppressed for the
Hannan default) and a playlist facet via `tracks.json`. Editable in the
metadata editor's Songwriter column.

**2. Playlist tags (controlled, max ~20).** Lowercase, kebab-case, from the
fixed list below. Anything not on the list is a schema error. The provenance
tags stay even though `songwriter` often implies them — a song can be a
known cover with an unknown writer.

## Controlled vocabulary

### Provenance — largely derivable, applied mechanically
| tag | meaning |
|---|---|
| `original` | Hannan-written song |
| `cover` | someone else's song (writer in `songwriter` when known) |
| `traditional` | trad/public-domain, mostly Irish repertoire |

### Mood / energy — needs human judgment
| tag | meaning |
|---|---|
| `ballad` | slow, tender, quiet |
| `upbeat` | mid/up-tempo, feel-good |
| `rocker` | loud, driving, full-band energy |

### Flavor — needs human judgment
| tag | meaning |
|---|---|
| `irish` | Irish character (trad or original) |
| `folk` | acoustic singer-songwriter feel |
| `country` | country/Americana feel |
| `blues` | blues feel |
| `rock` | rock feel (Mad Hannans default territory) |
| `beatles` | Beatles cover (repertoire flavor, alongside the `songwriter` credit) |

### Content / format — mostly objective
| tag | meaning |
|---|---|
| `instrumental` | no vocals |
| `medley` | multiple songs in one track |
| `banter` | stage talk / crowd work is a highlight of the track |
| `guest` | guest performer features (also see `performer` field) |
| `improv` | made up on the spot / jam |

### Curated picks — Rene's call
| tag | meaning |
|---|---|
| `favorite` | crowd/family favorite, best-of material |
| `rarity` | played once or almost never (derivable: 1 occurrence in songs matrix) |

## Rules

- Tags live on the track object in `data/recordings.json` (`tags: [...]`);
  the writer goes in the sibling `songwriter` field, never in `tags`.
- Apply as many as fit; no minimum. An untagged track is fine.
- Don't tag what a facet already covers: artist, venue, date, and AUD/SBD
  are separate fields — never tags.
- New vocabulary entries require editing this file first; keep the list ≤ ~20.
