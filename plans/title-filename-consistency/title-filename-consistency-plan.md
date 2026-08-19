# Title / filename consistency: scoped proposal

Status: **not started.** Written 2026-08-16 after a disk-cleanup pass found
seven tracks across three shows where the Drive filename disagrees with the
title the site publishes. Rene asked for an opinion on automating the Drive
rename; this is that opinion, scoped for a future session.

## 1. The actual problem

A track's title exists in three places that are allowed to disagree:

| Where | Example (19 Broadway 1999-05-10, track 17) |
|---|---|
| Drive `Tracks/` filename | `17 I Need a Lover.flac` |
| R2 key | `FLAC/JerryHannan - 19 Broadway 1999-05-10/17 Hear Me.flac` |
| `recordings.json` title | `Hear Me` |

**The Drive filename is not a label — it is an input.** `draft_tracks.py`
derives each track's title from the filename it finds, with **zero
preservation** of a title already corrected. So a wrong name on Drive
regenerates the wrong title on every re-prepare.

That show's own updates note records the loop closing:

> Restored track 17's title to the archive's established spelling, "Hear Me,"
> after the fresh export drifted **back** to "I Need a Lover."

"Back" because it had already been fixed once. The same shape appears in the
`mad-marin-brewing-co-1999-04-01` track 1 trailing-space case, which regains
its space on every re-draft.

**Known scale:** 7 mismatches across the 7 shows that happened to be staged
locally (1999-05-10 ×1, 1999-06-21 ×2, 1999-07-19 ×4). Archive-wide unknown —
that is what step 1 answers.

### 1b. The second, distinct defect: orphaned duplicates in `Processed/`

Found 2026-08-16 while cleaning up the 1999-05-10 case, and **not the same
problem as a filename mismatch** — worth stating separately because the first
diagnosis of it was wrong.

`Processed/` on that show contained **both** names, four files for one track:

| File | Written | MD5 (FLAC) |
|---|---|---|
| `17 Hear Me.flac` / `.mp3` | 21:42 | `74e2851692d9ba4c…` |
| `17 I Need a Lover.flac` / `.mp3` | **22:05** | `74e2851692d9ba4c…` |

Bit-for-bit identical, and both match what R2 serves. The show published
correctly as "Hear Me" at 21:42; a re-run 23 minutes later picked up a fresh
export whose filename had drifted back to the old title and wrote a **second
copy** under it. The Drive backup only overwrites and adds — it never deletes
— so both survived.

**The trap: the stale file is the *newer* one.** Sorting `Processed/` by date
to decide what to keep gives exactly the wrong answer. The only reliable
discriminator is the MD5 against the R2 key named in `recordings.json`.

So the audit needs to detect **two different things**:

1. a `Tracks/` filename that disagrees with the published title (the input
   bug — a wrong name here regenerates a wrong title), and
2. `Processed/` files whose names do not correspond to any published R2 key
   for that show (pure duplicates — delete, never rename).

`drive_backup_matches()` cannot catch case 2: it runs `rclone check`, which
verifies that everything expected is *present*, not that nothing extra is.
`CLAUDE.md` already tells Rene to look for these by eye after a reprocess;
this is that check, automated.

## 2. Recommended order

### Step 1 — audit mode (read-only, do this first)

Scan every show and report **both** defects from §1 and §1b:

- **`Tracks/` drift** — filename versus the published title in
  `recordings.json`, run through the same sanitization the filenames use, so
  `The Kiss / Da Da Da` correctly matches `The Kiss - Da Da Da`.
- **`Processed/` orphans** — any FLAC/MP3 whose name matches no published R2
  key for that show. Report the MD5 alongside: a duplicate that matches the
  R2 hash under a different name is safe to delete, while an orphan whose
  hash matches *nothing* is a genuine unknown and needs a human look.

Read-only, cheap, and it sizes both problems before any code is written. It
may show this is a 7-track annoyance not worth automating, or a 60-track one
that clearly is. Deleting the orphans it finds is a one-line `rclone delete`
per file and needs no new tooling — `rclone delete` against `r2:` has been
agent-executable since 2026-08-11, but these live on `gdrive:`, which still
needs Rene's confirmation each time.

### Step 2 — stop `draft_tracks.py` clobbering corrected titles

**This is the fix that actually matters, and it is purely local.** Preserve an
existing title for a track unless explicitly told to re-derive it; only adopt
the filename-derived title for genuinely new tracks. See
`draft_tracks_title_overwrite_bug` in memory.

Why first: it protects the archive **even when a Drive filename is wrong**,
which will keep happening — fresh Audacity exports arrive named whatever they
are named. Renaming Drive files without this fix means depending on every
filename in a 680-track archive being correct forever, which is a fragile
invariant to take on.

With this in place, the Drive rename becomes cosmetic consistency rather than
load-bearing correctness.

### Step 3 — extend `rename-track` to rename on Drive

Extend the existing `publish_show.py rename-track` rather than adding a step:
it is already the one sanctioned place a rename happens (a hand `mv` breaks
the fingerprint), so it is already where the knowledge lives.

**Three constraints, all non-negotiable:**

1. **Scope by show folder + leading track number, never by title.** A search
   for `17 I Need a Lover.flac` returned **four** Drive hits across three
   folders, and "I Need a Lover" is a legitimate, correct title on five other
   shows (1999-03-29, Cafe Java 1999-06-17, 4th Street Tavern 1999-05-01, New
   Georges 1999-10-13, Sweetwater 1999-05-18). A title-matching rename would
   eventually corrupt the wrong show.
2. **Derive the filename from the title through the existing sanitization,
   never set them equal.** Titles contain `/` — the reason for the
   `rename_track_slash_bug` — so `The Kiss / Da Da Da` must keep becoming
   `The Kiss - Da Da Da` on disk. Filename convention and title are different
   things.
3. **Opt-in flag, printed before/after, failure must not break the publish.**
   `gdrive:` is the source of truth and rclone-to-Drive is a documented
   staller. A rename that hangs must not take a publish down with it.

Also handle the `Processed/` FLAC+MP3 pair, which carries the stale name too —
that is the orphan cleanup the runbook currently asks Rene to do by eye.

## 3. Open items

- **Permission.** In the 2026-08-16 session both `rclone moveto` against
  `gdrive:` and the Drive MCP `update_file` were blocked by the permission
  classifier, so the agent could not perform even a single approved rename.
  Whatever gets built either runs as Rene, or needs an explicit Bash
  permission rule. Worth deciding deliberately: given the 2026-08-11 incident
  where a rerun of `prepare` hard-deleted hand-edited work, keeping Drive
  mutations manual is a defensible choice.
- **The known backlog**, pending step 1: 2 mismatches on 1999-06-21 and 4 on
  1999-07-19, identified by byte-size match during the 2026-08-16 cleanup
  verification. Both sets are `Tracks/` drift (§1), not duplicates.

- **19 Broadway 1999-05-10 track 17 — RESOLVED 2026-08-16.** Rene renamed
  `Tracks/17 I Need a Lover.flac` → `17 Hear Me.flac` by hand, and deleted the
  duplicate `17 I Need a Lover.flac`/`.mp3` from `Processed/` after MD5
  confirmed they were bit-identical to the `Hear Me` pair and to R2. Note the
  earlier diagnosis in this session was **wrong**: `Processed/` was described
  as "carrying the stale name", implying the correct name was absent. It was
  not — both names were present, so the defect was a duplicate (§1b), not a
  mismatch. That is what prompted §1b, and it is why the audit must
  distinguish the two: one is fixed by renaming, the other only by deleting.
