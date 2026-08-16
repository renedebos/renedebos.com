# When a publish run goes sideways

## Fingerprint mismatch on publish

`publish.json` records a fingerprint of the prepared tracks. If a file in
`~/work/<slug>/tracks/` was renamed or replaced by hand, the next `publish`
aborts. **This is the safety net working**, not a bug to route around.

The supported fix is `rename-track`, which updates the file, the manifest,
and the fingerprint together:

```bash
python3 scripts/publish_show.py rename-track <slug> --track-num N --new-title "Correct Title"
```

It never touches audio bytes, Drive, or R2. If the tracks themselves changed
(a fresh export from Rene), re-run `prepare` instead of patching state —
`publish.json` is derived, and regenerating it is cheap.

Don't hand-edit `publish.json`. It exists to make the render provable; a
hand-patched manifest silently voids that.

## Drive uploads stall mid-file

`rclone` pushes to `gdrive:` can stall partway through a file, and
`--timeout` won't catch it because the connection is still technically open.

- Prefer a **local → Drive copy through `~/gdrive-mount`** over a direct
  rclone push where possible.
- If you must push directly, use a `--max-duration` retry loop.
- `publish`'s own Drive `Processed/` backup already wraps this in a
  stall-aware retry loop, so ordinary runs handle it.

## Stale files after a reprocess

The Drive backup check (`drive_backup_matches()`, fixed 2026-07-22) verifies
*content*, not just file count — `rclone check` on FLAC/MP3 hashes plus a
`processing_report.txt` presence check. Stale same-named leftovers from an
earlier run of the same show can no longer satisfy it by count alone.

**But it only overwrites and adds — it never deletes.** If a title changed
between runs, the old-named files stay behind as orphans in Drive
`Processed/` and on R2. After any reprocess, check by eye or with
`rclone lsl` for old-dated duplicates under the previous filename.

- `rclone delete` against **`r2:`** is agent-executable and pre-approved
  (since 2026-08-11). Remember `--s3-no-check-bucket`.
- `rclone delete` against **`gdrive:`** needs Rene's confirmation first —
  that's the source of truth for the whole archive.

## `--manual-drive-backup` didn't hand off

With `--manual-drive-backup`, `publish` waits ~3 min polling Drive for Rene's
manual copy before falling back to the automated rclone path. Since the poll
checks content, a partial manual copy won't satisfy it — it'll fall back and
re-copy, which is the correct outcome, just slower.

This flag is opt-in. Ask Rene each time rather than assuming; whether a
manual copy is faster depends on where he is.

## Cleaning up local working state

```bash
python3 scripts/publish_show.py cleanup <slug>
```

Deletes `~/work/<slug>` only once the show is provably safe everywhere else —
live on the site, complete on R2, backed up to Drive `Processed/`. It refuses
outright unless the show is a published track-listed show with
`processing_status: done`.

Because it verifies before deleting, prefer it over `rm -rf ~/work/<slug>`.

## Background jobs report false completions

Pass a single command with `run_in_background: true` and **no** trailing `&`
or `nohup`. Double-backgrounding makes the job look finished immediately.
Poll for an explicit end marker in the output.

Related trap: `pgrep -f '<script>.py'` can match the watcher's own command
line. Match on the full file path, or just rely on the background-task
completion notification.

## `make edit` clobbered newer changes

If `make edit` is left running while the repo changes on disk underneath it,
Save writes the browser's in-memory copy over the newer on-disk version.
Reload the editor tab before editing again.

This is the same hazard as two machines editing `recordings.json`, and the
same fix: pull, then reload, then edit.

## Build failures after publish

`build.py` fails hard on integrity problems and prints exact `git rm`
commands for orphan `songs/` directories. Those failures are real — a missing
peaks file or an unknown tag means the site would ship broken.

The *warnings* about rarity-tag drift (rarity tags on songs with 3+
appearances) are different: they're Rene's editorial call. Surface them, don't
auto-fix them.
