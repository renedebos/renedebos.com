# Architecture review and recommendations

## Overall assessment

The architecture is fundamentally sound and well matched to the project.
A generated static site, private Cloudflare R2 storage, and two small
Cloudflare Workers are a sensible combination for an audio archive. The design
is inexpensive, durable, easy to back up, and avoids unnecessary application
infrastructure.

The main opportunities are organizational drift, duplicated generated output,
limited automated testing, and one production header/caching inconsistency.
These are cleanup opportunities, not reasons to redesign the site or adopt a
frontend framework, CMS, or database.

## What is working well

- `data/recordings.json` is a clear editorial source of truth.
- Static HTML gives the archive durability, accessibility, crawlability, and
  good failure resistance.
- R2 audio storage is appropriately separated from Git and site deployment.
- Streaming and protected downloads are isolated in a small audio Worker.
- Playlist persistence is the site's only dynamic feature and fits Cloudflare
  KV well.
- The build performs strong catalog integrity checks for metadata, paths,
  waveform data, processing sidecars, song pages, and generated-output
  freshness.
- The audio pipeline records provenance and distinguishes human edits from
  reproducible machine processing.
- The frontend is dependency-light and has no unnecessary framework or bundle
  toolchain.
- CI pins third-party action and Wrangler versions.
- The current integrity check passes: 31 shows, 530 curated tracks, and no
  orphan song pages.

## Highest-priority improvements

### 1. Fix static-response security headers

Production dynamic responses, including custom 404s and `/play/` redirects,
include the security headers from `site_worker.js`. Cached static pages such as
the homepage and playlist page currently do not.

This indicates that wrapping `env.ASSETS.fetch()` with `secure()` is not a
dependable way to attach headers once Cloudflare's static-asset caching path is
involved.

Recommended changes:

- Add a root `_headers` file containing the common static security headers.
- Keep `secure()` for API, redirect, and custom 404 responses.
- Consider changing `run_worker_first` from `true` to targeted routes such as
  `/api/*` and `/play/*`, while retaining Worker handling for unmatched routes
  and the branded 404.
- Verify both GET and HEAD responses after deployment.

Cloudflare Workers Static Assets supports `_headers` directly. Moving static
headers there should make their behavior consistent and allow ordinary files
to use the shorter static-asset path.

### 2. Consolidate contradictory documentation

This is the largest maintenance problem. Several documents describe retired
architecture or processing rules:

- `SETUP.md` says the live site is hosted on Cloudflare Pages, while it now
  deploys as the `renedebos-site` Worker with static assets.
- `AUDIO_PROCESSING.md` still describes a -16 LUFS Mad Hannans target, older
  normalization behavior, and Pages deployment.
- `HANDOFF.md` is a stale session snapshot from July 5.
- `PLAYLIST FEATURE.md` mixes current design with an implementation diary and
  retired experiments.
- `CLAUDE.md` and `PUBLISHING.md` contain the more current operational rules.

Stale audio-processing instructions are particularly risky because following
them could produce incorrect archival output.

A clearer documentation structure would be:

```text
README.md
docs/
  ARCHITECTURE.md
  PUBLISHING.md
  SETUP.md
  metadata.md
  audio-processing.md
  design/
    playlists.md
  archive/
    handoff-2026-07-05.md
```

Each operational rule should have one authoritative home. Other documents
should link to that location instead of repeating the same instructions.

### 3. Separate source files from deployable output

The repository root currently mixes source metadata, Python code, Worker code,
generated HTML, copied JavaScript and CSS, search catalogs, waveform data, and
deployment control files.

Cloudflare consequently deploys `directory: "."`, with `.assetsignore` acting
as a denylist. This works, but it is fragile: a newly added internal file can be
published if nobody remembers to exclude it.

A clearer arrangement would be:

```text
src/
  content/
  css/
  js/
data/
scripts/
workers/
  site/
  audio/
dist/
```

Configure the static asset directory as `dist/`, and have the generator place
all public files there. This creates a simple invariant: everything under
`dist/` is public, and nothing else is.

Whether `dist/` remains committed is a separate decision. Given the existing
reproducibility check and modest repository size, continuing to commit it is
reasonable.

### 4. Add focused tests around the Workers and generator

The build validation is good, but the repository has no dedicated test files.
The most failure-sensitive behaviors include:

- Playlist hash allocation and collision lengthening
- Playlist payload validation and rate limiting
- Redirect routing and security headers
- R2 Range parsing
- Download-token signing, alteration, and expiry
- Song canonicalization
- Metadata validation edge cases

A small suite using built-in `node:test` and Python `unittest` would be enough;
a large testing framework is unnecessary.

At minimum, CI should test:

- A known asset returns 200 with required headers.
- An unknown URL returns the branded 404 with `Cache-Control: no-store`.
- An unknown playlist slug redirects to `/playlist/`.
- Invalid playlist payloads return 400.
- Valid and invalid audio Range requests behave correctly.
- Expired or altered download tokens return 401.
- The full site build remains deterministic.

## Useful simplifications

### Put both Workers under one directory

The site Worker is at the repository root, while the audio Worker is under
`worker/`. A symmetrical layout would be easier to understand:

```text
workers/
  site/
    index.js
    wrangler.jsonc
  audio/
    index.js
    wrangler.toml
```

The Workers should remain separate operationally; their responsibilities,
security boundaries, and deployment triggers are appropriately distinct.

### Limit local metadata-backup accumulation

`scripts/.metadata-backups/` currently occupies approximately 8.4 MB locally
and contains dozens of snapshots. It is ignored by Git but grows indefinitely.

Have the editor retain a fixed number, such as the newest 20, or remove backups
older than 30-60 days. Git already preserves committed catalog history.

Also consider adding patterns such as these to `.gitignore`:

```gitignore
data/*.backup*.json
data/*.draft.json
```

The current `data/recordings.backup.draft.json` is untracked but not ignored.

### Retire or relocate obsolete artifacts

Candidates for review:

- `.pagesignore` appears to be left over from the retired Pages deployment.
- `HANDOFF.md` should be archived or removed.
- `Peakfinder-rft.ny` would be clearer under `tools/audacity/`.
- `lab/wavesurfer/` could be excluded from production if it is only a developer
  experiment.
- Older workflows such as `batch_process.py`, `make_stream_mp3.py`, and
  `update_tracks.py` should be marked as legacy or moved under
  `scripts/legacy/` if the current publishing orchestrator supersedes them.

Do not remove `_redirects`; Workers Static Assets still supports it, and its
current redirects remain useful.

### Split large modules only along real boundaries

Two modules are becoming substantial:

- `scripts/audio_process.py`: approximately 1,343 lines
- `scripts/sitegen/pages.py`: approximately 1,012 lines

Reasonable eventual splits include:

```text
scripts/audio/
  diagnose.py
  normalize.py
  provenance.py
  ffmpeg.py

scripts/sitegen/pages/
  archive.py
  shows.py
  songs.py
  playlist.py
  informational.py
```

This is medium priority. Large files are not automatically problematic, and
the current code remains navigable. Split them while making related changes,
not as a standalone rewrite.

### Replace wildcard imports

`scripts/build.py` imports every site-generator module with `import *`.
Explicit module imports would make ownership and dependencies clearer:

```python
from sitegen import core, feeds, pages
```

Calls would then be explicit, such as `core.validate()` and
`pages.build_home()`. This is a small maintainability improvement rather than
an urgent defect.

## Changes that would not improve this project

- Do not add React, Next.js, Astro, or a bundler merely to reorganize the
  frontend.
- Do not move the catalog into a database.
- Do not split every show into a separate metadata file yet. At the current
  scale, the catalog remains manageable, and the editor plus validation
  protects it well.
- Do not combine the site and audio Workers; their separate boundaries are
  useful.
- Do not replace the audio pipeline with a hosted media-processing service.
- Do not remove committed generated output unless deployment is deliberately
  changed to rebuild everything in CI.

## Suggested order of work

1. Correct and consolidate the documentation.
2. Add `_headers` and verify production static responses.
3. Add ignore rules and metadata-backup retention.
4. Introduce `README.md` and a concise architecture overview.
5. Move deployable output to `dist/`.
6. Reorganize the two Worker directories.
7. Add focused Worker and generator tests.
8. Split large modules only when they are next being modified.

Overall, the architecture is strong for its purpose. The technical model is
good; the repository has mainly accumulated historical layers faster than its
documentation and directory structure have been consolidated.

---

# Read-only site audit — 2026-07-15 00:15:09 PDT

Overall, the site is in good shape. The build integrity check passes, the
archive data is internally consistent, media streaming works, security headers
are present, and the responsive CSS shows deliberate mobile work. No site-wide
critical failures were found.

## High priority

1. **The contact form is blocked by the live CSP.** The page submits to
   `https://contact-form.renedebos.workers.dev`, but `connect-src` permits only
   the audio worker. Update both `site_worker.js` and `_headers`.
2. **The limiter's final retry can misreport the rendered audio.** If attempt
   five still exceeds the ceiling, `audio_process.py` adjusts the plan and
   provenance but exits without rendering that adjusted configuration.
3. **Resume mode trusts existing outputs without validating them.** It does not
   establish that the source, filters, target, workflow version, and output
   hashes match the current run.
4. **Filename problems can overwrite audio or lose provenance.** Missing or
   duplicate track numbers and same-basename WAV/FLAC inputs are not rejected
   before rendering.
5. **Some FFmpeg failures can be mistaken for clean analysis.** In particular,
   a failed decode in `clipcheck.py` can become an empty sample array and a
   `NONE` verdict. Use a shared checked-command wrapper.

## Medium priority

6. Internal documentation conflicts with workflow v5: the engine and public
   process page support applause-only limiting, while `CLAUDE.md` and
   `AUDIO_PROCESSING.md` repeatedly prohibit any limiter.
7. Show-page waveforms cannot be sought with a keyboard. Add an accessible
   range control or complete slider semantics and keyboard handling.
8. The password dialog lacks `role="dialog"`, `aria-modal`, an accessible
   heading relationship, a focus trap, and focus restoration.
9. Dark-mode white text over the light-green accent is about 2.83:1 contrast,
   below WCAG requirements for normal text.
10. The Archive prerenders duplicate artist IDs in its all-show and split-show
    views, making fragment navigation and DOM selection ambiguous.
11. The archive search input has no persistent accessible label.
12. Static CSS, JavaScript, and JSON assets use `max-age=0, must-revalidate`, so
    browsers revalidate shared assets unnecessarily.
13. If waveform peak JSON fails, the fallback can cause WaveSurfer to fetch and
    decode complete MP3s for every track on the page.
14. Both `www.renedebos.com` and the apex host return full pages. Canonicals are
    correct, but a permanent redirect to the apex would simplify SEO, caching,
    and analytics.
15. There are no automated regression tests for the player or audio engine's
    limiter retries, resume behavior, corrupt inputs, filename validation,
    contact CSP, or Worker range edge cases.

## Low priority

- Playback failures reset the icon without explaining the error to visitors.
- Tooltip details are mouse-hover-only, though the archive legend helps touch
  users.
- Contact success and error messages lack `aria-live`.
- `Did You Ever See` has no songwriter or tags; `Shirt - ABC` has no tags.
- Audio-password throttling is per Worker isolate and only best-effort.

## Checks that passed

- `python3 scripts/build.py --check`
- 31 shows and 647 curated tracks validated
- All 28 split shows have complete processing sidecars and waveform peaks
- Three whole-show recordings are correctly marked `needs-processing`
- No missing internal page or asset targets
- JavaScript syntax checks
- MP3 byte-range streaming (`206`), FLAC stream blocking (`403`), and
  unauthorized download blocking (`401`)
- Branded non-cacheable `404` and legacy `301` redirects
- Brotli compression, security headers, responsive layouts, reduced-motion
  support, canonical URLs, sitemap, RSS, and pinned deployment dependencies

## Recommended order

1. Fix the contact CSP.
2. Fix the limiter retry.
3. Add resume validation.
4. Add filename and track-number preflight validation.
5. Add checked subprocess handling.
6. Address accessibility and caching findings.

This audit was read-only; nothing was published.

---

# Persistent streamer and playlist integration — 2026-07-15 00:43:54 PDT

The existing playlist system already contains most of what a persistent
streamer needs:

- The complete catalog in `assets/tracks.json`
- Stable track IDs
- Queue ordering and construction
- Play, pause, previous, next, and seeking
- Shared playlists encoded in URL hashes
- Short playlist links
- Saved playlists in `localStorage`
- Cross-site "Add to playlist" controls
- Endless shuffle
- MP3 stream URL generation

## Recommended design

Turn `/playlist/` into the basis of a dedicated continuous player. When a
visitor starts a playlist, offer an **Open continuous player** action that opens
or focuses a separate player window such as:

```text
/player/#p=track-id-1,track-id-2,track-id-3
```

Because that window is not replaced when the visitor navigates the main archive
tab, its audio element continues playing. It can reuse the existing track IDs,
catalog, saved playlists, shared links, and endless-shuffle behavior.

The existing **Build playlist** action could offer:

- **Play here** — the current behavior
- **Continuous player** — open or focus the persistent player

## Synchronization

Use:

- `localStorage` for durable queue and playback state
- The browser `storage` event for cross-tab changes
- `BroadcastChannel` for immediate messages between the archive tab and player

Adding or removing a song, selecting a saved playlist, or building a new queue
on the main site can then update the player without interrupting playback.

## Code organization

Avoid duplicating all of `playlist.js`. Extract the shared logic:

```text
playlist-core.js
  queue management
  track lookup and stream URLs
  saved playlists
  shuffle and filters

playlist.js
  existing /playlist/ interface

persistent-player.js
  dedicated player-window interface
  Media Session integration
  cross-tab synchronization
```

Both interfaces should use the same queue engine.

## Desired behavior

The continuous player should:

- Continue while visitors browse shows and songs
- Accept tracks from any page's `+` controls
- Load saved and shared playlists
- Show the current song, artist, show, and date
- Link back to the current track's show page
- Restore queue and position after an accidental close
- Support keyboard, headset, and lock-screen controls through Media Session
- Prevent two tabs from playing simultaneously
- Keep endless shuffle available

This is a lighter and safer project than converting the archive into a
single-page application. Most of the playlist logic already exists; the main
work is extracting shared logic, building the compact player page, and adding
cross-window synchronization.

---

## Download collection recommendations

**Added: 2026-07-15 14:46 PDT**

Both whole-show downloads and downloads containing every available performance
of a song would be useful, but they should be introduced in that order.

### Whole-show downloads

Every show page should have a clear **Download show** action. Where the source
material permits it, this could offer:

- **Complete recording** — the existing single lossless WAV or FLAC
- **Individual tracks (.zip)** — all lossless song files from the show

The track ZIP should extract into a self-contained directory:

```text
Jerry Hannan - 1999-02-01 - 19 Broadway/
  01 - I Thought I Was You (incomplete).flac
  02 - Perfect Autumn Day.flac
  03 - Song Title.flac
  cover.jpg
  show-info.txt
```

Use `Artist - YYYY-MM-DD - Venue` for the directory name and retain leading
track numbers in filenames. This sorts naturally and remains understandable
when separated from the website. `show-info.txt` should contain the date,
venue, source, set list, recording notes, and canonical show URL.

### Downloads of every performance of a song

An expanded entry on the Songs page could offer an action such as:

> **Download all 14 performances · 612 MB**

This is a particularly good fit for the archive because the Songs page already
models the relationship between a song and all of its performances. The ZIP
should use a flat, chronological layout:

```text
Perfect Autumn Day - Live Performances/
  1999-02-01 - Jerry Hannan - 19 Broadway - 02.flac
  1999-03-29 - Jerry Hannan - 19 Broadway - 14.flac
  1999-05-01 - Mad Hannans - 4th Street Tavern - 07.flac
  collection-info.txt
```

Begin each filename with its date, followed by artist, venue, and original show
track number. Avoid artist/show subdirectories unless a song has so many
performances that a flat directory becomes difficult to browse.

The website can control the downloaded archive name and the paths within it,
but it cannot reliably choose the visitor's download or extraction destination.
Those locations remain controlled by the browser and extraction software.

### Recommended implementation order

1. Keep the existing complete-show WAV/FLAC download.
2. Add **Download individual tracks (.zip)** to show pages.
3. Add **Download all performances (.zip)** to expanded song entries.
4. Let one password authorization cover the complete collection instead of
   prompting separately for every file.

Avoid permanently storing a ZIP for every song because that duplicates a large
amount of lossless audio in R2. Prefer small collection manifests listing the
R2 objects and a dedicated, authenticated endpoint that streams the resulting
ZIP. Prebuilt show ZIPs are a reasonable fallback if dynamic ZIP creation is
unreliable, since the archive has a comparatively small number of shows.

Whole-show track ZIPs are the essential feature. Song-performance ZIPs are a
strong second feature that would make the archive unusually useful. Both should
remain lossless and archival rather than reintroducing ordinary MP3 downloads.

---

## Persistent site player recommendation

**Added: 2026-07-15 19:56 PDT**

The recently shipped continuous-player popup is technically sensible, but it
does not fully match the intended experience. Users want the website itself to
feel like one continuous listening environment. A separate popup feels
detached, is awkward on mobile, may be blocked by the browser, and creates
competing playback systems.

The browser constraint is that audio owned by a normal page stops when that
page performs a full navigation. A service worker, `localStorage`, or
`BroadcastChannel` can preserve state, but they cannot keep that page's
`<audio>` element alive after it unloads.

The preferred direction is a progressively enhanced persistent site shell:

```text
Persistent site shell
├── Header and navigation
├── Replaceable page content
└── Persistent bottom player
    ├── Now playing
    ├── Playback controls
    └── Expandable queue
```

Same-site links would be intercepted, the next page fetched, and only the
central content replaced. The audio player would remain mounted while the URL,
browser history, title, and page content change.

Direct visits and unsupported browsers would still receive ordinary static
HTML. This preserves the strengths of the existing generated archive without
requiring a full single-page application.

### Recommended user experience

Once playback begins, display one compact player fixed to the bottom of every
page:

- Track title, artist, show date, and venue
- Play/pause, previous, and next controls
- Progress and elapsed time
- An obvious **Up next** button
- A stop or close control
- Expandable queue on desktop
- Full-screen player and queue on mobile

Every song, show, and playlist should use the same actions:

- **Play now** — replace the queue and begin playing
- **Play next** — insert immediately after the current track
- **Add to queue** — append without interrupting playback

A show becomes a predefined queue of its songs. A saved or shared playlist is
another queue source. An individual song uses the same engine. This avoids
separate playback behavior for songs, shows, and playlists.

### Recommended architecture

The current site effectively has three audio engines: the players on content
pages, the playlist player, and the separate continuous player. Their features
and behavior can drift—for example, the continuous player has Media Session
controls that the playlist player lacks.

Consolidate these around:

- One shared queue model using the existing track IDs and `tracks.json`
- One playback engine responsible for the active `<audio>` element
- One player interface with compact and expanded states
- Small adapters that convert a song, show, or playlist into queue operations
- `localStorage` to restore the queue, current track, volume, and approximate
  position after an accidental reload
- `BroadcastChannel` to coordinate tabs and ensure only one tab owns active
  playback

The popup can remain as an optional **Open in separate player** feature, but it
should not be the primary listening experience.

### Implementation approach

Avoid turning the archive into a large React application. Add a small
navigation layer that:

1. Intercepts eligible same-origin links.
2. Fetches the destination's generated HTML.
3. Extracts and replaces the main page content.
4. Updates the URL, browser history, title, metadata, and navigation state.
5. Initializes the controls in the new content.
6. Leaves the audio engine and player interface untouched.

Use normal navigation for external links, downloads, modified clicks, errors,
and pages that cannot safely be replaced. Deep links and direct visits will
continue to work normally.

The largest engineering challenge will be page-specific JavaScript. Scripts
for waveforms, track selection, search, and other features must initialize when
new content is inserted and clean themselves up before it is replaced.
Establish a small lifecycle convention such as `mountPage()` and
`unmountPage()` rather than depending only on initial page-load events.

### Suggested rollout

1. Extract the queue and playback behavior into one shared engine.
2. Add the persistent bottom-player interface.
3. Make all song, show, and playlist controls send commands to that engine.
4. Store and restore queue state across reloads.
5. Add partial page navigation for the main archive routes.
6. Add cross-tab coordination.
7. Retain the popup as an optional secondary mode.

Treat the popup player as a successful proof that the streaming and queue
model work. The next version should make a persistent bottom player part of the
website itself, using partial page navigation and the existing static archive
machinery.

---

## Prevent simultaneous playback across pages

**Added: 2026-07-15 20:56 PDT**

The immediate problem is that the website has independent audio players:

- The continuous playlist player owns one `<audio>` element.
- A song selected on another page creates another `<audio>` element.
- The existing pause logic only coordinates players within the same page.

### Phase 1: Prevent simultaneous playback

Add a small shared playback-coordination module based on `BroadcastChannel`.

Whenever any player begins playing, it broadcasts that it is now the active
player. Every other open page or player window receives that message and
pauses its own audio.

Apply this to:

- Individual song and show-page players
- The `/playlist/` player
- The `/player/` continuous-player window
- Waveform players

Rules:

1. Starting a song on a page pauses the playlist.
2. Resuming the playlist pauses the page song.
3. Pausing or seeking does not affect other players.
4. Automatic progression to the next playlist song retains ownership.
5. Closing a page requires no special cleanup.

Include a `storage`-event fallback if older browser support proves necessary.

### Phase 2: Clarify the user experience

When a page song interrupts the continuous playlist, show a brief message in
the playlist:

> Playback paused because another song was started on the site.

Similarly, when the playlist takes control, update the page player immediately
so its play button no longer looks active. This prevents the technically
correct but confusing situation where audio stops without explanation.

### Phase 3: Unify playback commands

Extract a small shared API:

- `claimPlayback()`
- `pauseLocalPlayback()`
- `play()`
- `pause()`
- `playTrack(trackId)`
- `playQueue(trackIds)`
- `addToQueue(trackIds)`

Initially, the current players can keep their separate audio engines. They
would simply use the same coordination layer. This keeps the first fix small.

### Phase 4: Move toward one player

After the coordination fix is proven, consolidate the playlist,
continuous-player, and page-player logic around one queue and playback engine.

Page actions should eventually become:

- **Play now**
- **Play next**
- **Add to queue**

This produces a clearer model than allowing every page to operate an unrelated
player.

### Verification plan

Test these scenarios in at least two tabs:

1. Start the continuous playlist, then play a song on a show page.
2. Resume the playlist and confirm the show-page song stops.
3. Start songs from two separate pages.
4. Let a playlist advance automatically.
5. Use Media Session or headset controls.
6. Close the active tab and resume playback elsewhere.
7. Test desktop and mobile Safari, Chrome, and Firefox.
8. Confirm only one audible stream request remains active.

Implement Phase 1 first as an isolated bug fix. It solves the double-audio
problem without requiring the persistent-site-player redesign.
