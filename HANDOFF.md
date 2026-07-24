# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-07-23 · **Branch:** `main` — everything below is committed & pushed, deploy verified live on renedebos.com itself (not just green Action).

> Reprocessed `mad-sweetwater-2000-02-17` to workflow v7 — a messier-than-usual
> run that surfaced a real content defect (not just a title drift), a
> duration-regression catch that worked as designed, and a stale-leftover
> bug in `publish_show.py` itself (local `out/`, not just R2/Drive). Also
> did a data-only triage of `mad-cafe-java-1999-09-09` as a dynamic-fallback
> remediation candidate, and permanently unblocked `rclone delete` for the
> agent.

## ✅ Done this session

### Reprocessed `mad-sweetwater-2000-02-17` to workflow v7 (commit `5e08c0d`)
Mad Hannans at the Sweetwater, previously on v2 processing (an old
pre-linear-preserving pass). 21 tracks, standard fades/clip-fixes in
Drive's `Tracks/` folder, `labels.txt` present.

**Real content defect, not a title drift:** the first `Tracks/` folder
Rene pointed at had track 14 exported as "There She Was" — but a
2026-07-06 Updates note already on record explained this exact mislabel:
it's actually "Butter," and back then the original transfer was missing
its opening chords, fixed by swapping in a complete version. The fresh
export's duration (3:02) was 25s shorter than the previously-published
correct one (3:27) — a strong signal the *old broken* transfer had
resurfaced in Drive, not the fix. Caught by cross-checking `git diff` on
the duration before publishing, not by the automated duration-regression
check (25s/12% shrink didn't cross its "under half" hard-stop threshold).
Rene confirmed he'd pointed at the wrong `Tracks/` folder, fixed it, and
a full redo (`prepare` → `publish`) picked up the corrected "Butter" file.

**Duration-regression check did its job on the redo:** the corrected
`Tracks/` folder's `prepare` run still had 4 tracks (15–18) truncated to
under 10 seconds — `check_duration_regression()` (added last session)
refused to proceed automatically, exactly as designed. Rene re-exported
those four; second `prepare` came back clean.

**New bug found in `publish_show.py` itself — stale local `out/` isn't
cleaned between retries.** Step 1 ("processing") skips re-encoding a
track if its output file already exists in `~/work/<slug>/out/` — a
speed optimization for resuming after a mid-publish failure. But it means
files from an *aborted* run (e.g. the original broken "14 There She
Was.flac", the typo'd "18 Angel from Montgomerey.flac") never get removed
from `out/` even after the *source* is fixed and re-run. Every retry's
`rclone copy out/ → R2` step re-uploads them right back to R2/Drive,
even immediately after manually deleting them there — looked exactly
like R2 list-consistency lag on first glance (deleted, confirmed clean,
reappeared with identical original timestamps) until checking `out/`
directly. Fixed by deleting the 4 stale files from local `out/`, not by
chasing phantom R2 caching. **Not patched in the script — still a trap
for the next mid-publish retry on any show.**

**Old-run orphans also found in Drive `Processed/`,** separate from this
session's mess: 6 files (3 track pairs) left over from the *original*
2026-06-29 v2 publish under different track numbers than the current
catalog (`18 Dysfunctional Guy`, `19 Baby`, `20 The Kiss - Da Da Da...`
vs. today's correct `19`/`20`/`21`). Cleaned up alongside the session's
own stale leftovers — `rclone check` now reports 0 differences, 42/42
files.

**Title drift, same pattern as `mad-sweetwater-2000-10-17` last session:**
`draft_tracks.py` derives titles from the fresh export's filenames, which
had drifted from archive convention on 3 tracks: "Hard Drinking " (trailing
space), "I Need a Dream" (should be "I Need a Lover"), "DaDaDa" (should be
"The Kiss / Da Da Da (Slave to an Angel)"). **Gotcha: these fixes got
silently reverted twice** by subsequent `draft_tracks` runs during the
redo cycle — each full `publish` re-invokes `draft_tracks`, which
re-derives from filenames every time, clobbering any manual title edit
made after a previous publish attempt. Titles weren't re-checked until
right before the final commit, which is where the reverts were caught.

Full runbook completed: R2 21/21 FLAC+MP3 MD5-verified (0 mismatches),
Drive `Processed/` content-verified (0 differences after orphan cleanup),
Updates note + Week twelve History bullet added (extended from
`mad-sweetwater-2000-10-17`'s entry into a two-show week), `build.py
--check` clean, committed, pushed, Action green, spot-checked the live
show page, updates feed, and history page directly on renedebos.com.

**Open item, not blocking:** track 14 "Butter"'s final duration (3:12)
still doesn't exactly match the pre-session published value (3:27) — 15s
closer than the broken version but not identical. Likely just a different
fade/tail length in the fresh export; worth Rene giving it a listen to
confirm the opening chords are there and nothing else got trimmed.

### `mad-cafe-java-1999-09-09` — data-only triage, no action taken
Rene asked whether this show (catalogued as artist **"mad"**, not
"jerry" — despite being on a folder Rene remembered as Jerry's; setlist
confirms Mad Hannans-era material) should be upgraded from workflow v1.
Sidecar analysis: 16 of 21 tracks (76%) have output true peak pinned at
≈−0.9 to −1.0 dBTP — the dynamic-fallback fingerprint validated against
the definitive `jerry-cafe-java-1999-03-25` audit in the
[[dynamic-fallback-remediation-roadmap]] memory. Presented reasons for
and against; **Rene has not given a go-ahead** — this was analysis only,
nothing pulled from Drive or touched in the repo.

### Permanently unblocked `rclone delete` for the agent
`.claude/settings.local.json`'s `permissions.deny` previously hard-blocked
`rclone delete/purge/sync/move` (alongside `rm -rf`/`rm -r`). After this
session's repeated stale-R2-object cleanups needed hand-holding Rene
through the exact commands each time, Rene asked to lift the block.
**Removed only `Bash(rclone delete:*)` from deny** — `purge`, `sync`, and
`move` (higher blast radius, bulk/mirror operations) are still hard-blocked,
as is `rm -rf`/`rm -r`. `rclone delete` now behaves like a normal
risky-but-approvable command instead of a silent refusal.

## Gotchas learned this session
- **`publish_show.py`'s local `out/` resume-cache isn't cleaned between
  retries of the same show.** If an early attempt produces wrong-named or
  broken files in `~/work/<slug>/out/`, deleting them from R2/Drive alone
  doesn't fix anything — the next `publish` retry's upload step re-copies
  everything currently sitting in `out/`, resurrecting the exact same
  stale objects with the exact same content. Symptom looks identical to
  R2 list-consistency lag (object reappears with unchanged original
  timestamp) — check local `out/` before assuming it's a storage-layer
  quirk. Fix: delete the stale files from local `out/` directly (plain
  `rm`, no `-r`/`-f` needed on individual files).
- **Every `publish` run re-invokes `draft_tracks.py`,** which re-derives
  titles from the current export's filenames every time — not just on
  first draft. A manual title fix applied to `recordings.json` after one
  `publish` attempt will be silently overwritten if a later retry
  (e.g. after fixing a stale-R2-object problem) re-runs `publish` and
  therefore `draft_tracks` again. Re-check flagged titles right before
  final commit, not just once mid-session.
- **A duration-regression check with a "shrank to under half" threshold
  won't catch every truncated re-export** — a 25s/12% shrink (Butter:
  3:27 → 3:02) sailed through `check_duration_regression()` even though
  it was the exact same class of bug (old broken transfer resurfacing)
  the check was built for last session. Cross-checking `git diff` on a
  track's duration against the pre-session published value is still
  worth doing by hand when a title's history has a known "missing
  content" precedent in the Updates feed.

## Durable facts (don't undo)
- `mad-sweetwater-2000-02-17` is now fully on workflow v7, R2/Drive both
  content-verified (0 mismatches / 0 differences).
- `Bash(rclone delete:*)` is no longer in `.claude/settings.local.json`'s
  deny list — don't re-add it without Rene asking. `purge`/`sync`/`move`
  remain denied; don't lift those without being asked.
- `publish_show.py`'s local `out/` resume-skip logic (step 1) is a known
  source of stale-file resurrection on any multi-attempt publish — not
  yet patched in the script itself. When a show needs more than one
  `publish` attempt, check `~/work/<slug>/out/` by eye for leftover
  wrong-named files before retrying, not just R2/Drive.
- `mad-cafe-java-1999-09-09` is a strong, data-backed candidate for the
  [[dynamic-fallback-remediation-roadmap]] (76% of tracks affected) but
  is **not approved to start** — analysis only, awaiting Rene's go-ahead,
  same status as the roadmap's other 20 shows.

## Reference
Full runbook: `CLAUDE.md` → "Publishing a Split Show". Owner's manual (all
tools, all four workflow phases, full version history): `PUBLISHING.md`
(also rendered at `/manual/`). Older phase-by-phase technical detail:
`AUDIO_PROCESSING.md`. Tag vocabulary: `TAGS.md`.
