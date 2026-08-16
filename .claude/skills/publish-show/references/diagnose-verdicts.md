# Reading the prepare diagnose

`prepare` runs the **full** diagnose on every track (the old clip-only mode
is retired) and then stops. Nothing has rendered or uploaded yet, so this is
the cheapest possible place to catch a problem — and the last one where
fixing it costs only Rene's time in Audacity rather than an R2 cleanup.

## Hard-block categories

`publish` refuses to run while any of these is unresolved. From
`DIAGNOSTIC_HARD_BLOCK` in `scripts/publish_show.py`:

| Verdict | What the engine saw | Normal response |
|---|---|---|
| `CLIPPING` | Likely-audible clipping | Back to Rene — review/declip in Audacity |
| `DROPOUT` | Identical-sample run(s) mid-track | Back to Rene — usually a bad export or a damaged source |
| `BALANCE` | L/R RMS differs materially | Back to Rene — check the source and the export |
| `PHASE` | Side energy above mid — channels may be out of phase | Back to Rene — often a source-tape or capture issue |

These are *confirmed defect* verdicts, which is why they block rather than
warn. `benign` and `minor` findings, and mild residual clipping, publish
as-is.

### The per-finding override

```bash
python3 scripts/publish_show.py publish <slug> --accept-diagnostic 12:CLIPPING
```

Marks one specific finding on one specific track as reviewed and accepted.
Accepted findings are recorded in `publish.json`, so a later publish against
the same prepared state doesn't need the flag repeated.

This exists for the case where a human listened and judged the finding
acceptable — a bit of residual clipping on a source tape that was always
like that, for instance. It is deliberately per-finding and never a global
bypass. If you find yourself reaching for it to make an inconvenient verdict
go away, that's the signal to hand the track back to Rene instead.

## Informational

**`HIGH_LRA`** — loudness range is very wide. For an acoustic live archive
that's usually the recording being *good*, not broken. Note it and move on.

## `PRED_TP` — not informational

> `PRED_TP: <file> — predicted <n> dBTP > -1 at <target>`

The gain needed to reach the show target would push true peak past the
−1 dBTP ceiling. This is exactly the condition where `loudnorm` would
silently switch to dynamic, frame-adaptive normalization and flatten the
track's dynamics.

The engine already handles it: it computes the track's own safe maximum
linear target (`I - TP - 1`) and processes at *that* instead, landing a few
dB below the show's nominal target but staying linear. Since workflow v6 the
render is a plain `volume` filter, so a hidden dynamic-mode render isn't
possible in principle.

So `PRED_TP` doesn't need action — but it does need understanding. A track
that lands quieter than nominal on a `PRED_TP` flag is the system working
correctly, not a defect to chase. Don't "fix" it by raising the target.

## `TITLE CHANGED`

> ⚠ TITLE CHANGED vs. the published catalog

The fresh export's filename differs from what the catalog has. This is the
one flag where the right answer genuinely can't be automated, because both
possibilities are common:

- **A typo in the fresh export** → keep the established spelling.
- **A real correction** Rene made deliberately → take the new one, and
  expect it to ripple into song pages and the catalog.

**Cross-reference every prior appearance of that title anywhere in the
archive**, not just the fresh filename against this one show's entry. A
title that appears three times spelled one way and once the new way is a
different situation from one that appears once each way.

Once the call is "keep the established spelling," run `rename-track`
immediately — before the first `publish`. See SKILL.md for why `mv` doesn't
work here.

## Duration drift

`prepare` also refuses when a fresh export is far shorter than the currently
published version, on the theory that a truncated export is far more likely
than an intentional re-edit that removes minutes of music.
`--allow-duration-drift` overrides it — only after confirming with Rene that
the shorter version is a genuine intentional re-edit.
