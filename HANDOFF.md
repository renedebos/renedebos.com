# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-11 → 2026-08-12 · **Branch:** `main` — everything through
`9594b9e` is committed, pushed, and **live**, deploy green and spot-checked
on renedebos.com itself. Since then, six audio-pipeline bug fixes have been
made (see below) and are **uncommitted, sitting in the working tree for
Rene's review** — `git status` currently shows `audio_process.py`,
`make_stream_mp3.py`, `publish_show.py`, `PUBLISHING.md`, and this file
modified, plus the always-untracked `codex-notes.md`.

> ⚠️ **Data loss incident tonight — read this before touching
> `jerry-cafe-java-1999-06-17` again.** Rene spent real time hand-editing
> fade in/out on all 27 tracks of this show (opening each FLAC directly in
> Audacity from `~/work/jerry-cafe-java-1999-06-17/tracks/`, applying
> Studio Fade Out + Fade In, exporting back to the same filename). I
> misread his "work folder, tracks subfolder" as the **Drive** Work Folder
> and re-ran `publish_show.py prepare`, which hard-deletes
> (`shutil.rmtree`) and re-fetches that exact local directory from Drive.
> His edits — confirmed via `~/.local/share/audacity/lastlog.txt`,
> finishing ~10:07 PM — were wiped and replaced with the stale un-edited
> originals about 12 minutes later. **No recovery path exists** for the
> fade edits themselves (hard delete, no trash). Rene is redoing the work
> tomorrow. **Do not run `prepare` on a show that already has a local
> `~/work/<slug>/tracks/` staging directory without first checking that
> directory's file mtimes for recent, unbacked-up edits** — see
> `feedback_prepare_wipes_local_staging.md` in memory for the full writeup
> and the disambiguation rule (Drive "Work Folder" vs. local `~/work/`
> staging dir — both get called "work folder" in conversation, they are
> not the same thing).

## ✅ Done this session (2026-08-11)

### Three more dynamic-fallback shows shipped, full v8
Continuing the dynamic-fallback bug fix started earlier in the day
(see prior handoff for the bug's discovery/audit — ffmpeg's `loudnorm`
silently falling back to dynamic normalization on some v≤5 tracks).

- **`jerry-cafe-java-1999-03-25`** — finished the `--tracks`-scoped
  reprocess left in progress from earlier (10 of 21 tracks: 7
  sparse-transient-cap, 3 applause-limiter). Commit `713d0a8`.
- **`jerry-cafe-java-1999-04-29`** — full 21-track v8 reprocess (6
  sparse-transient-cap, 6 linear-reduced, 9 linear). Two title corrections:
  track 13 "Good Life"→"The Good Life", track 21 briefly flip-flopped
  between "Leprechaun" and "The Blarney Stone Blues" before Rene confirmed
  "Leprechaun" was his own earlier mistake — kept "The Blarney Stone
  Blues". Also caught and fixed `draft_tracks` silently dropping the
  `guest` tag from track 10 ("Father and Son," ft. Demir) — see the
  `draft_tracks` bug note below. Commits `ea89b4e` (show) + `74e558b`
  (rclone permission, see below).
- **`jerry-19-broadway-1999-08-23`** — the hardest show all session: its
  21 published tracks span **two separate physical Drive Work Folders**
  (`JerryHannan - 19 Broadway 1999-08-23` clean reel, 14 tracks; `...Pt1
  Distorted` reel, 7 tracks) that `publish_show.py` doesn't support
  natively (one folder per show, assumed everywhere — fingerprinting, R2
  destination, Drive backup destination). Staged the distorted reel's
  files into the same local `tracks/` dir by hand, verified durations
  against the catalog, ran diagnose standalone (no CLIPPING, only known
  tape-damage clicks already documented in the show's own description),
  got Rene's explicit approval to hand-patch `publish.json`'s
  manifest/fingerprint (the classifier correctly blocked this
  unsupervised — it's exactly the kind of state tampering the fingerprint
  guards against), then published all 21 as one run. Also found and fixed
  the two-reel Drive backup gap: the distorted reel's own `Processed/`
  folder still had stale July-14 v5 renders untouched by the main run's
  backup step — copied fresh v8 output there by hand, verified with
  `rclone check` (0 differences). Second instance of the `draft_tracks`
  tag-drop bug (lost `upbeat` on "Da Da Da (Slave to an Angel)"), fixed
  before shipping. Commit `be871fc`.

### Archive-wide fix: "The Blarney Stone Blues" was two different tracks tangled together
Discovered while prepping `jerry-cafe-java-1999-06-17`: 3 shows spelled the
title "The Barney Stone Blues" (missing the 'l'); 5 others had the right
spelling but the wrong attribution (credited as a Jerry Hannan & Sean
Hannan original, tagged `original`/`irish`, when it's actually a Steve
Poltz cover). Initially misjudged this as a simple typo needing a merge —
the songwriter/tag mismatch was the tell that these might be two different
songs, and I flagged it before acting. **Rene confirmed: one song, "The
Blarney Stone Blues," songwriter Steve Poltz.** Fixed all 8 occurrences
(title spelling, songwriter, tags → `[cover, blues]`), R2 objects renamed
for the 3 misspelled shows, orphaned `songs/barney-stone-blues/` page
removed. Commits `8d5cae2` + `7f83627` (the first commit's `git add`
silently failed on a bad pathspec and only staged the already-`git rm`'d
deletion — second commit has the actual data/build changes; watch for this
failure mode, `git add` with one bad path aborts the whole call).

### Housekeeping: three things that were sitting untracked all session, now committed
- **`scripts/audit_dynamic_fallback.py`** — the script that produced the
  whole dynamic-fallback worklist. Commit `0e9f186`.
- **`.claude/settings.json`, `.claude/hooks/git-build-stagger.sh`,
  `.claude/agents/*.md`** (4 custom subagent definitions) — project-level
  config that was only ever living on this machine. Commit `9594b9e`.
  `.claude/settings.local.json` correctly stays gitignored (personal).
- **rclone delete permission change** — Rene asked for `rclone delete`
  against the `r2:` remote to be agent-executable instead of hard-blocked,
  after a publish run stalled needing stale-file cleanup handed to him as
  copy-paste commands. Added to `.claude/settings.local.json`'s allow
  list; CLAUDE.md's runbook updated. **Scope is R2 only** — `gdrive:`
  deletions still need Rene's confirmation each time. Commit `74e558b`.

## 🔧 In progress / blocked

### Six audio-pipeline bug fixes — implemented, tested, uncommitted, awaiting Rene's review
Rene asked to ship these ahead of any loudness-plan work (see the proposed
plan below); they came from codex-notes.md's 23:05 PDT pipeline review.
Code-only — nothing was reprocessed or republished, and no `--hpf`/`--lpf`/
`--notch` flag was ever used on any published track (confirmed by grepping
every `data/processing/*.json` sidecar), so no existing provenance is
disturbed.

1. **`--notch` was two-octave-wide cuts, not real notches** (build_filters()
   in `audio_process.py`) — replaced with a genuinely narrow
   `width_type=h:width=4` (Hz) cut; `--notch` now takes an optional
   frequency (default 60, pass 50 for 50 Hz-mains recordings);
   `--notch-harmonics N` adds harmonics only when explicitly requested
   (default 0, was previously always-on for 120/180 Hz).
2. **Resume didn't invalidate on recipe change** — new `recipe_signature()`
   hashes target/filters/transient-cap opt-ins/`WORKFLOW_VERSION`; resume
   now also compares `src_md5` and cross-checks the existing output's own
   audio MD5 against its recorded provenance before trusting a skip. Only
   enforced when a prior entry already has the new fields recorded, so it
   doesn't force-reprocess the existing archive. Verified live: same-recipe
   resume still skips; changing `--hpf` correctly forces a reprocess.
3. **Diagnostic failures didn't block publishing** — `publish_show.py
   prepare` now aborts on a nonzero diagnose exit (decode error/crash) and
   records structured findings in `publish.json`; `publish` (both
   whole-show and `--tracks`-scoped) hard-blocks on any unresolved
   CLIPPING/DROPOUT/BALANCE/PHASE finding until reviewed via a new
   `--accept-diagnostic 'TRACK:CATEGORY,...'` flag (persists as an audit
   trail). BANDWIDTH/DC/CLICK/HIGH_LRA/PRED_TP stay informational-only.
4. **`make_stream_mp3.py` (whole-show proxy) had none of the per-track QA**
   — now reuses the same `encode_mp3_with_qa()` extracted from
   `audio_process.py`'s per-track pipeline: true-peak trim, loudness
   measurement, decode verification, `stream_md5` checksum, and retained
   catalog metadata (previously stripped by `-map_metadata -1`). Also fixed
   the 192k/320k docstring mismatch — 320k was the actually-encoded and
   originally-intended rate; docstring and `PUBLISHING.md` corrected to
   match, not the encode itself.
5. **`--hpf` defaulted to 80 Hz**, dangerously close to the guitar's 82 Hz
   low E — bare `--hpf` now defaults to 25 Hz (DC/subsonic rumble); 80 Hz
   remains available via explicit `--hpf 80`. No other script called `--hpf`
   with an assumption to break.
6. **`--lpf` wasn't Nyquist-aware** — `cmd_process` now probes each track's
   real sample rate before building its filter chain and clamps the 18 kHz
   default to 90% of Nyquist with a printed note when it would otherwise be
   a no-op (e.g. on a 32 kHz source).

**Workflow version deliberately NOT bumped** — stays v8. The agent
initially bumped to v9, then reverted on discovering this same document
already reserves "workflow v9" for the separate, much larger, unapproved
combined-treatment proposal below — exactly the collision the proposed
plan's own sequencing (filter fixes ship as *their own* small change
first) was written to avoid. A comment above `WORKFLOW_VERSIONS` in
`audio_process.py` documents this for whoever builds the real v9.

**Open questions for Rene before this ships:**
- Confirm the chosen defaults: `--hpf` 25 Hz, `--notch` 60 Hz / 4 Hz-wide /
  -20 dB depth, LPF clamp margin (90% of Nyquist).
- Confirm the diagnostic hard-block category set (CLIPPING/DROPOUT/
  BALANCE/PHASE) is the right line between "blocks publish" and
  "informational."
- Review the diff, then commit — nothing has been committed or pushed.

### `jerry-cafe-java-1999-06-17` — blocked on Rene redoing tonight's lost fade edits
14 of 27 tracks had genuine `CLIPPING` verdicts (the worst clipping load of
any show this session) — Rene chose to add fade in/out across **all 27**
tracks and fix clipping by hand rather than just the 14 flagged ones. That
work was lost tonight (see incident notice at top) and he's redoing it
2026-08-12.

**Once he confirms the re-edit is done:**
1. Check `~/work/jerry-cafe-java-1999-06-17/tracks/` file mtimes are fresh
   *before* running anything, to confirm the new edits actually landed
   there (or wherever he says they are — ask if "work folder" is ambiguous
   again).
2. Re-run `python3 scripts/publish_show.py prepare
   jerry-cafe-java-1999-06-17` to get a fresh diagnose — confirm the 14
   CLIPPING verdicts are actually resolved before proceeding (compare
   against `~/work/jerry-cafe-java-1999-06-17/tracks/diagnostic_report.txt`
   from this session, still on disk, tracks: 03, 05, 06, 07, 14, 17, 19,
   21, 22, 23, 24, 25, 26, 27).
3. **Title fixes already resolved this session, don't re-litigate them**:
   track 6 "Hear Me" (not "I Need a Lover"), track 12 "Learn About Love"
   (not "I Want to Lean About Love"), track 21 "The Kiss / Da Da Da (Slave
   to an Angel)" — note the archive convention here: the **file** is named
   with a dash (`21 The Kiss - Da Da Da...`, `/` isn't filesystem-safe and
   `rename-track` doesn't sanitize it) but the **display title** in
   `recordings.json` uses a slash, patched by hand post-publish (existing
   precedent: `sean-19-broadway-1999-11-29` already does this) — track 27
   "The Blarney Stone Blues" / Steve Poltz / `[cover, blues]` (see the
   archive-wide fix above, already shipped for the other 7 occurrences;
   this show's own track 27 entry in `recordings.json` was also
   pre-emptively fixed to the correct songwriter/tags even though the show
   itself hasn't published yet — check it's still correct after
   `draft_tracks` runs, given the tag-drop bug below).
4. After publish: check for the `draft_tracks` tag-drop bug (below) before
   committing — this show is a strong candidate for it given how many
   tracks have cross-archive title matches.

## 💡 Proposed: archive-wide audio quality & loudness plan (preliminary — separate chat, nothing built yet)

Rene asked in a separate chat for a preliminary plan to improve audio
quality and loudness consistency across the whole archive. That
conversation lives in `codex-notes.md`'s four most recent sections (23:05
PDT "Audio quality and processing-pipeline review" through 00:26 PDT
"Decision note: combined-treatment eligibility") — **nothing here is
built or scheduled, it's a proposal awaiting Rene's decisions.**

**Two distinct problems found, not one:**
- **Applause-limited tracks sit systematically under target.** The
  "Butter" case (three performances of the same song at -21.65 / -20.00 /
  -20.03 LUFS) turned out to be the applause-limiter mode working as
  designed, not a one-off: a 12-track sample found 8/12 were
  applause-limited, most 1–3.5 dB under -20 LUFS (one as low as -23.57).
  When a clap/cheer out-peaks the music, gain gets capped to protect that
  peak and the whole track lands quieter than it needs to.
- **Sparse isolated high peaks anywhere in a track** — already what v8's
  `sparse-transient-cap` targets, but (a) not yet applied to every
  eligible track and (b) explicitly *not* currently combined with
  applause-limiter (two stacked limiters was correctly banned — unpredictable
  combined attenuation/provenance).
- **Not a problem:** genuinely high-LRA performances (e.g. an early
  Hollywood take integrating -23.25 LUFS but peaking -9.7 LUFS for 3s
  stretches) — real dynamics, don't chase with more gain.

**Core proposal — workflow v9, one coordinated render instead of two
stacked limiters:** mask the applause region, compute one constant
musical gain, apply region-aware applause control and sparse-transient
control together from the original lossless source, one 6 dB ceiling
across the whole track, one final true-peak assertion. New mode value
`applause+sparse-transient-cap`. Simulated on Butter
(`jerry-cafe-java-1999-03-25`): -20.01 LUFS, -1.49 dBTP, 0.2 LU LRA
change — but this is a **simulation, not a listening test**; per existing
policy (same bar as the applause-limiter and v8 itself), needs Rene
A/B'ing loudness-matched renders across ≥2 independent shows before it
becomes policy.

**Amended sequencing after reviewing codex-notes' four newest sections plus
a later 08:24 PDT note** (Rene's calls on all of this, nothing else
started beyond the six filter fixes above):

0. **Filter bug fixes** — done, see above, awaiting Rene's review/commit.
1. **NEW — establish an all-v8 baseline before designing/validating v9.**
   This was the biggest correction from reviewing codex's latest note: six
   shows still carry v5 provenance (114 tracks) and must be fully
   reprocessed through the current v8 engine *before* any v9 work starts,
   because a v9 loudness study built on a population that might still
   contain silently-dynamic v≤5 renders (the `dynamic_fallback_bug`) would
   be measuring noise, not signal. One show's sidecar already shows the
   danger concretely: `jerry-cafe-java-1999-03-25` has v5 entries whose
   `mode` field says `sparse-transient-cap` — a mode that only exists in
   v8 — proving version/treatment/bytes can't be trusted together without
   a clean re-render. The six: `jerry-19-broadway-1999-06-07` (17v5/12v8),
   `jerry-cafe-java-1999-03-25` (still mixed — only 10/21 tracks got v8
   this session), `jerry-cafe-java-1999-05-27` (20v5),
   `jerry-cafe-java-1999-06-17` (27v5, blocked on Rene's re-edit — see
   above), `mad-marin-brewing-co-1998-04-01` (17v5), and
   `mad-marin-brewing-co-1999-04-01` (15v5 — reprocess this one too even
   though it showed no confirmed dynamic-fallback drift, for a clean
   baseline). This subsumes and supersedes item 1 under "Next session"
   below — same shows, now framed as a v9 prerequisite rather than an
   independent worklist.
2. **Phase 0 validation A/B for the combined mode** — gates everything
   past it. Sharper candidate list than originally floated: codex's
   12-track eligibility sample gives two *named* review-tier cases with
   specific reasons (Anna May 2001-01-08 — 0.30s longest event, just over
   the 0.20s automatic envelope; Luxury of Murder — 0.6 LU simulated LRA
   change, just over the 0.5 LU gate) plus several confirmed-automatic
   controls (Houses of the Holy, Anna May 1999-09-09, Woman, Grey Funnel
   Line). Use those two review-tier tracks as the actual validation set,
   not a generic sample — they're the ones the eligibility math itself
   flagged as borderline.
3. **Phase 1 — applause-limited tracks archive-wide**, most bounded/
   best-characterized population. Decision gates now finalized (not just
   drafted) with a fourth tier added: **auto** ≤1% engagement/≤0.20s
   events/≤6dB reduction/≤0.5 LU LRA change; **review** 1–2%/0.20–0.50s/
   borderline LRA (auto-generate loudness-matched A/B clips at the
   flagged timestamps); **reject** >2%/>0.50s/>6dB/sustained loud passages;
   **skip** — already within ~0.5 dB of target, not worth processing at
   all. In the 12-track sample, 6/8 applause-limited tracks passed
   automatic outright, 2 needed review, 0 were rejected — real evidence
   this phase is worth doing, not proof every track should get it. First
   step when this phase starts: a read-only scan of every
   `mode: applause-limiter` track for an exact auto/review/reject/skip
   split before touching any audio.
4. **Phase 3 — cross-performance consistency scan** (cheap, read-only,
   could run anytime/early): for every song with 2+ performances, diff
   integrated LUFS across performances, flag gaps above ~1 dB (threshold
   TBD by Rene) — the systematic version of how Butter was found by
   accident.
5. **Phase 2 — remaining non-applause sparse-transient stragglers**,
   folds into the existing 16-show transient-cap-candidate worklist and
   the (now superseded-by-item-1) dynamic-fallback worklist.

**Explicitly excluded:** dense/repeated-peak tracks (Truck, 12.3%
near-peak — that's the deferred `drum-control` proposal, needs its own
A/B evidence/decision, not folded in here) and wide-dynamic performances
like Hollywood — confirmed correct by codex's own 12-track sample: Hollywood
was the one track it actually rejected, for 1.05s of continuous engagement
and a genuine 3-second loudness spike to -9.7 LUFS, not a processing
artifact. Better fit, if anything, for the client-side "louder playback"
toggle than for reprocessing the master (see next point).

**NEW — a way to address some of this without touching masters at all.**
Codex's 23:48 PDT note proposes consolidating the site's four separate
player implementations into one shared browser `AudioEngine` (one
`HTMLAudioElement`, one gain+true-peak-limiter graph) that applies
offline-computed per-track playback profiles (approved gain, applause
regions, limiter constraints) at listen time — normalizing "Butter sounds
quiet next to itself" at playback rather than by reprocessing and
republishing the archival master. This doesn't replace the v9 master-level
work, but it's a real alternative/complement, not just a footnote under
"deferred louder playback" — it's the same architectural work the player
already needs for its known engine-duplication problem. Added as an
explicit open decision below rather than silently folded in.

**Considered and rejected, not just unmentioned:** raising the archive-wide
target to -16 LUFS. Codex ran the actual numbers on all 680 tracks' existing
provenance: median predicted peak reduction 4.7 dB, 66.6% of tracks need
3–6 dB, 19.4% need more than 6 dB — incompatible with the honesty policy
that already governs -20. Staying at -20 LUFS for archival masters remains
the recommendation; a separately-labeled "Louder playback" convenience
path (see above) is the sanctioned way to make direct listening louder.

**What's explicitly *not* proposed:** any blanket EQ/brightening/heavier-
NR pass across the archive — codex-notes' review concluded that would be
more likely to damage 20+ year old DAT/audience recordings than help,
given how careful the existing pipeline already is. Noise
reduction/restoration stays manual and per-tape (Audacity, Residue-mode
listening), same as today — not batched.

**Open decisions for Rene before anything past the filter fixes is
built:** whether to proceed with the six-show v8-baseline prerequisite
(item 1) before any v9 design work; Phase 0's validation set (Anna May
2001-01-08 + Luxury of Murder, per above); the cross-performance scan's
dB threshold; and whether the shared browser-engine "louder playback"
path should be pursued in parallel with, instead of, or after the
master-level v9 work.

## 🔜 Next session

### 1. Five more dynamic-fallback shows — now reframed as the v9 prerequisite
See "NEW — establish an all-v8 baseline before designing/validating v9"
under the proposed plan above — same six shows (this list plus
`mad-marin-brewing-co-1999-04-01`, previously marked "no action needed"
but now wanted for a clean v9 baseline regardless), now framed as blocking
the loudness-plan work rather than an independent cleanup item. Don't
track it in two places — that section is now authoritative.

### 2. `draft_tracks.py` silently drops a show's own correct tags — needs a real decision from Rene
Confirmed twice this session (Father and Son's `guest` tag, Da Da Da's
`upbeat` tag). Root cause: `catalog()` builds its title→tags lookup by
scanning every *other* show, excluding the current one, then the merge
always lets that cross-archive lookup win over the track's own existing
tags — even when the archive-wide "most common" variant is wrong for this
specific performance. Not fixed at the tooling level; full writeup in
memory (`draft_tracks_tag_overwrite_bug.md`). **After every publish,
diff `data/recordings.json` for the touched show and check for any
*dropped* tag**, not just the expected size/title deltas — `draft_tracks`'s
own FLAG output won't warn about this.

### 3. A pre-existing R2 filename oddity, unrelated to tonight's work
`jerry-19-broadway-1999-07-19` track 22: display title is "The Blarney
Stone Blues" but the actual R2 object is named `22 Leprechaun.flac`. Given
tonight's "Leprechaun" confusion on a different show turned out to be
Rene's own past mislabeling, this might be the same root cause on an
earlier show — worth asking Rene directly rather than guessing.

### 4. Carried from before, still true
- Sixteen shows remain on the older transient-cap-candidate worklist from
  2026-08-10 (separate from the dynamic-fallback list — some overlap).
- `jerry-19-broadway-1999-06-07`'s stray R2/Drive objects from an earlier
  title fix — now agent-executable via `rclone delete` against `r2:` (see
  above), still needs doing.
- Louder-playback derivative — still deferred, no A/B evidence.
- "Blind Man" gap on `jerry-19-broadway-1999-02-01` track 10 — needs a
  future manual Audacity look, shipped as-is with `dropouts: true`.
- `drum-control` (codex-notes.md proposal) deliberately not built — needs
  its own decision + A/B evidence.
- A 4th "Good Life" entry under `singles` (artist `sean`, no venue/date) —
  still unverified, possibly a genuinely different song.

## Gotchas learned this session
- **`publish_show.py prepare` hard-deletes and re-fetches
  `~/work/<slug>/tracks/` from Drive every time it runs.** This is by
  design (keeps local staging in sync, discards stale attempts) but it
  does not expect hand-edits to live in that directory unbacked-up. See
  the incident notice at the top and `feedback_prepare_wipes_local_staging.md`.
- **"Work folder" is dangerously ambiguous.** CLAUDE.md capitalizes "Work
  Folder" to mean the Drive directory; Rene also says "work folder" for
  the local `~/work/<slug>/` staging path `prepare`/`publish` use. When an
  instruction says "work folder, tracks subfolder" and there's already a
  local staging directory in play, ask which one before running anything
  that touches either.
- **A `git add` call with multiple paths aborts entirely if even one
  pathspec doesn't match** — nothing gets staged, not even the valid
  paths. Happened this session (`git rm`'d file included in a later `git
  add` call by mistake) and silently produced a near-empty commit. Check
  `git status`/`git show --stat HEAD` after every commit that stages
  multiple files, don't assume the commit contains what was intended.
- **A title/songwriter mismatch is stronger evidence of "two different
  songs" than a title-spelling mismatch is evidence of "same song,
  typo."** The Blarney/Barney case: cross-referencing archive-count alone
  (5 vs. 3) would have suggested "typo, keep the more common one" — but
  the songwriter and tag fields told the real story (different song
  entirely got miscategorized on one side). Check songwriter/tags/genre
  alongside title-count before merging or renaming anything.
- **`/` cannot appear in a filename.** `publish_show.py`'s `rename-track`
  doesn't sanitize it — passing a title containing `/` crashes
  `os.rename`. Existing archive convention for such titles: file uses a
  dash, display title in `recordings.json` keeps the slash, patched by
  hand post-publish (precedent: `sean-19-broadway-1999-11-29`).
- **Two-reel/multi-source shows aren't supported by `publish_show.py`.**
  One Drive Work Folder per show is assumed throughout (fingerprint,
  upload destination, Drive backup destination). The workaround (manual
  local staging + hand-patched `publish.json` manifest/fingerprint,
  approved case-by-case) works but needs the classifier's blocking
  reviewed each time — it's not a rubber-stamp.

## Durable facts (don't undo)
- **v8 now covers seventeen shows** (fourteen from before today, plus
  `jerry-cafe-java-1999-03-25`, `jerry-cafe-java-1999-04-29`, and
  `jerry-19-broadway-1999-08-23` today). `jerry-cafe-java-1999-06-17` will
  be the eighteenth once Rene's re-edit + the clipping review is done.
- **The dynamic-fallback bug is real and confirmed, not speculative** — see
  prior handoff for the full technical background. Treat every remaining
  v≤5 `linear`/`linear-reduced` track as suspect until reprocessed or
  positively cleared by the audit.
- **`--tracks` scoped publishing and `rename-track` remain first-class
  paths** — used repeatedly this session without issue (aside from the `/`
  filename limitation above).
- **`rclone delete` against `r2:` is agent-executable** (Rene lifted the
  hard block 2026-08-11, pre-approved in `.claude/settings.local.json`).
  `gdrive:` deletions still need Rene's confirmation each time.
  `rclone moveto`/`copyto` for renames remain fine, used freely.
- `updates[]` is a dated changelog and should read as historically accurate
  to what was true *at the time* — don't retroactively rewrite entries to
  match a later wording standard.
- Linear-normalization policy, transient-cap (v8) tiers, and the
  applause-limiter exception are unchanged from before — see CLAUDE.md,
  not repeated here.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. Dynamic-fallback bug
background: docstring of `scripts/audit_dynamic_fallback.py` (now
committed, `0e9f186`). External review scratchpad: `codex-notes.md`
(untracked, not Rene's notes — verify before acting; also where the
`drum-control` proposal lives). Tonight's data-loss incident: full writeup
in auto-memory, `feedback_prepare_wipes_local_staging.md`.
