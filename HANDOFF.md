# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-11 → 2026-08-12 · **Branch:** `main` — everything through
`9594b9e` is committed, pushed, and **live**, deploy green and spot-checked
on renedebos.com itself. `git status` is clean except `codex-notes.md`
(deliberately untracked — external review scratch, not Rene's notes).

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

## 🔜 Next session

### 1. Five more dynamic-fallback shows remain on the worklist
Now that `06-17`, `04-29`, `08-23`, and `03-25` are done: remaining —
`jerry-19-broadway-1999-06-07` (17 v5 tracks still need a decision on full
v8 vs. leave as-is), `jerry-cafe-java-1999-05-27` (4/20, mild),
`mad-marin-brewing-co-1998-04-01` (2/16, mild). `06-17` itself is the
worklist's remaining "not started" entry (14/27) but is blocked, see
above. `mad-marin-brewing-co-1999-04-01` needs no action (0/16 drifted).

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
