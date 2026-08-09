# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-08 · **Branch:** `main` — everything below is committed,
pushed, and **live** (`086ab8b`…`7c4d5f3`), deploy green and spot-checked on
renedebos.com itself.

> Built, hardened, and **shipped workflow v8 — `sparse-transient-cap`** on its
> first real show: **`mad-cafe-java-1999-09-09`**. Also fixed a real
> performance bug in the publish pipeline (waveform peaks were re-downloading
> every track from R2 instead of reading the local render), and worked around
> a bad home-network stretch that stalled two separate steps. **The R2 MD5
> verify was re-run and passed clean the following session (22/22, 0
> mismatches) — the show is now fully confirmed end-to-end, nothing
> outstanding on it.** `~/work/mad-cafe-java-1999-09-09/` has been deleted.

## ✅ Done this session

### Workflow v8 — sparse-transient-cap (built, hardened, then shipped)
Same overall design as before (see prior HANDOFF text / `WORKFLOW_VERSIONS[8]`
in `audio_process.py` for the full technical record: chain, 6 dB
attenuation-based cap, tiered eligibility gates, guardrails, per-track
override vocabulary). What's new this session is that it actually shipped:

- **`mad-cafe-java-1999-09-09` is now the first show carrying v8 in
  production.** 15 of 22 tracks reached the full −20 LUFS target via the
  transient cap; **Rocky Road to Dublin / Star of County Down** hit the 6 dB
  attenuation ceiling and landed at −21.6 (Rene's explicit
  `--transient-cap-partial` call); **Truck** and **Anna May** are unaffected —
  both correctly stayed on the applause-limiter (v5), which still takes
  precedence over the cap.
- Three track titles corrected to the archive's established spelling on the
  way through draft_tracks' FLAG review: "ABC (alt version)" (was drafted as
  "ABC (Alt Versions)"), "Rocky Road to Dublin / Star of County Down" and
  "The Kiss / Da Da Da (Slave to an Angel)" (both were drafted with `_`
  instead of `/`, an artifact of `/` not being legal in a filename).
- `updates[]` entry + a new `history.html` week ("Week fourteen") written for
  this pass; `/process/`'s public "linear gain only" claim still needs the
  caveat sentence for the cap mode — **not done yet, next session**.

### Real bug fix: waveform peaks were re-downloading from R2 every publish
`gen_peaks.py` always streamed each track fresh from R2 via `rclone cat`,
even though `publish_show.py` still has the just-rendered files sitting
locally in `out/` at that point in the pipeline. That made the peaks step
(step 4/7) the slowest part of every publish for no reason. Fixed:
`gen_peaks.py --local DIR` decodes straight from local files, and
`publish_show.py` now passes `--local out` automatically. Confirmed on this
run: all 22 tracks' peaks generated from local files in seconds, vs. the
original run that was still crawling through R2 downloads after several
minutes.

### A bad network stretch stalled two unrelated steps — diagnosed, not a code bug
Partway through publish, `rclone cat` throughput to R2 collapsed to
15–30 KB/s (confirmed via `rclone -vv --stats`, a plain `curl` against an
unrelated OVH test file showing the identical pattern, clean pings, no
competing local processes) — a real network/link problem, not an R2 or
rclone issue, and **not a Cloudflare permissions issue** (permissions
failures are instant 403s, not slow-but-real data flow; `rclone lsl`
resolved and authenticated fine throughout). Handled by:
1. Killing and relaunching the publish twice — the resume logic (mtime-based
   skip in `audio_process.py`, MD5-matched) made each restart cheap since
   nothing actually needed re-rendering.
2. **Skipping R2 verify and Drive backup for this run rather than waiting on
   a degraded link** (Rene's call) — nothing about the live site depends on
   either step; both are integrity/backup-only.
3. **Rene did the Drive `Processed/` backup by hand** (dragged FLAC + MP3 +
   `processing_report.txt` into Drive). Confirmed content-correct afterward
   with the pipeline's own check (`drive_backup_matches()` — `rclone check`
   hashes, not just a file count) — **matched, step 6 is done.**
4. **R2 MD5 verify (step 5)** was left running in the background at
   shutdown, got killed with the machine, and was **re-run clean the
   following session**: `python3 scripts/audio_process.py verify
   mad-cafe-java-1999-09-09` → 22 track(s) checked, 0 mismatch(es). Show
   fully confirmed.

### Local cleanup
- `git gc` on `renedebos.com`: `.git` was 215M (mostly loose, unpacked
  objects — normal accumulation, nothing wrong), now 5.6M packed. No history
  lost, purely a repack. Repo total 236M → ~26M.
- Rene cleared `~/gdrive-mount/MadHannans - Cafe Java 1999-09-09/` (4.3G) by
  hand — confirmed that path was a plain local directory, **not** a live
  Drive mount (nothing in `mount`, no `rclone mount` process), so this only
  freed local disk, no Drive risk.
- Rene deleted the 8 one-off A/B scratch folders from `~/work/`
  (`sweetwater-transient-ab`, `tcap-test`, `kiss-ab`, `rocky-road-ab`, `ab`,
  `hearme-ab`, `plastic-lemons-ab`, `cafe-java-spikes` — ~3.5G). **Kept**:
  `~/work/tcap-ui/` (56K, the control panel's real persisted decision/
  analysis state, not scratch), `~/work/song-concordance/` (56K, unrelated
  small tool, left alone). `~/work/mad-cafe-java-1999-09-09/` (2.0G) was
  deleted the following session once verify passed clean — `~/work/` is now
  just 112K.

## 🔜 Next session
1. **Add the caveat sentence to `/process/`'s "linear gain only" claim** —
   now genuinely overdue, since a capped show is live and the public page
   currently doesn't mention it.
2. Consider a `build_archive_zip.py` refresh (optional, unrelated, whenever
   there's a batch of shipped shows to fold in).
3. **Version-bump discipline is now binding** — v8 has a published track.
   Any further change to cap thresholds/semantics from here is v9, not a
   revision of v8.

## ⚠️ Open items (carried, still true)
- `/search/` index preload double-fetch check, still unverified (DevTools →
  Network, exactly one `search-index.json` request).
- `publish_show`'s local `out/` resume-skip can resurrect stale files on
  multi-attempt publishes (`tracks/` is fingerprint-guarded; `out/` relies on
  mtime + the tcap `.v8state.json`); every publish re-invokes draft_tracks
  and clobbers manual title fixes (this session's title FLAGs had to be
  re-checked/re-fixed after each resumed run, for exactly this reason); CSP
  `unsafe-inline` known/unscoped; don't re-open caching/JSON-size.
- `drum-control` (codex-notes.md proposal, for repeatedly-loud material like
  a dominant snare) is deliberately **not built** — needs its own decision +
  A/B evidence if it ever happens. Truck stays applause-limited regardless.

## Gotchas learned this session
- **`rclone` against R2 can genuinely stall/crawl**, same class of problem
  CLAUDE.md already documents for `gdrive:`. Diagnose with `rclone -vv
  --stats 3s` before assuming a code bug — check throughput against an
  unrelated host too (rules out R2 specifically) and check for 403s (rules
  out permissions; auth failures are instant, not slow).
- **The publish pipeline's local `out/` dir is a legitimate source for
  anything that would otherwise re-fetch from R2** right after upload — the
  bytes are identical, and it's kept on disk until the show ships. Peaks
  generation was the one place still ignoring this.
- **Draft_tracks' title auto-derivation is trustworthy but not infallible**:
  cross-checking its 4 FLAGs this run against every prior appearance of each
  title in `recordings.json` confirmed 3 of 4 exactly, but caught a title
  drift twice — filenames can't contain `/`, so multi-song medley titles
  round-trip through local export as `_`-separated and need restoring by
  hand; also caught an "Alt Versions" plural vs. the archive's established
  singular "(alt version)".
- **`~/gdrive-mount` on this Chromebook Linux (Crostini) environment is not
  actually a live Drive mount most of the time** — check `mount` /
  `rclone mount` process before assuming deleting from it touches real Drive
  content.

## Durable facts (don't undo)
- **v8 has a published track now** — `mad-cafe-java-1999-09-09`. Version-bump
  discipline (any cap threshold/semantics change = v9) is binding from here.
- **Five Rene decisions from the build (still policy):** (1) cap approved on
  two-show A/B evidence; (2) 6 dB = actual limiter attenuation, not loudness
  recovered; (3) partial capping = per-track opt-in only, never automatic;
  (4) tiered eligibility gates (auto ≤2%/1%/0.2s, review ≤5%/2%/0.5s beyond
  that declined); (5) force = after-listening override. All encoded in
  `audio_process.py` + `CLAUDE.md` + `WORKFLOW_VERSIONS[8]`.
- Modes stay exclusive — no stacking applause-limiter + cap without a new
  decision and listening evidence.
- The control panel (`make tcap`, 8769) is the intended flow for cap-era
  reprocesses, but the engine's own gates are the real safety barrier —
  terminal and panel are equivalent, panel is just more convenient.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (+ the amended
linear-normalization section covering v8). Panel: `make tcap` (8769). A/B
tooling: `scripts/ab_compare.py` / `ab_server.py`. Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. External review scratchpad:
`codex-notes.md` (untracked, not Rene's notes — verify before acting).
