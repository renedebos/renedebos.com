# Player consolidation mockup: Codex review

Status: review of `player-consolidation-mockup.html` (the static concept
artifact, not the revised plan).

## Summary

The visual direction is strong and matches the site's actual colors,
typography, and tokens well. The three-density concept reads clearly. The
mockup is stale relative to the revised plan in a few places, mainly the
navigation-persistence claim.

## Findings

1. The mini-bar copy says it "survives navigation" and implies `/player/` is
   no longer needed. A static footer cannot survive a full-page navigation.
   The revised plan correctly preserves the popup and treats site-wide
   persistence as a separate decision.
2. −20/−16/−14 LUFS as UI labels is misleading — a fixed gain doesn't
   guarantee those output loudness values. Prefer Archive/Louder/Loudest as
   the primary label, optionally showing +4 dB/+6 dB rather than absolute
   LUFS.
3. The compact row will likely overflow on narrow phones — play button,
   metadata, time, loudness pill, and download button leave almost no room
   for the waveform. Needs the current site's two-line mobile arrangement.
4. Several interactive elements are non-semantic `<span>`/`<div>` (loudness
   pill, loudness choices, Repeat, FLAC, MP3). Production needs real
   buttons, keyboard support, focus behavior, ARIA state.
5. The hero is labeled "Full Recording view" but shows a single 3-minute
   song — should show two concrete variants: a standalone whole-show
   recording (no prev/next) and a queued track (with prev/next and queue
   context).
6. The hero has both a download icon and FLAC/MP3 chips — two competing
   download affordances. Should be one format menu.
7. Prev/next is described as a hero control but absent from the hero
   mockup.
8. The compact description mentions an overflow menu; none is shown.
9. Existing playlist-add controls and track condition badges are missing
   from the compact row.
10. Play/pause visual toggles don't update their accessible labels;
    inactive rows dimmed to 55% opacity is too low if that treatment
    reaches production.

The mockup itself is safe as a static prototype — no network requests,
`innerHTML` use limited to generated waveform rectangles and fixed SVG.
Embedded fonts account for most of the 160 KB file size; production should
keep using the existing shared font assets, not embed them.

## Verdict

Keep the visual language; treat as a concept board, not implementation-ready
markup. The biggest correction is removing the false navigation-persistence
promise.
