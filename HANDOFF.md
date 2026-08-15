# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-15 · **Branch:** `player-consolidation`
(worktree `/home/renedebos/renedebos.com-player-consolidation`)

**Phase 1 for show pages is complete — Steps 4, 5a, 5b, and 5c are all
done and live in production.** Every public show page runs the shared
controller, and the legacy `wavesurfer.js` waveform engine (plus its
`/lab/wavesurfer/` prototype) is deleted; `player.js` is now the sole
legacy fallback. PR #3 (Step 4 + the 3-page canary, `7872882`), PR #4 (Step
5b's full rollout, `fd0a68e`), and PR #5 (Step 5c, `1a19160`) all merged,
deployed, and verified against real production. Most recent production
run: `browser_check.mjs --prod` across all 30 live show pages, **166/167
passed** — the one failure (`/playlist/ real legacy playback works`) was
investigated directly (a standalone Playwright reproduction against
production) and confirmed to be a pre-existing check-script timing flake,
not a regression: playback genuinely starts and advances, it just crosses
the `0:00` display slightly after the check's 2.5s wait on a colder run.
`/playlist/`/`playlist.js` are untouched by Step 5c's diff. A tenth review
found and fixed a real bug in Step 5b's rollback mechanism, and the "Step
5c deletion review" found and fixed a real test-quality gap in Step 5c's
breakage test (see below) — worth knowing about even though neither
affects anything currently live.

## ✅ Done this session — Step 4 through Step 5a

Plan: `plans/player-consolidation/player-consolidation-plan.md` (Step 4's
entry has the full architecture record and all corrections; Step 5's entry
has the 5a/5b/5c split and 5a's full result). Steps 1–3 were an earlier
session's.

### Phase 1 Step 4 — build, seventh review, browser pass

Unchanged from where this session started: `player-boot.js` mounts the
shared controller behind a runtime engine-selection gate (legacy defers,
controller claims; a 404/parse error/boot exception falls back to the
legacy pair at *runtime*, not just deploy time), gating both `player.js`
*and* `wavesurfer.js` since they're independently loaded on show pages. A
seventh Codex review's six findings were all confirmed and fixed with
proven regression tests (destroyed-controller reactivation via a leaked
listener, a silently-unmarked missing `data-item`, an overclaimed fallback
description, two real test gaps, a missed dynamic `import()` case). A real
local browser pass (`scripts/browser_check.mjs`, built this session,
checked in permanently) hit 38/38 against real Chromium/WebKit — real
production audio, real WaveSurfer, real `BroadcastChannel`, two breakage
scenarios against an isolated temp copy so the working tree was never at
risk.

### PR #3, an eighth review, and its fixes

Opened **https://github.com/renedebos/renedebos.com/pull/3** (branch
`player-consolidation` → `main`), following the `home-page` project's
established precedent — a real merge commit, not squash, so this branch's
individual history (including all seven review dispositions) stays visible
on `main`.

Before merging, ran `/review-step` focused on the PR's readiness and the
`--prod` extension built for Step 5a (below). Codex didn't flag anything in
that new code, but surfaced three real, **pre-existing** issues in Step 4's
original implementation:

1. **High-churn bug, not just cosmetic.** `player-views.js`'s `_render()`
   only gated the progress/canvas paint path on active state — a row's play
   button icon (`innerHTML`) and `aria-label` were being rewritten
   unconditionally on *every* `timeupdate` tick, for every row, active or
   not. Contradicted the plan's own "doesn't churn on inactive rows" claim;
   a test only ever watched the time label, missing it entirely. Fixed with
   one early return, gated on the same condition the progress block already
   used.
2. **A real unhandled-rejection path.** `player-boot.js`'s async peaks
   decoration runs after the page is already claimed, outside the
   synchronous boot try/catch — one row's `setPeaks()` throwing could abort
   the whole per-view decoration loop and, on retry, throw again into a
   genuinely unhandled rejection. Fixed with per-view exception isolation
   and a trailing catch; corrected two code comments that overclaimed what
   the shared try/catch actually protects.
3. **The verification harness didn't prove what it claimed.** View count
   was recorded but never compared to the real markup count; "legacy
   engine stayed dormant" only checked `player.js`'s marker, never
   `wavesurfer.js`'s. Fixed with a real `expectedViewCount` assertion and a
   pre-interaction `findAudioDeep()` check (zero real `<audio>` elements
   should exist anywhere before the first click, on a controller-engine
   page).

Each fix has a regression test independently proven to fail on the unfixed
code before being restored to passing (full detail:
`player-consolidation-codex.md`'s "Fixes applied" section). Local suite grew
to 61 (`test-player-controller.mjs` 22, `test-player-views.mjs` 16,
`test-player-boot.mjs` 23); local browser pass grew to 44/44 (the extra 6
are the new finding-#3 checks, now running for real on all three pages).
Committed as `f784a0f`, pushed, PR commented with a summary. Rene merged
the PR himself.

### Step 5a — deployed and verified on production, for real

The deploy Action (`.github/workflows/deploy.yml`) ran clean on the merge
commit: both integrity gates, `wrangler deploy`, and the Cloudflare cache
purge all green.

**`scripts/browser_check.mjs` grew a `--prod` flag** (this session, part of
the PR): `--prod` (or `--base=<url>`) retargets the whole harness at a real
origin instead of the local `python3 -m http.server` copy, skipping only
the two breakage tests (they manipulate a local filesystem copy — no live
equivalent) and adding two checks a local server can't meaningfully run:
asset `Content-Type`/`Cache-Control` against `_headers`' documented policy,
and confirmation that five representative non-allowlisted pages (covering
every architecturally distinct template/engine) are unaffected, three with
confirmed real legacy playback. Default (no-flag) behavior is unchanged —
this stays the same tool 5b will reuse against a much larger page set.

**Run against `https://renedebos.com`: 55/58 passed on the second run.**
Everything player-consolidation actually built checked out for real on
production: controller mounts with the correct view count and both legacy
engines provably stay dormant (the corrected finding-#3 checks) on all
three allowlisted pages; real playback/toggle/seek/Space/canvas against the
live stream; Hero → track → next; deep-link + a real user-gesture Retry
click recovering from a policy-blocked autoplay; the
`mad-sweetwater-2000-10-17` alt-transfer case; real cross-tab
`BroadcastChannel` claim/pause with `/playlist/`; correct headers on all
four new JS assets; and the five non-allowlisted sample pages correctly
unaffected.

**Two things worth knowing about, neither a defect in this PR's code:**

- **A transient anomaly on the very first production hit, which did not
  reproduce.** Immediately after the deploy Action's purge step went green,
  the very first `--prod` run failed broadly (`views=0`, legacy engines
  appeared active, an unguarded locator timeout crashed the script). A
  direct `curl` of the identical URL at that same moment showed the
  correct deployed HTML (`cf-cache-status: MISS`, the real markup, the real
  flag) — so *a* request at that moment got the right page (this doesn't
  prove Playwright's specific request hit the same edge response, just that
  the deploy itself wasn't broken). A standalone diagnostic script and a
  full second `--prod` run, both a few minutes later, came back clean. Read
  as a cold-start/edge-propagation timing artifact specific to the first
  request right after a fresh deploy+purge, not a
  code defect — logged rather than discarded, since not reproducing twice
  is evidence, not proof. If this shows up again, the fix is a longer
  post-green buffer before the first production check.
- **A real, reproducible, pre-existing console error, unrelated to this
  PR.** All three canary pages (and, confirmed by checking `/contact/`,
  every other page on the site too) show one CSP violation: Cloudflare's
  own auto-injected analytics beacon
  (`static.cloudflareinsights.com/beacon.min.js`) is blocked by the site's
  existing `script-src 'self' 'unsafe-inline'` CSP, which has no exception
  for it. This has presumably always been true — it was never caught before
  because no prior deploy ever ran a real-browser console-error check
  against the live Cloudflare-proxied origin (the local `http.server` pass
  can't reproduce it; Cloudflare only injects the beacon on the real
  proxied origin). Reported to Rene, not fixed here — `_headers`/CSP is
  `deploy-infra` territory, out of this step's scope by design.

## A ninth review, and prep fixes for 5b

Before starting 5b, ran a Codex review (via the MCP `codex` server directly
this time, at Rene's request, rather than `scripts/codex_review.sh` — same
verify-then-disposition discipline either way) asking specifically whether
the project is ready for it. Conclusion: the shared runtime is ready, but
`browser_check.mjs` and one `pages.py` comment were not — all fixed:

- **`browser_check.mjs`'s per-page loop had no error isolation** — a single
  page crashing (exactly what happened on 5a's first production hit) used
  to abort evaluation of every remaining page. Now catches, records a
  synthetic failure, and moves on.
- **The known Cloudflare-beacon CSP warning would have multiplied ~10x**
  once every show page joins the allowlist. Now filtered out of the
  "no console errors" checks specifically (not a general CSP-ignoring
  policy — just this one confirmed, pre-existing, unrelated message).
- **The wavesurfer.js dormancy check raced an async fetch** — hardened with
  an explicit `networkidle` wait before it runs.
- **The non-allowlisted show-page sample was hardcoded** to a page that
  would silently become wrong (and wrongly-passing) the moment 5b allowlists
  it. Now picked dynamically from `assets/home-shows.json` at runtime,
  gracefully skipped if none remain non-allowlisted.
- **A genuinely dangerous stale comment in `pages.py`** said "Step 5 empties
  this out and flips the engine on everywhere" — backwards: the gate is a
  membership check, so emptying the set disables the controller everywhere.
  Corrected.
- **Added `verify_markup.py --check-allowlist-coverage`** (not part of the
  default build gate — today's 3-page allowlist is intentionally partial) —
  5b's own implementation should run this once it widens
  `CONTROLLER_ENGINE_SLUGS`, to confirm no public show was missed. Confirmed
  today it correctly fails, listing all 27 not-yet-allowlisted shows.

All verified: local `browser_check.mjs` pass still 44/44; the `isRemote`
code path verified by pointing `--base=` at a local server standing in for
production (never touched real production for this) — 54/58, the 4
non-passes being expected artifacts of a bare `python3 -m http.server` not
setting Cloudflare's real cache headers, not a regression. Full disposition:
`player-consolidation-codex.md`'s ninth review.

## Step 5b — every show page, implemented and locally verified

`CONTROLLER_ENGINE_SLUGS` (`pages.py`) is now
`{s["slug"] for s in PUBLIC_SHOWS} - CONTROLLER_ENGINE_EXCLUDED_SLUGS` —
computed from the real show catalog, not hand-listed, so a future new show
is covered automatically. `CONTROLLER_ENGINE_EXCLUDED_SLUGS` (empty today)
is a per-show rollback escape hatch if one specific page turns out to have
a problem, without reverting the whole rollout.
`verify_markup.py`'s default build gate now asserts full coverage (this
was previously opt-in-only, back when the 3-page rollout was intentionally
partial).

**`browser_check.mjs` restructured, not just widened**, since running the
full real-audio-playback sequence on all 30 pages would be slow and (for
`--prod`) would stream real production audio 30 times for the same engine
code every time. Two tiers: a light structural check (mount, real view
count, both legacy engines' dormancy, console errors) on all 30 pages, and
the full interactive check (real playback/toggle/seek/Space/canvas) on 4
pages chosen for genuinely different markup shapes — the original 3 from
5a, plus `jerry-19-broadway-1999-03-29` (the catalog's largest page: 34
tracks, 5 recording cards). This page's heavy check now genuinely stress
tests the eighth review's inactive-row DOM-churn fix — a real
`MutationObserver` watches an inactive row through the whole
playback/toggle/seek/Space sequence and asserts zero mutations, not just
"other checks passed so it's probably fine" (added in the tenth review's
fixes, below). The show list itself is fetched once at runtime from
`assets/home-shows.json`, not hardcoded — this file should never need
manual updating again regardless of catalog size.

**Local pass: 185/185.** The `isRemote` code path verified against a local
server standing in for production (never touched real production for
this): same 4 known `Cache-Control` non-passes every prior
local-server-as-remote run has shown (a bare `http.server` doesn't set
Cloudflare's real headers — not a regression). Confirmed the
non-allowlisted-show-page check now correctly self-skips with a log
message, since every show is allowlisted post-5b — the defensive design
built for exactly this in the ninth review's fixes, exercised for real for
the first time.

## A tenth review — on the 5b implementation itself, not just readiness

Run before merging PR #4, same `/review-step` discipline. Found one real bug
and two lower-stakes gaps:

- **The rollback escape hatch was broken by its own build gate — the
  important finding.** `CONTROLLER_ENGINE_EXCLUDED_SLUGS` is supposed to let
  one show be rolled back without reverting the whole thing, but
  `verify_markup.py`'s coverage check (added for 5b, wired into the default
  gate) only checked `public - allowlisted`, so excluding any show
  immediately made the gate report it as "missing." Reproduced directly
  before fixing: simulating one exclusion produced exactly that error,
  meaning `build.py --check` — CI's real gate — would have failed the
  moment the escape hatch was ever actually used. Fixed with a three-way
  check (allowlisted, or deliberately excluded, or a genuine gap) plus a new
  `assets/controller-excluded-slugs.json` asset so `browser_check.mjs` can
  tell an intentional exclusion apart from a broken page. Simulated a real
  exclusion end-to-end (edited the generated asset, then a show page
  directly) to confirm the fix actually works before reverting the
  simulation cleanly.
- **`browser_check.mjs` trusted `home-shows.json` blindly.** Now asserts all
  4 `HEAVY_CHECK_SLUGS` are actually present in the fetched catalog, failing
  loudly instead of silently running a smaller stress-test set. The deeper
  gap — `home-shows.json` only includes track-listed shows, while
  `CONTROLLER_ENGINE_SLUGS` covers every public show — is documented but not
  fixed (they coincide today; fixing it properly means changing
  `home-shows.json`'s row-inclusion criteria, which the live homepage also
  depends on — a separate decision).
- **The "DOM-churn stress test" claim was overstated** until the
  `MutationObserver` addition above made it true instead of just softening
  the wording.

Full record, all findings independently verified (not taken on the review's
word — one reproduced by simulation): `player-consolidation-codex.md`'s
tenth review.

## 🔧 Next up

**Phase 1 for show pages is complete.** No further steps are defined in
this plan for show pages — `player.js` remains as the permanent legacy
fallback (it still serves song pages and `/playlist/` directly, and that's
out of scope for this initiative). Whether/when to start a Phase 2 (song
pages, `/playlist/`, or `/player/` onto the shared controller) is an open
question for Rene, not something to assume.

Two things still worth surfacing to Rene, neither urgent:
- The Cloudflare-beacon CSP issue found during 5a (a `deploy-infra` task,
  not part of this initiative).
- The pre-existing `/playlist/` timing flake in `browser_check.mjs` found
  during 5c's production verification (2.5s wait is occasionally too tight
  for the now-playing time display to have ticked past `0:00` — a
  check-script issue, not a site bug; a one-line fix if anyone wants to
  bump the wait).

## Gotchas learned this session

- **A production-origin browser check finds real things a local
  `python3 -m http.server` pass structurally cannot** — the Cloudflare
  beacon/CSP finding above is invisible locally by construction (Cloudflare
  only injects it on the real proxied origin).
- **A transient failure immediately after a fresh deploy+purge is a real
  possibility worth planning around**, not just a theoretical footnote —
  this session hit one on the very first post-deploy hit. Don't treat a
  single anomalous run as proof of a code defect without checking whether
  it reproduces; also don't wave away a single clean re-run as sufficient
  before checking whether the *page itself* (via a plain `curl`, no
  browser) was ever actually wrong at that moment.
- **`document.readyState` is not a shortcut for the DOMContentLoaded
  barrier.** Already `'interactive'` while deferred/module scripts run, so a
  "past loading, just go" branch would fire the legacy engine before a later
  module could claim the page.
- **A mutation test can be vacuous** — the partial-mount teardown test passed
  with the teardown deleted until its malformed item moved from a row (always
  normalized before anything mounts) to a hero card (mounted after).
- **`browser.newPage()` creates an isolated context per call** (its own
  storage/cache partition) — silently breaks `BroadcastChannel` between what
  look like tabs, and serves stale cached responses across what looks like a
  fresh load after a file changed on disk. Use one explicit, shared
  `browser.newContext()` per scenario; a fresh one specifically when a file
  on disk just changed and the next load must not see a cached response.
- **WaveSurfer.js v7 renders into a Shadow DOM by default** — Playwright
  locators pierce it automatically, raw `document.querySelectorAll()` inside
  `page.evaluate()` does not.

## Durable facts (don't undo)

- **`downloads.lossless` carries an R2 key, not a URL.** `/stream` hard-403s
  every `.wav`/`.flac`. Named `lossless`, not `flac` — 64 of 747 items are WAV.
- **Recording ids key on the lossless original**, not the stream key, which is
  not unique across transfers of one tape.
- **No BroadcastChannel wire-format change until `/playlist/` and `/player/`
  migrate** — the legacy engines still expect a bare string; cross-tab
  claim/pause between old and new pages is real, confirmed behavior (now
  confirmed on production too, not just locally).
- **Deep-link autoplay fires on initial load only**, deliberately — exact
  parity with the two legacy engines. Whether it actually plays depends on
  browser autoplay policy, not app logic.
- **A `wavesurfer.esm.js` failure kills waveform rows in BOTH engines** — it's
  the one dependency `wavesurfer.js` and `player-views.js` share. Not new,
  not a regression this initiative introduced — true since before it existed.
- **The controller's shared `<audio>` element is never appended to the
  document** — it's only inserted (by `WaveSurfer.create({ media: ... })`)
  once a row is upgraded on activation. This is what makes the
  pre-interaction `findAudioDeep()` dormancy check in `browser_check.mjs`
  valid: zero results before any click is the expected, correct state.
- Loudness control and sticky navigation remain **fully deferred**; see the
  plan's §2 and §5.
- Branch/worktree workflow is the plan's §8; sync with
  `git fetch origin && git merge origin/main` at session start and before a
  PR.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show". Player work:
`plans/player-consolidation/` (plan + `player-consolidation-codex.md`, eight
review passes with dispositions). Review loop: plan §7. Tests:
`node scripts/test-player-{controller,views,boot}.mjs`. Real-browser
verification: `scripts/browser_check.mjs` (needs `playwright-chromium`; add
`--prod` to point it at `https://renedebos.com` instead of a local copy —
see its header for setup and flags).
