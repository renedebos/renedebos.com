# Dev environment setup

How to rebuild the local working environment for renedebos.com on a fresh
machine (e.g. a new Chromebook Linux container). **None of this is needed for
the live site to keep running** — the site is hosted on Cloudflare Pages
(auto-deploys from GitHub on push) and audio streams from Cloudflare R2. This
is only the tooling you need to *edit* the site and *upload* new audio.

## Where everything lives (source of truth)

| What | Stored in |
|---|---|
| Site code, `data/recordings.json`, built pages, scripts | GitHub: `github.com/renedebos/renedebos.com` |
| MP3 / FLAC the site streams | Cloudflare R2 bucket `hannan-audio` |
| Master WAVs, Audacity `.aup3` projects, normalized tracks | Google Drive (shared "DAT Tapes" folder) |

Nothing critical lives only on the local machine. `gdrive-mount/` is just a
downloaded copy of Drive; `scripts/.metadata-backups/` are historical snapshots
of `recordings.json` (the current one is in git); `.wrangler/` is a regenerable cache.

## 1. Clone the repo

```bash
git clone https://github.com/renedebos/renedebos.com.git
cd renedebos.com
```

## 2. Install tools

- **Python 3** (build scripts, metadata editor — standard library only, no pip deps)
- **ffmpeg / ffprobe** — track durations, waveform peaks, stream MP3s
  ```bash
  sudo apt install ffmpeg
  ```
- **rclone** — copy audio between Google Drive and R2
  ```bash
  sudo apt install rclone   # or: curl https://rclone.org/install.sh | sudo bash
  ```
- **git** and the **GitHub CLI** (`gh`) for pushing / PRs.

## 3. Configure the two rclone remotes

The remotes are referenced as `gdrive:` and `r2:` throughout the `Makefile` and
scripts. Re-create them with `rclone config`:

- **`gdrive`** — type `drive` (Google Drive). The recordings live in a
  *shared-with-me* folder, so list/copy commands pass `--drive-shared-with-me`.
  - Primary audio path: `gdrive:DAT Tapes/DAT Tapes WAV Files/Hannans`
  - Split-track work folders: `gdrive:DAT Tapes/Work Folder/<show>/Tracks`
  - Auth: OAuth via Google account that the DAT Tapes folder is shared with.
- **`r2`** — type `s3`, provider Cloudflare R2. Bucket `hannan-audio`.
  - All operations pass `--s3-no-check-bucket`.
  - Auth: an R2 API token (Access Key ID + Secret) from the Cloudflare dashboard,
    with the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

Verify:
```bash
rclone listremotes                 # should show gdrive: and r2:
make status                        # Drive vs R2 file counts
```

## 4. Cloudflare auth (only if deploying manually)

Normal deploys happen automatically when you `git push` to `main` (Cloudflare
Pages watches the repo). You only need `wrangler login` if you want to manage
the Worker or trigger a deploy by hand.

## Everyday workflow

```bash
make edit                          # metadata editor at http://127.0.0.1:8765
                                   #   -> Save in the browser, then:
make build                         # regenerate HTML pages + search index
git add -A && git commit && git push origin main   # deploy

# Adding a new show's split tracks (see CLAUDE.md / memory for detail):
#   upload MP3+FLAC to R2 -> python3 scripts/gen_peaks.py --slug <slug>
#   -> set tracks in recordings.json -> make build -> commit + push
```

Tip: if you leave `make edit` running and the repo changes on disk underneath
it, **reload the editor tab before editing again** — Save writes the browser's
in-memory copy and will otherwise clobber the newer on-disk version.
