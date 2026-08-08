# Session Handoff — Hannan Recordings (renedebos.com)
**Date:** 2026-08-08 · **Branch:** `main` — everything below is committed & pushed
(`086ab8b`…`7adbf55`), deploys green and spot-checked live where anything
public changed (only inert surfaces: track-spec `tcap` field, treatment
labels/CSS — no audio shipped this session).

> Built, hardened, and shipped **workflow v8 — `sparse-transient-cap`** — plus
> a local control panel (`make tcap`) that drives the whole reprocess flow.
> Evidence base: a second blind A/B (Sweetwater 1999-05-18, clean pass on all
> three tracks) on top of yesterday's Cafe Java pair. Two codex-notes review
> rounds converged into the hardening; five explicit policy decisions were
> made by Rene along the way (all recorded below). **The Cafe Java reprocess
> is mid-flight: prepared and diagnose-cleared, NOT yet published** — that's
> the next session's first task.

## ✅ Done this session

### Second A/B round — mad-sweetwater-1999-05-18 (morning)
Loudness-matched blind A/B on Blahana (−6.0 gap), Smoke in Heaven (−5.5, two
close transients), The Kiss / Da Da Da (−3.0, LRA 14.5). **Rene heard no
difference on any of the three** at up to 5.9 dB of recovery. Sparsity was
verified *before* listening (0.1–0.3% near-peak vs Truck's then-believed
12.3%). This made two independent shows of evidence and green-lit the build.
(Also: yesterday's open item — 38 stale v1 files in Cafe Java Drive
`Processed/` — turned out already clean; 45/45 files correct, nothing to
delete.)

### Workflow v8 — sparse-transient-cap (built, then hardened same day)
In `audio_process.py`, strictly opt-in (`--transient-cap`), recorded in
provenance as mode **`sparse-transient-cap`**. Final state after the codex
convergence + Rene's decisions:

- **Chain:** `volume` gain → 4× oversample → `alimiter` 1 ms/50 ms at −1.5 dB
  internal → back to source rate. Applause-limiter takes precedence (music
  strictly linear beats capped music).
- **6 dB cap = the limiter's actual instantaneous ATTENUATION** (Rene's
  disambiguation of "gain reduction hard-capped at 6 dB"): sizing trims gain
  when full target would over-shave (lands ≤ ~0.5 dB shy, `target_lufs`
  recorded); true-peak retries move limit first, gain in lockstep once the
  cap is reached.
- **Tiered eligibility (second same-day revision, after the Hear Me case):**
  density and *engagement* are different measurements and the A/B evidence
  sampled engagement (passed tracks 0.1–0.8% engaged, events ≤ 0.15 s).
  AUTO: ≤ 2% near-peak, ≤ 1% engaged, ≤ 0.2 s longest event. REVIEW
  (capped but hard-blocked): to 5% / 2% / 0.5 s. Beyond: declined. Hear Me
  (1.7% density, 0.7% engaged) is auto-tier now.
- **Guardrails:** strict **−1.00 dBTP** post-render assertion for this mode
  (no QA tolerance) — deletes output and aborts on failure; `.v8state.json`
  beside each render so a resume proves its chain or re-renders; LRA gate
  unchanged; full stats in provenance (`transient_cap` dict incl. `in_lra`),
  surfaced in /archive-data/ tooltips + a "Transient-capped" filter chip.
- **Per-track decisions (all Rene's, never automatic):**
  `--transient-cap-exclude` (veto) · `--transient-cap-accept` (unblock
  listen-flags after ears) · `--transient-cap-partial` (over-6-dB-recovery
  track takes the full 6 dB shave and lands short — Rocky Road: −27.1 →
  −21.6 if chosen) · `--transient-cap-force` (ears override the gates; also
  implies accept). A tcap track with unresolved listen-flags **aborts the
  run before upload**.
- `publish_show.py`: passes all four through; **prepare now fingerprints the
  fetched sources** (per-file audio MD5 manifest → one hash in publish.json)
  and **publish aborts on mismatch** — same-count-different-bytes no longer
  passes.

### Control panel — `make tcap` → http://127.0.0.1:8769/ (scripts/tcap_ui.py + .html)
Follows the `edit_metadata.py` local-server pattern; scripts/ is
.assetsignore'd, never deployed. Layers: offline scan (gap-based candidacy,
ranked); per-show **Analyze** (R2 preliminary estimate — candidates only,
MD5-verified, audio deleted after — or **canonical** on the prepared Drive
sources, the one that supports publishing); persisted per-track decision
dropdowns (auto/exclude/accept/force; over-cap tracks get auto/partial),
fingerprint-bound; **Prepare / Publish** buttons driving publish_show with
live logs; generated **narrative summary** after each analysis; step tracker
(1 Prepare → 2 Canonical analysis → 3 Decisions → 4 Publish); **Diagnose
report** viewer (`/report/<slug>`); **"publish → LUFS" column** showing the
projected output under current decisions (flips to "re-analyze" when a
decision changed after the analysis — and the analyzer honors
exclude/partial/force exactly as publish does); CSRF token + Host/Origin
checks on POSTs; one job at a time; Analyze cancellable.

### CLAUDE.md amended (the wording Rene approved)
The linear-normalization section now distinguishes banned seconds-scale gain
riding from the sanctioned millisecond cap, records the two-show evidence,
tiers, attenuation cap, and override vocabulary. The "sanctioned exception"
paragraph covers both applause-limiter (v5) and transient-cap (v8).

## 🔜 Next session — finish the Cafe Java reprocess (mid-flight!)

State right now: **Prepared** today 15:17, fingerprint `66d9f3a405654e23`,
tracks/ on disk. Diagnose reviewed — **Rene cleared both items by ear**
(Blind Man 3:01 = musical transient; Clear Headed's minor clipping
inaudible). Canonical analysis has been run but **predates the last panel
changes** (tiered gates + decision snapshots), so:

1. **Analyze prepared (canonical)** once more — fresh verdicts under the
   tiered gates, decision-aware projections, honest Truck context line.
2. Expected shape (from the runs so far): tracks 1/3 plain linear to −20;
   most candidates WILL CAP to ~−20; 4/15/20 stay just under (<1 dB benefit);
   **Truck + Anna May applause-limited to ≈ −22.4/−22.3** (accepted outcome —
   don't chase −20 by stacking modes); **Rocky Road needs Rene's dropdown
   call: auto (stays −27.1) or partial (≈ −21.6)** — evidence-wise partial is
   within what he A/B'd; policy default is auto.
3. **Publish** from the panel (checkbox on). Engine enforces fingerprint,
   listen-flag blocks, strict ceiling regardless of the UI.
4. Then the human tail per runbook: draft_tracks FLAG review (reprocess
   re-derives titles — diff against archive spellings, the 2026-08-07 lesson),
   description/updates/history, build, commit, push, live spot-check. R2
   stale-file check after rename-y reprocesses.
5. After shipping the first capped show: add the caveat sentence to
   `/process/`'s "linear gain only" claim (public page must not contradict
   provenance), and consider `build_archive_zip.py` refresh later.

## ⚠️ Open items
- **Version-bump discipline becomes binding at first v8 publish:** today's
  within-v8 revisions were safe only because zero v8 tracks exist. From the
  Cafe Java publish onward, ANY change to cap thresholds/semantics = v9.
- **"Truck = 12.3% near-peak" carries an asterisk (found today):** that was
  measured on the applause-LIMITED published copy; the raw source reads 1.6%
  (un-limited applause is the peak reference). The density screen is
  reference-dependent — engagement at the real threshold is the deciding
  gate. Registry, context flags, and memory updated; don't re-quote 12.3%
  as a source property.
- Local A/B material: `~/work/hearme-ab/` (server was on :8770),
  `~/work/sweetwater-transient-ab/`, `~/work/tcap-test/` — all deletable by
  Rene (agent denied rm -rf). Yesterday's `~/work/rocky-road-ab`, `kiss-ab`,
  `cafe-java-spikes` likewise. **Keep** `~/work/mad-cafe-java-1999-09-09/`
  (prepared state + tracks) until published.
- Carried, still unverified: `/search/` index preload double-fetch check
  (DevTools → Network, exactly one `search-index.json` request).
- Carried, still true: publish_show's local `out/` resume-skip can resurrect
  stale files on multi-attempt publishes (tracks/ side is now
  fingerprint-guarded; out/ side relies on mtime + the tcap `.v8state.json`);
  every publish re-invokes draft_tracks and clobbers manual title fixes;
  CSP `unsafe-inline` known/unscoped; don't re-open caching/JSON-size.

## Gotchas learned this session
- **Near-peak density is reference-dependent** (see Truck above). Engagement
  stats at the actual limiter threshold are the robust measurement.
- **A published linear/linear-reduced FLAC is a valid analysis proxy** (linear
  transform of the source) but applause-limited tracks are NOT — the panel
  skips them in R2 mode and marks pre-v5 tracks approximate.
- **`alimiter` needs the gain, not just the threshold, to respect a cap** —
  the retry loop moves limit first (v7 lesson) but must move gain in lockstep
  once attenuation hits the cap, or the cap silently grows.
- **The panel's "+X dB" almost lied:** gain applied to the canonical source ≠
  improvement vs the live file (Luxury of Murder: +0.9 vs +2.2). Every
  user-facing number now says "vs live".
- **codex-notes.md review rounds were genuinely productive** — mode-string
  rename, in_lra provenance, strict ceiling, resume state, CSRF, fingerprint,
  the density/engagement distinction, and both summary-reporting bugs came
  from there. Push back where evidence says otherwise (3–6 dB forced review
  was rejected; the approval-ledger apparatus was rejected).
- **`/model` switching needs the interactive picker** for first-time Fable
  consent; `/model fable` as a typed command fails outside it.

## Durable facts (don't undo)
- **v8 exists but no published track carries it yet.** The archive's audio is
  unchanged since yesterday's Cafe Java v7 publish.
- **Five Rene decisions today:** (1) cap approved on two-show evidence;
  (2) 6 dB = actual attenuation; (3) partial capping = per-track opt-in only;
  (4) tiered gates (2%/1%/0.2 s auto · 5%/2%/0.5 s review); (5) force =
  after-listening override. All encoded in engine + CLAUDE.md +
  WORKFLOW_VERSIONS[8].
- **drum-control is deliberately NOT built** (codex proposal on file). Needs
  its own decision + A/B if ever. Truck/Anna May stay applause-limited.
- Modes stay exclusive — no stacking applause-limiter + cap without a new
  decision and listening evidence.
- The panel is the intended flow for cap-era reprocesses, but the engine's
  gates are the safety barrier; terminal and panel are equivalent.

## Reference
Runbook: `CLAUDE.md` → "Publishing a Split Show" (+ the amended
linear-normalization section). Panel: `make tcap` (8769). A/B tooling:
`scripts/ab_compare.py` / `ab_server.py`. Technical record:
`WORKFLOW_VERSIONS[8]` in `audio_process.py`. External review scratchpad:
`codex-notes.md` (untracked, not Rene's notes — verify before acting).
