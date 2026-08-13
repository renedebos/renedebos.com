# Player consolidation

Status: proposal — not yet built. Mockup: https://claude.ai/code/artifact/71ae2166-d3ed-471d-9719-abd73fe353ba

## Problem

The site currently runs four independent audio players, each with its own
markup, its own `<audio>` element, and its own logic:

1. Show-page track rows (waveform via wavesurfer.js, peaks pre-computed)
2. The "Full Recording" whole-show player on show pages
3. `/playlist/` — curated multi-show queues
4. `/player/` — the popup player, reads a `#p=...` hash queue

They're coordinated only by a `BroadcastChannel('hannan-playback')` claim/pause
protocol (see `scripts/player.js`) so two don't play at once — that's cross-tab
conflict avoidance, not a shared component. Each has to be fixed/extended four
times for the same change.

## Proposal: one component, three densities

Same underlying component, rendered at three different sizes depending on
context — not three different implementations.

- **Compact (track row)** — replaces the tracklist player. Play/pause, title,
  thin waveform/progress, time, loudness pill, download, overflow menu.
- **Hero (full player)** — replaces "Full Recording" and the `/player/` popup.
  Full-width waveform, loudness control, repeat, share-timestamp, FLAC/MP3
  download.
- **Mini bar (persistent)** — replaces `/playlist/`'s queue player. Collapsed
  footer strip: play/pause, title, loudness pill, prev/next, expand.

Where each control lives:

| Control | Row | Hero | Mini bar |
|---|---|---|---|
| Play/pause | ✓ | ✓ | ✓ |
| Waveform seek | thin bar | full-width | — |
| Loudness pill | ✓ | ✓ | ✓ |
| Repeat | — | ✓ | — |
| Download | ✓ | ✓ | — |
| Prev/next | — | ✓ | ✓ |

## Loudness control

Not a remaster — a live, client-side gain stage with a limiter underneath it,
so it never touches the stored master and never clips.

- **Archive** (default) — plays the file exactly as mastered (currently −20
  LUFS target, per the archive-wide linear-normalization policy in the root
  `CLAUDE.md`).
- **Louder** / **Loudest** — a `GainNode` boost against a `DynamicsCompressorNode`
  configured as a brick-wall limiter (fast attack, hard knee, threshold near
  0 dBFS) so a boosted quiet track can't clip on playback.

This was motivated by a concrete data point: pushing the archive's on-disk
target from −20 to −19 would break the −1 dBTP ceiling on **116 of 680**
tracks currently hitting full target linearly (they'd need a reduced target
or transient-cap, same tradeoff already being managed show-by-show tonight).
A client-side control sidesteps that ceiling entirely instead of re-fighting
it per track. See the "why −19 On-disk doesn't work well" analysis in
conversation — worth re-deriving/recording here if this plan moves forward.

## Other functions (proposed)

- **Share timestamp** — copies a link that opens straight to the current
  second. Useful for pointing at something specific, e.g. a review-tier
  transient-cap flag moment.
- **Repeat** — restarts the current track on end instead of advancing the
  queue. Plain repeat-one, not a loop-region editor.
- **Keyboard shortcuts** — `space` play/pause, `←`/`→` seek ±5s, `↑`/`↓`
  next/prev in queue. Only worth doing once there's one component to bind
  them to.

**Explicitly rejected:**
- **Playback speed control** — doesn't apply to this archive (live acoustic
  recordings, not spoken word/lecture content).
- **Loop-region (drag-select a span to repeat)** — not useful for this
  use case; replaced by the simpler repeat-one above.

## Open question: sticky playback across page navigation

Consolidating the player does **not** by itself make playback survive
clicking to another page. The site is a static multi-page site
(`scripts/build.py` generates full separate HTML pages) — every internal
link is a full page load, which tears down all JS state including any
playing `<audio>` element. This is true of the *current* four-player setup
too; `BroadcastChannel` only coordinates pause-the-other-one across tabs, it
has never kept audio alive across a navigation.

To actually get "still playing when you click to another show page" needs
one of:
- Client-side navigation (intercept internal link clicks, fetch the new
  page, swap the DOM instead of a full reload).
- A persistent iframe/shell hosting the audio, with the rest of the page
  swapped around it.

Treating this as a **separate decision** from the player consolidation —
it's a real architectural change (partial SPA behavior) that deserves its
own explicit call, not something to smuggle in as a side effect of cleaning
up the player markup.

## Why one component is worth it regardless of the above

Even without solving sticky navigation, consolidating from four
implementations to one is a contained, self-justifying refactor: one set of
play/pause/seek/loudness/download logic to fix and extend instead of four.

## Next steps

- [ ] Codex review — log findings in `codex-review.md` in this folder
- [ ] Decide on sticky-navigation scope (in this plan or a separate one)
- [ ] Confirm loudness control default/options with real numbers (−20 / −16
      / −14 were illustrative in the mockup, not yet validated)
- [ ] Scope the actual implementation (which files: `scripts/player.js`,
      `scripts/site.css`, `scripts/home.css`, page generators in
      `scripts/sitegen/`)
