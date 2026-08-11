# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-10 · **Branch:** `main` — everything below is committed,
pushed, and **live** (`fc244d8`), deploy green and spot-checked on
renedebos.com itself.

> **The archive-wide v2→v8 rollout is complete**, and this session added a
> faster mechanism for the remaining opt-in work: **scoped, per-track
> publishing**. Twelve shows now carry v8 in some form; the twelfth
> (`jerry-19-broadway-1999-06-07`) is the first ever processed with
> `--tracks`, touching only the 12 of 29 songs that actually needed the cap
> and leaving the other 17 completely untouched. An archive-wide scan
> (`tcap_ui.py`'s `/api/scan`) found **98 candidate tracks across 17 shows**
> total — this session shipped the first show; 16 remain on the worklist,
> not yet started.

## ✅ Done this session

### New: `rename-track` command — replaces manual fingerprint surgery
`python3 scripts/publish_show.py rename-track <slug> --track-num N --new-title
"..."` renames a track's file across `tracks/`, `out/`, and the
`.flac.v8state.json` sidecar, then updates `publish.json`'s manifest and
recomputes its fingerprint using the exact same hash `publish`'s own check
uses. Previously a `TITLE CHANGED` correction meant hand-editing
`publish.json`'s JSON via the Edit tool as a workaround — fragile, and the
direct cause of the "wrong filename → aborted publish → wasted render cycle"
pattern flagged repeatedly last session. Worked flawlessly on its first real
production use (`jerry-19-broadway-1999-06-07` track 27, "A Bunch of Thyme").

### New: `--tracks` scoped publishing — proven on real production data
`python3 scripts/publish_show.py publish <slug> --tracks 3,7,14` renders,
uploads, verifies, and Drive-backs-up **only** the listed track numbers,
leaving every other track's R2 object, catalog entry, and Drive backup
untouched. Still requires a full `prepare` (and its diagnose review) first —
only the render/upload/draft/backup stage is scoped. Built because most
shows on the worklist have only a handful of genuine transient-cap
candidates; reprocessing all 29+ tracks for the sake of 12 was pure waste.

Companion change in `draft_tracks.py --tracks N,M,...`: scoped merge mode
that only touches the specified track numbers in the existing `tracks[]`
array (errors loudly if a requested track has no matching output file,
rather than silently dropping it).

**First real-world run — `jerry-19-broadway-1999-06-07` (v5→v8, scoped):**
12 of 29 tracks reprocessed (1, 6, 11, 12, 15, 16, 17, 18, 22, 23, 26, 29);
17 left completely untouched, verified independently via `git diff` (only 7
minimal hunks) and via `gen_peaks.py`'s own log (`(local)` for touched
tracks, `(r2)` for the rest). R2 verify passed 29/29 with zero mismatches.
Tracks 6 and 15 were forced past their automatic decline (`--transient-cap-
force`) at Rene's request; 5 review-tier tracks (12, 17, 22, 26, 29)
confirmed by ear before shipping. Track 27's title corrected to "A Bunch of
Thyme" via the new `rename-track` command — no reprocess needed, it was
already at target.

### Fixed a genuine pre-existing bug found during spot-check
Live-checking the `jerry-19-broadway-1999-06-07` ship turned up that track
27's download links still read "Come On All You Young Maidens" despite the
page correctly showing "A Bunch of Thyme." Traced via `git show
81c2631:data/recordings.json` to the *original* v5 publish (R2 objects dated
2026-07-14) — the `title` field was always right, only the underlying
`file`/`flac` R2 object paths were wrong, unrelated to anything from this
session. Fixed: `rclone copyto` on both R2 and Drive `Processed/` to the
correct filename (FLAC + MP3), `recordings.json` updated, rebuilt, shipped
as `fc244d8`, verified live (`download="27 A Bunch of Thyme.flac"`, zero
hits for the old title).

**Still outstanding — Rene's manual cleanup** (agent-blocked, `rclone
delete`):
```
rclone delete "r2:hannan-audio/FLAC/JerryHannan - 19 Broadway 1999-06-07/27 Come On All You Young Maidens.flac"
rclone delete "r2:hannan-audio/MP3/JerryHannan - 19 Broadway 1999-06-07/27 Come On All You Young Maidens.mp3"
rclone delete "gdrive:DAT Tapes/Work Folder/JerryHannan - 19 Broadway 1999-06-07/Processed/27 Come On All You Young Maidens.flac"
rclone delete "gdrive:DAT Tapes/Work Folder/JerryHannan - 19 Broadway 1999-06-07/Processed/27 Come On All You Young Maidens.mp3"
```

### PUBLISHING.md brought current with workflow v8
Was still describing v7 as current. Added the v8 row to the version table,
a full "sparse-transient cap" prose section mirroring
`WORKFLOW_VERSIONS[8]`, and the previously-missing "Sparse-transient cap"
option in the loudness-normalization walkthrough. **Caused a real deploy
outage while fixing this** — see gotcha below.

### CLAUDE.md corrections
- Documented `scripts/tcap_ui.py` (port 8769) as the real local control
  panel for the v8 runbook — see the "wrong claim" gotcha below for why
  this was overdue.
- Documented `--tracks` scoped publishing.
- Added the "cross-reference every `TITLE CHANGED` flag, then run
  `rename-track` immediately, before the first `publish` call" rule,
  replacing the old "rename the file by hand" workaround note.

## 🔜 Next session

### 1. Sixteen shows still on the transient-cap worklist
The archive-wide scan found 98 candidate tracks across 17 shows total; only
`jerry-19-broadway-1999-06-07` (12 tracks) has shipped via the new
`--tracks` workflow. Highest-priority remaining, per the last scan:
`sean-19-broadway-2000-01-24` (v6, 10 candidates, worst gap −25.04),
`jerry-19-broadway-1999-10-25` (v5, 10 candidates, worst −25.01),
`jerry-cafe-java-1999-03-25` (v5, 10 candidates, worst −24.76), plus others
not yet re-enumerated since today's ship changed the totals. Same runbook:
`prepare` → diagnose review → `tcap_ui.py` analyze or manual plan preview →
Rene confirms review-tier tracks by ear → `publish --tracks ...` → metadata
→ build → ship. Not started — no explicit request yet to continue down the
list.

### 2. `jerry-19-broadway-1999-06-07`'s stray R2/Drive objects
See the exact `rclone delete` commands above — Rene's manual step whenever
convenient, not urgent (not live-facing).

### 3. Louder-playback derivative — researched 2026-08-09, still deferred
Carried unchanged from prior sessions. A stored −16 LUFS derivative would
need sustained limiting on ~87% of the archive's tracks (median 4.7 dB
reduction needed) — same unproven territory as `drum-control`, no A/B
evidence. Recommended direction instead: a client-side Web Audio
gain+compressor "Louder playback" toggle applied only at playback time,
nothing written back to any file. Not started; see prior HANDOFF revisions
for the full three-step plan if picked up.

### 4. "Blind Man" gap on jerry-19-broadway-1999-02-01 — needs a future Audacity look
Track 10 has a real, un-fixable-by-processing gap around 3:10. Shipped
as-is with `dropouts: true` and a show-page note. A manual Audacity
patch/crossfade would be a fresh hand-edit + re-export + reprocess if Rene
ever wants to attempt it.

### 5. Everything else carried from before, still true
- Consider a `build_archive_zip.py` refresh once a batch of shows accumulates.
- Drive `Processed/` hygiene worth checking on every reprocess (not just
  title-correction ones) — a prior show turned up 30 stale old-named MP3s
  with no title-change trigger at all.
- `drum-control` (codex-notes.md proposal) deliberately **not built** —
  needs its own decision + A/B evidence.
- `/search/` index preload double-fetch check, still unverified, low priority.

## Gotchas learned this session
- **Editing `PUBLISHING.md` without rebuilding breaks the deploy gate, and
  the breakage can hide for hours.** `PUBLISHING.md` is a *source* file
  rendered into the public `/manual/` page by `build_manual()` — CI's
  "Verify committed site is current" check fails if the generated HTML in
  the repo doesn't match a fresh `build.py` run. My edit (`5c7f93d`) skipped
  the rebuild, which broke deploys for 5 consecutive commits (including one
  of Rene's own unrelated pushes) across ~1.5 hours, until Rene's own commit
  (`81c2631`) fixed it. Root cause fully owned; going forward, run
  `build.py` and check `gh run list` after every push, not just ones that
  look content-related.
- **A wrong claim about tooling should be caught by searching before
  asserting, not corrected after Rene pushes back.** Told Rene "no UI exists
  for transient-cap processing" and started the wrong server (`ab_server.py`
  instead of `tcap_ui.py`) — a real control panel Rene had specifically
  described building. CLAUDE.md never mentioned `tcap_ui.py` at all, which
  is why the search missed it; documented it there now so this can't repeat
  the same way twice.
- **A concurrent `make edit` session can land changes mid-task that look
  like scope creep but aren't.** Found an unexpected uncommitted edit to a
  *different* show's track while a scoped publish was running; traced it to
  an active `edit_metadata.py --no-open` process via `ps aux`, confirmed
  with Rene before committing anything, then separated his edit from mine
  with `git add -p` rather than bundling them.
- **Sandbox tests of repo-relative scripts can still write into the real
  repo.** `publish_show.py`/`draft_tracks.py` respect `HOME` overrides for
  `~/work`, but `audio_process.py`'s `ROOT` resolves from the script's own
  file location, not `HOME` — a test run stubbing `rclone` still wrote a
  stray `data/processing/testshow.json` into the actual repo. Caught via
  `git status --short` immediately; removed before proceeding. Any future
  sandboxed test of these scripts needs to check for this class of leak
  explicitly, not just trust the `HOME` override.

## Durable facts (don't undo)
- **v8 now covers twelve shows** (eleven whole-show ships plus
  `jerry-19-broadway-1999-06-07`'s scoped ship). Version-bump discipline
  (any cap threshold/semantics change = v9) is binding.
- **`--tracks` scoped publishing is now a first-class path**, not a
  one-off experiment — use it by default when a show's candidate list is a
  small fraction of its total tracks. Still requires the full unscoped
  `prepare`/diagnose gate; only the render/upload/draft/backup stage scopes.
- **`rename-track` replaces all manual `publish.json` fingerprint editing.**
  Never hand-edit that file's manifest/fingerprint again — use the command.
- **Linear-normalization policy, as amended for v8** (see `CLAUDE.md`):
  loudnorm/ebur128 are measurement-only since workflow v6; gain is always
  applied via a plain `volume` filter; a millisecond-scale transient cap is
  sanctioned (opt-in, tiered gates, 6 dB hard ceiling on actual attenuation,
  full listening-evidence trail); sustained/dense limiting of repeatedly-
  loud material is still banned with no exceptions and no evidence exists
  for it.
- Modes stay exclusive — no stacking applause-limiter + cap without a new
  decision and listening evidence.
- `updates[]` is a dated changelog and should read as historically accurate
  to what was true *at the time* — don't retroactively rewrite entries to
  match a later wording standard.
- **Any edit to `PUBLISHING.md` requires `python3 scripts/build.py` before
  commit** — it's a source file for the generated `/manual/` page, not
  documentation-only.
- **`rclone delete` is hard-blocked for the agent** — every deletion must
  go to Rene as exact copy-paste commands.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (+ the amended
linear-normalization section covering v8, and the new `rename-track`/
`--tracks` documentation). Full prose walkthrough: `PUBLISHING.md` (rendered
to `/manual/` — rebuild after editing). Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. External review scratchpad:
`codex-notes.md` (untracked, not Rene's notes — verify before acting; also
where the `drum-control` proposal lives).
