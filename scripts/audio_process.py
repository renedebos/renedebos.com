#!/usr/bin/env python3
"""Committed engine for the AUDIO_PROCESSING.md workflow.

Replaces the previously ad-hoc, re-typed-each-run scripts so Phase 1/2 are a
versioned, reproducible tool. The doc remains the how/why; this is the what.

Subcommands
-----------
  diagnose <input-folder> [--artist ID] [--target LUFS]
      Phase 1. Probe every lossless file (loudness, peak, dynamics, DC, stereo,
      predicted true peak at target) and run the second-tier clipping check
      (clipcheck.py) on any file whose peak reaches full scale. MP3 sources are
      reported and skipped (lossless-only rule). Writes diagnostic_report.txt.

  process <input-folder> <output-folder> --target LUFS [--hpf [FREQ]] [--lpf]
          [--notch [FREQ]] [--notch-harmonics N] [--slug SLUG]
      Phase 2. One loudnorm/ebur128 MEASUREMENT pass, then one fixed linear
      gain (`volume`) at the measured value -- loudnorm never renders (workflow
      v6, WORKFLOW_VERSIONS[6]; the policy is in CLAUDE.md). Output mirrors the
      input container, plus a derived 320k MP3 and an audio MD5 per track. Re-measures
      the output (Pass 3) and VERIFIES it (flags TP over ceiling or LUFS drift).
      Resumable: skips tracks whose outputs already exist. With --slug, writes
      the provenance sidecar to data/processing/<slug>.json.

  verify <slug> [--drive "gdrive:.../<Work Folder>/Processed"]
      Re-read each track's published copy (R2, and with --drive the Drive
      Processed/ backup, which carries the same filenames), recompute the audio
      MD5, and confirm it matches the provenance sidecar — closing the
      integrity / drift-detection loop. A missing Drive file is a failure, not
      a skip.

Lossless-only, per the workflow: only *.flac / *.wav are processed; the served
MP3 is always derived from the processed lossless master.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

import clipcheck  # second-tier run-length clipping check (same dir)

from engine_analysis import (
    astats_channels, astats_field, defect_scan, fmt_dur, fmt_ts, ff_err,
    lead_num, lossless_files, max_short_term_momentary, mean_vol, measure,
    mp3_sources, preflight_track_files, probe, target_for,
)
from engine_catalog import recipe_signature, show_tags, tag_args
from engine_constants import (
    APPLAUSE_BODY_EXCESS, APPLAUSE_CREST_MIN, APPLAUSE_EDGE_S,
    APPLAUSE_LIMIT_DB, APPLAUSE_LRA_TOL, APPLAUSE_MIN_BENEFIT,
    APPLAUSE_MIN_SHORTFALL, APPLAUSE_TP_MAX_ATTEMPTS, APPLAUSE_WIN_S,
    ARTIST_TARGET, BUCKET, HPF_DEFAULT_HZ, LPF_DEFAULT_HZ,
    LPF_NYQUIST_MARGIN, LUFS_TOL, MP3_TP_MAX_ATTEMPTS, NOTCH_DEFAULT_HZ,
    NOTCH_DEPTH_DB, NOTCH_WIDTH_HZ, ROOT, TCAP_AUTO_ENGAGE_PCT,
    TCAP_AUTO_EVENT_S, TCAP_FRAME_MS, TCAP_LIMIT_DB, TCAP_MAX_GR,
    TCAP_MAX_NEAR_PEAK_PCT, TCAP_MIN_BENEFIT, TCAP_NEAR_PEAK_DB,
    TCAP_OVER_APPLAUSE_HELP, TCAP_REJECT_ENGAGE_PCT, TCAP_REJECT_EVENT_S,
    TCAP_REJECT_NEAR_PEAK_PCT, TCAP_TP_MAX_ATTEMPTS, TP_CEILING, TP_TOL,
)
from engine_planning import (
    limiter_chain, limiter_finalize, limiter_regions, linear_chain,
    plan_track, tcap_chain, tcap_finalize, try_transient_cap, window_stats,
    _tcap_engagement,
)
from engine_rendering import (
    audio_md5, build_filters, encode_mp3_with_qa, ffmpeg_version,
    output_codec,
)
from engine_reporting import REDO_SLUGS, show_status
from engine_storage import r2_md5, remote_md5
from engine_versioning import WORKFLOW_VERSION, WORKFLOW_VERSIONS


# ── diagnose (Phase 1) ────────────────────────────────────────────────────────

def cmd_diagnose(args):
    folder = args.input
    target = target_for(args.artist, args.target)
    files = lossless_files(folder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {folder}")

    skipped = mp3_sources(folder)
    if skipped:
        print(f"Skipping {len(skipped)} MP3 source(s) (lossless-only rule): "
              + ", ".join(skipped[:4]) + (" ..." if len(skipped) > 4 else ""))

    rows, flags = [], []
    for f in files:
        p = os.path.join(folder, f)
        info = probe(p)
        sr, nch = int(info["sr"]), 2
        j = measure(p, target)
        I, LRA, TP = float(j["input_i"]), float(j["input_lra"]), float(j["input_tp"])
        ch_rms, peak_db, dc = astats_channels(p)
        nch = len(ch_rms) or 2
        pred = TP + (target - I)
        maxlin = I - TP - 1
        # clipping: astats screen, then run-length verdict only if peak at ceiling
        clip = "NONE"
        if peak_db is not None and peak_db not in ("inf", "-inf") and float(peak_db) >= -0.1:
            ch, srp = clipcheck.probe(p)
            a = clipcheck.decode_f32(p)
            worst_run = events = 0
            for c in range(ch):
                _, run, ev = clipcheck.analyse_channel(a[c::ch])
                worst_run = max(worst_run, run)
                events += ev
            clip, _ = clipcheck.classify(worst_run, srp, events)
        dc_bad = dc is not None and abs(float(dc)) > 0.01

        # DAT defect scan: dropouts (identical-sample runs) + clicks/steps
        dropouts, clicks = defect_scan(p, sr, nch)
        drops, drop_ms = len(dropouts), max((ms for _, ms in dropouts), default=0)
        # effective bandwidth vs container rate (catches mislabelled sample
        # rates and lossy-sourced files): high-band mean vs full-band mean
        cut = int(0.43 * sr)
        # 6 chained poles ≈ 36 dB/oct: steep enough that LF energy can't leak
        # through and mask a genuine null above the cutoff (a 2-pole highpass
        # measured a true 32k→48k upsample at only -37 dB; 6-pole: -63 dB)
        hp6 = ",".join([f"highpass=f={cut}"] * 6)
        full_v, hp_v = mean_vol(p, "anull"), mean_vol(p, hp6)
        # hp_v None with a measurable full band = literally nothing above the
        # cutoff (volumedetect can't say "-inf") — maximally deficient
        bw_delta = ((hp_v - full_v) if hp_v is not None else -99.0) \
            if full_v is not None else None
        bw_bad = bw_delta is not None and bw_delta < -55
        # channel health: L/R balance and mid/side relationship (phase)
        bal = (abs(ch_rms[0] - ch_rms[1])
               if nch == 2 and None not in ch_rms[:2] else None)
        sm = None
        if nch == 2:
            mid_v = mean_vol(p, "pan=mono|c0=0.5*c0+0.5*c1")
            side_v = mean_vol(p, "pan=mono|c0=0.5*c0-0.5*c1")
            if mid_v is not None and side_v is not None:
                sm = side_v - mid_v

        rows.append((f, info, I, LRA, TP, pred, maxlin, clip, dc_bad,
                     drops, drop_ms, bw_delta, bal, sm))
        if clip == "CLIPPING":
            flags.append(f"CLIPPING: {f} — likely audible; review/declip in Audacity.")
        if pred > -1:
            flags.append(f"PRED_TP: {f} — predicted {pred:+.1f} dBTP > -1 at {target}; "
                         f"max linear target {maxlin:+.1f} LUFS.")
        if LRA > 15:
            flags.append(f"HIGH_LRA: {f} — LRA {LRA:.1f} (very dynamic).")
        if dc_bad:
            flags.append(f"DC: {f} — DC offset {dc}.")
        if drops:
            where = ", ".join(f"{fmt_ts(t)} ({ms} ms)" for t, ms in dropouts[:5])
            more = f" +{drops - 5} more" if drops > 5 else ""
            flags.append(f"DROPOUT: {f} — {drops} identical-sample run(s) mid-track "
                         f"at {where}{more} (DAT error concealment?). Listen there.")
        if clicks:
            where = ", ".join(f"{fmt_ts(t)} ({kind}, step {st}, {m})"
                              for t, st, m, kind in clicks[:5])
            more = f" +{len(clicks) - 5} more" if len(clicks) > 5 else ""
            flags.append(f"CLICK: {f} — {len(clicks)} suspected digital defect(s) "
                         f"at {where}{more}. Listen there.")
        if bw_bad:
            flags.append(f"BANDWIDTH: {f} — energy above {cut/1000:.1f} kHz is "
                         f"{bw_delta:.0f} dB below full-band: content doesn't fill the "
                         f"{sr//1000} kHz container (mislabelled rate or lossy source?).")
        if bal is not None and bal > 4:
            flags.append(f"BALANCE: {f} — L/R RMS differs by {bal:.1f} dB.")
        if sm is not None and sm > 3:
            flags.append(f"PHASE: {f} — side energy {sm:+.1f} dB above mid: channels "
                         "largely out of phase (inverted channel?).")
        print(f"  {f}: in {I:.1f} LUFS, LRA {LRA:.1f}, TP {TP:.1f}, pred@{target} "
              f"{pred:+.1f}, clip {clip}, drops {drops}, clicks {len(clicks)}", flush=True)

        if getattr(args, "spectrograms", False):
            sdir = os.path.join(folder, "spectrograms")
            os.makedirs(sdir, exist_ok=True)
            png = os.path.join(sdir, os.path.splitext(f)[0] + ".png")
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-i", p, "-lavfi",
                            "showspectrumpic=s=2048x512:legend=1:gain=5",
                            png], capture_output=True)

    out = os.path.join(folder, "diagnostic_report.txt")
    L = ["DIAGNOSTIC REPORT",
         f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
         f"Files analyzed: {len(rows)}",
         f"Loudness target: {target} LUFS / {TP_CEILING} dBTP",
         "=" * 43, "",
         f"{'File':40s}|{'LUFS':7s}|{'LRA':5s}|{'TruePk':8s}|{'Pred':7s}|{'Clip':9s}|"
         f"{'DC':6s}|{'Drop':5s}|{'HiBand':7s}|{'Bal':5s}|S-M",
         "-" * 118]
    for f, info, I, LRA, TP, pred, maxlin, clip, dc_bad, drops, drop_ms, bw, bal, sm in rows:
        L.append(f"{f[:40]:40s}|{I:7.1f}|{LRA:5.1f}|{TP:7.1f}T|{pred:+6.1f}|{clip:9s}|"
                 + ("OFFSET" if dc_bad else "OK    ").ljust(6)
                 + f"|{drops:5d}|"
                 + (f"{bw:+6.1f} " if bw is not None else "   --  ") + "|"
                 + (f"{bal:4.1f} " if bal is not None else "  -- ") + "|"
                 + (f"{sm:+.1f}" if sm is not None else "--"))
    L += ["", "FLAGS", "-----"]
    L += ["⚠ " + x for x in flags] if flags else ["(none)"]
    open(out, "w").write("\n".join(L) + "\n")
    print(f"\n[report -> {out}]  target {target} LUFS, {len(flags)} flag(s)")


def _num_set(s):
    """Parse a comma-separated track-number list ('3,7,12') into a set."""
    return {int(x) for x in s.split(",") if x.strip()} if s else set()


def _num_map(s):
    """Parse a comma-separated track:value list ('8:8.65,3:7') into a dict
    {track_num: float}. Used for --transient-cap-max-gr, an explicit
    per-track exception to the TCAP_MAX_GR policy ceiling — never a way to
    change the ceiling globally."""
    out = {}
    for pair in (s.split(",") if s else []):
        pair = pair.strip()
        if not pair:
            continue
        num, _, val = pair.partition(":")
        out[int(num)] = float(val)
    return out


# ── process (Phase 2) ─────────────────────────────────────────────────────────

def cmd_plan(args):
    """Dry run: the exact per-track decisions `process` would make, no audio
    written. Table + normalization_plan.txt in the input folder."""
    folder = args.input
    target = target_for(args.artist, args.target)
    files = lossless_files(folder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {folder}")
    pre = getattr(args, "eq", None) or ""

    rows = []
    counts = {"linear": 0, "linear-reduced": 0, "applause-limiter": 0,
              "sparse-transient-cap": 0}
    tcap_on = bool(getattr(args, "transient_cap", False))
    tcap_excl = _num_set(getattr(args, "transient_cap_exclude", ""))
    tcap_part = _num_set(getattr(args, "transient_cap_partial", ""))
    tcap_frc = _num_set(getattr(args, "transient_cap_force", ""))
    tcap_maxgr = _num_map(getattr(args, "transient_cap_max_gr", ""))
    for f in files:
        p = plan_track(os.path.join(folder, f), target, pre=pre,
                       transient_cap=tcap_on and lead_num(f) not in tcap_excl,
                       tcap_partial=lead_num(f) in tcap_part,
                       tcap_force=lead_num(f) in tcap_frc,
                       tcap_max_gr=tcap_maxgr.get(lead_num(f)),
                       tcap_over_applause=bool(getattr(args, "transient_cap_over_applause", False)))
        counts[p["mode"]] += 1
        j = p["measure"]
        rows.append((f, float(j["input_i"]), float(j["input_tp"]), p))
        reg = ""
        if p["mode"] == "applause-limiter":
            reg = ("; limit " + ", ".join(f"{fmt_ts(a)}-{fmt_ts(b)} (-{r} dB)"
                                          for a, b, r in p["regions"])
                   + f"; music peak {p['music_peak_db']:.1f} dB")
        elif p["mode"] == "sparse-transient-cap":
            t = p["tcap"]
            reg = (f"; cap {t['gr_db']:.1f} dB max, ~{t['engaged_pct']:.1f}% engaged "
                   f"({t['events']} event(s), longest {t['longest_s']:.2f} s), "
                   f"{t['near_peak_pct']:.1f}% near-peak")
        print(f"  {f}: in {float(j['input_i']):.1f} LUFS, pred {p['pred']:+.1f} dBTP "
              f"-> {p['mode']} @ {p['target']:+.1f} LUFS{reg}", flush=True)
        for fl in p["flags"]:
            print(f"    ⚠ {fl}", flush=True)

    out = os.path.join(folder, "normalization_plan.txt")
    L = [f"NORMALIZATION PLAN (dry run, workflow v{WORKFLOW_VERSION})",
         f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
         f"Nominal target: {target} LUFS / {TP_CEILING} dBTP; "
         f"applause limiter at {APPLAUSE_LIMIT_DB} dB (crest >= {APPLAUSE_CREST_MIN}, "
         f"edge {APPLAUSE_EDGE_S:.0f} s)"
         + (f"; transient cap OPTED IN (limit {TCAP_LIMIT_DB} dB, max "
            f"{TCAP_MAX_GR:g} dB, sparsity <= {TCAP_MAX_NEAR_PEAK_PCT:g}%)"
            if tcap_on else ""),
         "=" * 43, "",
         f"{'File':40s}|{'In LUFS':8s}|{'Pred TP':8s}|{'Mode':17s}|{'Out LUFS':9s}|"
         f"{'vs -20':7s}|Limited regions / flags",
         "-" * 120]
    for f, in_I, in_TP, p in rows:
        extra = "; ".join(
            ([", ".join(f"{fmt_ts(a)}-{fmt_ts(b)} (-{r} dB)" for a, b, r in p["regions"])]
             if p["mode"] == "applause-limiter" else []) + p["flags"])
        L.append(f"{f[:40]:40s}|{in_I:8.1f}|{p['pred']:+8.1f}|{p['mode']:17s}|"
                 f"{p['target']:9.2f}|{p['target'] - target:+7.2f}|{extra}")
    L += ["", f"Modes: {counts['linear']} linear, {counts['linear-reduced']} "
              f"linear-reduced, {counts['applause-limiter']} applause-limiter, "
              f"{counts['sparse-transient-cap']} sparse-transient-cap"]
    open(out, "w").write("\n".join(L) + "\n")
    print(f"\n[plan -> {out}]  {counts['linear']} linear / "
          f"{counts['linear-reduced']} reduced / {counts['applause-limiter']} limiter / "
          f"{counts['sparse-transient-cap']} tcap")


def cmd_process(args):
    infolder, outfolder = args.input, args.output
    target = args.target
    os.makedirs(outfolder, exist_ok=True)
    files = lossless_files(infolder)
    if not files:
        raise SystemExit(f"no .flac/.wav files in {infolder}")
    preflight_track_files(files)
    # nominal/unclamped, for the processing_report.txt header only — the actual
    # per-track chain (below) is Nyquist-aware and can differ from this on an
    # unusual low-sample-rate source; that per-track deviation is always
    # visible in that track's own recorded `chain`.
    filt_summary = build_filters(args)

    tag_ctx = show_tags(args.slug) if args.slug else None
    if args.slug and tag_ctx is None:
        print(f"note: {args.slug} not in recordings.json — no tags embedded")

    # Loaded up front (not just at the final merge) so a resume decision can
    # check what actually produced the existing per-track entry, and so a
    # resumed track's `ver` reports what really rendered it rather than
    # whatever WORKFLOW_VERSION this run happens to be.
    prev_tracks = {}
    if args.slug:
        prev_path = (getattr(args, "provenance_out", None)
                     or os.path.join(ROOT, "data", "processing", f"{args.slug}.json"))
        if os.path.exists(prev_path):
            try:
                prev_tracks = json.load(open(prev_path)).get("tracks", {})
            except Exception:
                prev_tracks = {}

    prov_tracks, report, warnings = {}, [], []
    for i, f in enumerate(files, 1):
        src = os.path.join(infolder, f)
        container = "flac" if f.lower().endswith(".flac") else "wav"
        out_audio = os.path.join(outfolder, f)
        out_mp3 = os.path.join(outfolder, os.path.splitext(f)[0] + ".mp3")
        num = lead_num(f)

        # Probed up front (not just in the render branch below) so the filter
        # chain can be built against THIS track's real sample rate — different
        # tracks in one folder can, in principle, have different rates, and
        # --lpf's Nyquist check needs to be per-track, not a single folder-wide
        # guess (fix for #6: an 18 kHz low-pass on a 32 kHz/16 kHz-Nyquist
        # source used to silently do nothing).
        info = probe(src)
        filt = build_filters(args, sr=int(info["sr"]))

        # Decide the effective per-track handling up front (source-only, cheap —
        # needed whether we process fresh or resume-skip). See plan_track: plain
        # linear when the nominal target fits under the TP ceiling; the v4
        # reduced "max linear target" for small overshoots (linear=true is only
        # a request — exceeding the ceiling silently switches loudnorm to
        # dynamic mode, which flattens fades); applause-aware limiting (v5)
        # when non-music transients are what's eating the headroom.
        tc_on = (bool(getattr(args, "transient_cap", False))
                 and num not in _num_set(getattr(args, "transient_cap_exclude", "")))
        tc_partial = num in _num_set(getattr(args, "transient_cap_partial", ""))
        tc_force = num in _num_set(getattr(args, "transient_cap_force", ""))
        tc_maxgr = _num_map(getattr(args, "transient_cap_max_gr", "")).get(num)
        recipe_sig = recipe_signature(target, filt, tc_on, tc_partial, tc_force, tc_maxgr,
                                      bool(getattr(args, "transient_cap_over_applause", False)))
        # Decoded once up front (extra cost paid on every track, resumed or
        # not) so a resume decision can prove "these are the exact bytes the
        # existing output's provenance claims to be built from", not just
        # "mtime looks plausible" — the source-side half of the #2 fix.
        src_md5 = audio_md5(src)
        tc_over_app = bool(getattr(args, "transient_cap_over_applause", False))
        plan = plan_track(src, target, pre=filt, transient_cap=tc_on,
                          tcap_partial=tc_partial, tcap_force=tc_force,
                          tcap_max_gr=tc_maxgr,
                          tcap_over_applause=tc_over_app)
        used_target = plan["target"]
        limiter = plan["mode"] == "applause-limiter"
        tcap = plan["mode"] == "sparse-transient-cap"
        in_I_chk = float(plan["measure"]["input_i"])
        in_TP_chk = float(plan["measure"]["input_tp"])
        for fl in plan["flags"]:
            print(f"  ⚠ {f}: {fl}", flush=True)
        # A tcap track flagged for ears is a HARD gate, not a warning: nothing
        # ships unheard. Resolve by listening and re-running with an explicit
        # per-track decision — accept (ears approved) or exclude (stay linear).
        blocking = [fl for fl in plan["flags"] if "listen before shipping" in fl]
        if tcap and blocking and not tc_force and num not in _num_set(
                getattr(args, "transient_cap_accept", "")):
            raise SystemExit(
                f"{f}: the transient cap flagged this track for ears:\n  - "
                + "\n  - ".join(blocking)
                + f"\nListen first (scripts/ab_compare.py <slug> {num}), then re-run "
                  f"with --transient-cap-accept {num} (ears approved) or "
                  f"--transient-cap-exclude {num} (keep it linear). "
                  "Nothing was rendered for this track and nothing was uploaded.")

        # Resume-skip only if the existing output isn't stale: if the source was
        # re-exported (e.g. Rene fixed a click in Audacity) after this render, its
        # mtime moves past the output's and the old render must not be trusted
        # just because a same-named file happens to exist. Also stale if the
        # RECIPE changed — target, filter chain, or transient-cap treatment —
        # even though the source bytes and mtime didn't. Previously only mtime
        # was checked, so a later run requesting a different --target/--eq/
        # --hpf/--transient-cap for an unchanged source would silently reuse
        # the old render while writing provenance describing the newly
        # requested (but never actually rendered) chain. `recipe_sig` is only
        # compared when the existing provenance entry has one recorded — older
        # entries that predate this check fall back to the mtime rule alone,
        # so this fix doesn't force a mass reprocess of the whole archive.
        prev_entry = prev_tracks.get(str(num), {})
        recipe_changed = ("recipe_sig" in prev_entry
                          and prev_entry["recipe_sig"] != recipe_sig)
        src_changed = ("src_md5" in prev_entry
                       and prev_entry["src_md5"] != src_md5)
        mtime_stale = (os.path.exists(out_audio) and os.path.exists(out_mp3)
                       and os.path.getmtime(out_audio) < os.path.getmtime(src))
        stale = os.path.exists(out_audio) and os.path.exists(out_mp3) \
            and (mtime_stale or recipe_changed or src_changed)
        if recipe_changed:
            print(f"  {f}: the requested recipe (target/filters/transient-cap) "
                  "differs from what produced the existing output — ignoring it "
                  "and reprocessing", flush=True)
        elif src_changed:
            print(f"  {f}: source audio MD5 differs from what produced the "
                  "existing output (re-export with unchanged mtime?) — ignoring "
                  "it and reprocessing", flush=True)
        elif stale:
            print(f"  {f}: source is newer than the existing output — "
                  "ignoring it and reprocessing", flush=True)
        resumable = (os.path.exists(out_audio) and os.path.exists(out_mp3) and not stale)
        if resumable:
            # Confirm the existing output's bytes actually match what its own
            # recorded provenance claims before trusting a resume-skip at all
            # — recipe/mtime agreement doesn't by itself prove the file on
            # disk wasn't hand-edited, partially re-exported, or left over
            # from an interrupted run.
            existing_md5 = prev_entry.get("md5")
            if existing_md5:
                out_md5_now = audio_md5(out_audio)
                if out_md5_now != existing_md5:
                    print(f"  {f}: existing output's audio MD5 doesn't match its "
                          f"own recorded provenance ({out_md5_now[:8]} vs "
                          f"{existing_md5[:8]}) — cannot trust this resume-skip; "
                          "reprocessing", flush=True)
                    resumable = False
        if resumable and (tcap or limiter):
            # A resumed limiter render — applause-limiter (v5) or
            # transient-cap (v8) — is only trusted when it can PROVE its
            # chain: the .v8state.json written beside the accepted render
            # holds the gain/limit that actually produced the bytes (retries
            # may have moved both, and neither leaves a reliable loudness
            # fingerprint). Missing state, or an output over the strict
            # ceiling (interrupted mid-retry), means re-render — provenance
            # must never describe a chain it merely guesses.
            #
            # The gain CANNOT be recovered by measuring the output. Once a
            # limiter has pulled transients down, output loudness is no longer
            # input + gain, so `out_I - in_I` understates the gain actually
            # applied by however much the limiter took off. That subtraction is
            # what this code used to do for applause tracks, and it wrote a
            # `chain` that does not reproduce the bytes it describes.
            state_path = out_audio + ".v8state.json"
            try:
                st = json.load(open(state_path))
                # State files written before the applause mode persisted any
                # are transient-cap by construction; every newer one names its
                # mode, so a leftover from a run in the OTHER mode cannot be
                # misread as proof of this one.
                if st.get("mode", "sparse-transient-cap") != plan["mode"]:
                    raise ValueError("render-state file describes a different mode")
                plan["gain_db"], plan["limit_db"] = st["gain_db"], st["limit_db"]
                (tcap_finalize if tcap else limiter_finalize)(plan)
                used_target = plan["target"]
            except (OSError, ValueError, KeyError):
                print(f"  {f}: no usable render-state file for the existing "
                      "output — cannot prove what produced it; reprocessing",
                      flush=True)
                resumable = False
            if resumable:
                j2 = measure(out_audio, plan["target"])
                # Only the transient cap promises the strict ceiling. The
                # applause loop deliberately warns-and-keeps when it runs out
                # of retries, so re-checking its output here would strand
                # those tracks in a permanent re-render loop.
                if tcap and float(j2["input_tp"]) > TP_CEILING:
                    print(f"  {f}: existing output measures "
                          f"{float(j2['input_tp']):+.2f} dBTP (> {TP_CEILING} strict "
                          "ceiling; interrupted mid-retry?) — ignoring it and "
                          "reprocessing", flush=True)
                    resumable = False

        if resumable:
            # still record provenance from the existing output.
            if tcap or limiter:
                # j2 is measured, and plan's gain/limit were restored from the
                # render-state file above — the chain recorded below describes
                # the actual bytes, not a fresh guess and not an inference.
                pass
            else:
                # A plain linear render applies one unconditional `volume`, so
                # plan already describes the bytes exactly.
                j2 = measure(out_audio, used_target)
            note = {"linear-reduced": f" [target {used_target:+.1f} LUFS, linear-preserving]",
                    "applause-limiter": f" [target {used_target:+.1f} LUFS, applause-limited]",
                    "sparse-transient-cap": f" [target {used_target:+.1f} LUFS, transient-capped]",
                    }.get(plan["mode"], "")
            print(f"[{i:02d}/{len(files)}] {f} — exists, skipping (resume){note}", flush=True)
            in_I = in_I_chk if os.path.exists(src) else None
        else:
            if limiter:
                print(f"  {f}: applause transients set the ceiling (music peaks at "
                      f"{plan['music_peak_db']:.1f} dB) — linear {plan['gain_db']:+.1f} dB to "
                      f"{used_target:+.1f} LUFS with applause-only limiting "
                      f"({len(plan['regions'])} region(s), max {plan['max_reduction_db']:.1f} dB)",
                      flush=True)
            elif tcap:
                t = plan["tcap"]
                print(f"  {f}: sparse musical transients set the ceiling "
                      f"({t['near_peak_pct']:.1f}% near-peak) — {plan['gain_db']:+.1f} dB "
                      f"to the full {used_target:+.1f} LUFS target with a true-peak cap "
                      f"(max {t['gr_db']:.1f} dB, ~{t['engaged_pct']:.1f}% engaged)",
                      flush=True)
            elif used_target != target:
                print(f"  {f}: linear gain to {target} LUFS would hit {plan['pred']:+.2f} dBTP "
                      f"(> {TP_CEILING}) — using {used_target:+.1f} LUFS instead to keep "
                      f"true linear normalization (preserves fades/dynamics)", flush=True)
            in_I = in_I_chk
            pre = (filt + ",") if filt else ""
            codec = output_codec(info["bits"], info["sample_fmt"], container)
            if limiter:
                # alimiter thresholds SAMPLE peaks; the archive's ceiling is a
                # TRUE (oversampled) peak. Render, measure the real output TP,
                # and back the gain off if it overshot — don't trust the
                # threshold alone (see APPLAUSE_TP_MAX_ATTEMPTS). Tags are
                # rebuilt each attempt so the final render's embedded "-N LUFS"
                # comment always matches what was actually achieved.
                for attempt in range(1, APPLAUSE_TP_MAX_ATTEMPTS + 1):
                    tags = tag_args(tag_ctx, f, num, len(files), plan["target"])
                    af = limiter_chain(plan, pre=filt)
                    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                        "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                                       + tags + [out_audio], capture_output=True, text=True)
                    if r.returncode != 0:
                        break
                    tp_now = float(measure(out_audio, plan["target"])["input_tp"])
                    if tp_now <= TP_CEILING + TP_TOL:
                        break
                    overshoot = tp_now - TP_CEILING
                    if attempt == APPLAUSE_TP_MAX_ATTEMPTS:
                        # Out of retries — out_audio on disk is attempt N's render, at
                        # plan's CURRENT gain. Don't adjust plan any further: doing so
                        # without a matching re-render would make the provenance chain
                        # and applause_limiter.gain_db describe a gain that was never
                        # actually applied, even though lufs/tp below are measured
                        # honestly straight off the file. The TP>ceiling warning below
                        # already flags the shortfall from the real measurement.
                        break
                    # Backing off gain_db alone doesn't move an overshoot caused by
                    # the applause: alimiter clamps to limit_db regardless of how
                    # much pre-gain feeds it, as long as the input still exceeds
                    # that threshold — so a gain-only backoff leaves the applause's
                    # output level (and therefore its true peak) unchanged while
                    # only eating into the music's already-safe headroom. Back off
                    # limit_db by the same amount so the clamp itself moves, and
                    # gain_db in lockstep to preserve music_peak + gain <= limit
                    # (the invariant that keeps the limiter from ever touching
                    # anything classified as music).
                    delta = overshoot + 0.15
                    print(f"  {f}: attempt {attempt} measured {tp_now:+.2f} dBTP "
                          f"(> {TP_CEILING}) — backing off limiter threshold and gain by "
                          f"{delta:.2f} dB and re-rendering", flush=True)
                    plan["limit_db"] = round(plan["limit_db"] - delta, 2)
                    plan["gain_db"] = round(plan["gain_db"] - delta, 2)
                    limiter_finalize(plan)
                if r.returncode == 0:
                    # Persist what actually rendered, so a resumed run can prove
                    # the chain instead of inferring it from output loudness —
                    # which a limiter makes impossible. Both breaks that keep a
                    # render (the clean one and the out-of-retries one) leave
                    # plan describing exactly these bytes.
                    json.dump({"mode": "applause-limiter",
                               "gain_db": plan["gain_db"],
                               "limit_db": plan["limit_db"]},
                              open(out_audio + ".v8state.json", "w"))
                used_target = plan["target"]
            elif tcap:
                # Same measure-and-correct pattern as the applause loop, with two
                # deliberate differences. (1) On retry, limit_db moves first (the
                # v7 lesson: move the number that's stuck; gain is what delivers
                # the loudness) — but the moment lowering the threshold alone
                # would push the shave past the TCAP_MAX_GR attenuation cap, the
                # gain moves in lockstep instead, sacrificing a sliver of
                # loudness to keep the cap absolute. (2) Exhausting the retries
                # ABORTS and deletes the output instead of warning, and the
                # ceiling here is the strict -1.00 dBTP promise, not the
                # QA-tolerance one: a mode whose whole job is limiting music
                # transients must never ship an over-ceiling render.
                for attempt in range(1, TCAP_TP_MAX_ATTEMPTS + 1):
                    tags = tag_args(tag_ctx, f, num, len(files), plan["target"])
                    af = tcap_chain(plan, pre=filt)
                    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                        "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                                       + tags + [out_audio], capture_output=True, text=True)
                    if r.returncode != 0:
                        break
                    tp_now = float(measure(out_audio, plan["target"])["input_tp"])
                    if tp_now <= TP_CEILING:
                        # persist what actually rendered, so a resumed run can
                        # prove the chain instead of guessing it (and so
                        # provenance never describes bytes it didn't make)
                        json.dump({"mode": "sparse-transient-cap",
                                   "gain_db": plan["gain_db"],
                                   "limit_db": plan["limit_db"]},
                                  open(out_audio + ".v8state.json", "w"))
                        break
                    if attempt == TCAP_TP_MAX_ATTEMPTS:
                        for stalefile in (out_audio, out_mp3,
                                          out_audio + ".v8state.json"):
                            if os.path.exists(stalefile):
                                os.remove(stalefile)
                        raise SystemExit(
                            f"{f}: transient-cap could not bring the output under "
                            f"{TP_CEILING} dBTP in {TCAP_TP_MAX_ATTEMPTS} attempts "
                            f"(last measured {tp_now:+.2f} dBTP) — output deleted, "
                            f"aborting rather than shipping an over-ceiling render")
                    delta = (tp_now - TP_CEILING) + 0.15
                    new_limit = round(plan["limit_db"] - delta, 2)
                    gr_after = round(in_TP_chk + plan["gain_db"] - new_limit, 2)
                    if gr_after > TCAP_MAX_GR:
                        lock = round(gr_after - TCAP_MAX_GR, 2)
                        plan["gain_db"] = round(plan["gain_db"] - lock, 2)
                        print(f"  {f}: attempt {attempt} measured {tp_now:+.2f} dBTP "
                              f"(> {TP_CEILING}) — lowering threshold by {delta:.2f} dB "
                              f"and gain by {lock:.2f} dB (attenuation capped at "
                              f"{TCAP_MAX_GR:g} dB) and re-rendering", flush=True)
                    else:
                        print(f"  {f}: attempt {attempt} measured {tp_now:+.2f} dBTP "
                              f"(> {TP_CEILING}) — lowering the cap threshold by "
                              f"{delta:.2f} dB (gain untouched) and re-rendering",
                              flush=True)
                    plan["limit_db"] = new_limit
                    tcap_finalize(plan)
                used_target = plan["target"]
            else:
                tags = tag_args(tag_ctx, f, num, len(files), used_target)
                # v6: an explicit volume gain (the same number plan_track already
                # computed), not loudnorm at render time — loudnorm/ebur128 remain
                # the measurement tools (plan_track's own analysis pass), but the
                # signal change itself is now an unconditional multiply, so there
                # is no possibility of ffmpeg's linear-mode silently falling back
                # to dynamic (frame-adaptive) normalization at render time.
                af = linear_chain(plan, pre=filt)
                r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                    "-i", src, "-af", af, "-ar", str(info["sr"])] + codec
                                   + tags + [out_audio], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"  FAIL {f}: {r.stderr[-200:]}", flush=True)
                continue
            # v6: lossy encoding can overshoot the FLAC's true peak (clips on decode
            # even though the FLAC is fine). Never touch the FLAC master's gain for
            # this — it's an MP3-only, listener-convenience-format concern — so trim
            # a small extra volume cut into the MP3 encode alone and re-measure,
            # same measure-and-correct pattern as the applause true-peak loop above.
            # Factored into encode_mp3_with_qa() (also reused by make_stream_mp3.py's
            # whole-show proxies) so both encoders get the identical QA.
            mp3_result = encode_mp3_with_qa(
                out_audio, out_mp3, used_target, tags,
                on_trim=lambda attempt, tp_now, new_trim: print(
                    f"  {f}: MP3 true peak {tp_now:+.2f} dBTP — trimming MP3-only "
                    f"gain to {new_trim:.2f} dB total and re-encoding", flush=True))
            if not mp3_result["ok"]:
                print(f"  MP3 FAIL {f}: {mp3_result['stderr'][-200:]}", flush=True)
                continue
            j2 = measure(out_audio, used_target)

        out_I, out_TP, out_LRA = float(j2["input_i"]), float(j2["input_tp"]), float(j2["input_lra"])
        md5 = audio_md5(out_audio)
        mp3_md5 = audio_md5(out_mp3)
        max_m, max_s = max_short_term_momentary(out_audio)
        # the lossy encode can overshoot the FLAC's peaks — measure the MP3's
        # true peak too and warn if it would clip on decode
        mp3_tp = float(measure(out_mp3, used_target)["input_tp"])
        # verification (#7)
        status = f"target {used_target:+.1f}" if used_target != target else "OK"
        if limiter:
            status = f"limiter {used_target:+.1f}"
        if tcap:
            status = f"tcap {plan['tcap']['gr_db']:.1f}dB"
        if out_TP > TP_CEILING + TP_TOL:
            status = "TP>ceiling"
            warnings.append(f"{f}: achieved TP {out_TP:+.2f} dBTP exceeds {TP_CEILING} ceiling")
        if abs(out_I - used_target) > LUFS_TOL:
            status = "LUFS drift"
            warnings.append(f"{f}: achieved {out_I:.2f} LUFS drifts > {LUFS_TOL} from {used_target}")
        if abs(out_LRA - plan["in_lra"]) > APPLAUSE_LRA_TOL:
            # v6: checked on every mode, not just applause-limiter. A purely
            # linear gain (any mode) cannot change dynamic range at all — a
            # shifted LRA is exactly the signature of a hidden dynamic-mode
            # render, which is now structurally impossible (v6 renders with an
            # explicit volume gain, never loudnorm), or, for a limiter track,
            # of the limiter touching more than the applause transients.
            status = "LRA shifted"
            reason = ("limiter touched more than applause transients" if limiter
                      else "transient cap engaged beyond isolated transients — "
                           "this track may not belong in the mode" if tcap
                      else "linear gain should never change dynamic range")
            warnings.append(f"{f}: output LRA {out_LRA:.1f} vs source {plan['in_lra']:.1f} — "
                            f"{reason}; review")
        if mp3_tp > 0.0:
            status = "MP3 clips"
            warnings.append(f"{f}: MP3 true peak {mp3_tp:+.2f} dBTP — lossy overshoot "
                            "clips on decode (FLAC is fine; consider re-encode headroom)")
        track_chain = (limiter_chain(plan, pre=filt) if limiter
                       else tcap_chain(plan, pre=filt) if tcap
                       else linear_chain(plan, pre=filt))
        plr = round(out_TP - out_I, 2)
        if num is not None:
            # A resumed track's bytes were rendered by whatever version last
            # actually processed it, not necessarily this run's WORKFLOW_VERSION —
            # report that honestly instead of overwriting it on every resume.
            entry_ver = (prev_tracks.get(str(num), {}).get("ver", WORKFLOW_VERSION)
                         if resumable else WORKFLOW_VERSION)
            entry = {"ver": entry_ver, "chain": track_chain,
                     "lufs": round(out_I, 2), "tp": round(out_TP, 2),
                     "mp3_tp": round(mp3_tp, 2), "max_m": max_m, "max_s": max_s,
                     "lra": round(out_LRA, 2), "plr": plr, "md5": md5, "mp3_md5": mp3_md5}
            if in_I is not None:
                entry = {"ver": entry_ver, "chain": track_chain,
                         "in_lufs": round(in_I, 1),
                         "lufs": round(out_I, 2), "tp": round(out_TP, 2),
                         "mp3_tp": round(mp3_tp, 2), "max_m": max_m, "max_s": max_s,
                         "lra": round(out_LRA, 2), "plr": plr, "md5": md5, "mp3_md5": mp3_md5}
            # #2 fix: recorded so the NEXT run can prove a resume-skip's recipe
            # and source bytes both still match, instead of trusting mtime alone
            entry["recipe_sig"] = recipe_sig
            entry["src_md5"] = src_md5
            if used_target != target:
                entry["target_lufs"] = used_target
            if limiter:
                entry["applause_limiter"] = {"gain_db": plan["gain_db"],
                                             "limit_db": plan["limit_db"],
                                             "regions": plan["regions"]}
            if tcap:
                # the full guardrail record, per the 2026-08-08 review: depth
                # (gr/p95), duration (engaged %, longest event), and the
                # sparsity number that qualified the track — enough to audit
                # any capped track later without re-running the frame scan
                entry["transient_cap"] = dict(plan["tcap"])
                # policy_max_gr_db is always recorded (standard ceiling by
                # default) so a track is auditable even if TCAP_MAX_GR itself
                # changes later; override/override_note only appear when a
                # track's actual cut exceeds the STANDARD ceiling — i.e. an
                # explicit --transient-cap-max-gr exception, never silent.
                effective_max_gr = plan.get("max_gr", TCAP_MAX_GR)
                entry["transient_cap"]["policy_max_gr_db"] = effective_max_gr
                if plan["tcap"]["gr_db"] > TCAP_MAX_GR + 0.01:
                    entry["transient_cap"]["override"] = True
                    entry["transient_cap"]["override_note"] = (
                        f"exceeds the standard {TCAP_MAX_GR:g} dB policy ceiling — "
                        f"explicit per-track exception (--transient-cap-max-gr), "
                        f"ceiling raised to {effective_max_gr:g} dB for this render")
            # audit trail: what treatment this track got and WHY — the chain says
            # what ran; mode+note record the decision so Butter ("applause set the
            # ceiling, tail limited") reads differently from a track whose music
            # sets its own ceiling. Review flags travel with the note.
            entry["mode"] = plan["mode"]
            note = plan.get("note", "")
            if plan["flags"]:
                note += " [review: " + "; ".join(plan["flags"]) + "]"
            if note:
                entry["note"] = note
            prov_tracks[str(num)] = entry
        report.append((f, in_I, out_I, out_TP, status))
        print(f"[{i:02d}/{len(files)}] {f} -> {out_I:.2f} LUFS, TP {out_TP:.2f} "
              f"[{status}] md5 {md5[:8]}", flush=True)

    # processing report
    rp = ["PROCESSING REPORT",
          f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}",
          f"Filters: {filt_summary or 'none'}", f"Target: {target} LUFS / {TP_CEILING} dBTP",
          "=" * 43, "",
          f"{'File':40s}|{'In LUFS':8s}|{'Out LUFS':8s}|{'Out TP':8s}|Status",
          "-" * 82]
    for f, in_I, out_I, out_TP, status in report:
        rp.append(f"{f[:40]:40s}|{('%.1f' % in_I) if in_I is not None else '--':>8s}|"
                  f"{out_I:8.2f}|{out_TP:8.2f}|{status}")
    if warnings:
        rp += ["", "WARNINGS", "--------"] + ["⚠ " + w for w in warnings]
    open(os.path.join(outfolder, "processing_report.txt"), "w").write("\n".join(rp) + "\n")

    if args.slug:
        info0 = probe(os.path.join(infolder, files[0]))
        cont = "FLAC" if files[0].lower().endswith(".flac") else "WAV"
        whole = lambda x: int(x) if float(x) == int(x) else x
        dest = (getattr(args, "provenance_out", None)
                or os.path.join(ROOT, "data", "processing", f"{args.slug}.json"))
        # MERGE: keep any tracks not touched this run (possibly from an older
        # workflow version) and overlay the ones we just processed. This is what
        # lets one show hold a mix of versions — e.g. 29 tracks on v1 and a single
        # track later re-run on v2 with an added filter.
        merged, prev = {}, {}
        if os.path.exists(dest):
            try:
                prev = json.load(open(dest))
                merged = prev.get("tracks", {})
            except Exception:
                merged, prev = {}, {}
        merged.update(prov_tracks)
        # manual Audacity work beyond the standard fades/clip-fixes (e.g. whole-show
        # noise reduction); sticky across re-runs unless overridden on the CLI.
        pre_edits = getattr(args, "pre_edits", None) or prev.get("pre_edits")
        prov = {
            "slug": args.slug, "target_lufs": whole(target), "tp_ceiling": whole(TP_CEILING),
            "source": f"{info0['bits']}-bit / {int(info0['sr'])//1000} kHz {cont}",
            **({"pre_edits": pre_edits} if pre_edits else {}),
            "filters": filt_summary or "none",
            # last-run context; the per-track `ver`/`chain` are the authoritative
            # record for mixed-version shows.
            "workflow_version": WORKFLOW_VERSION, "ffmpeg": ffmpeg_version(),
            "date": datetime.date.today().isoformat(),
            "tracks": {k: merged[k] for k in sorted(merged, key=int)},
        }
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        json.dump(prov, open(dest, "w"), indent=2, ensure_ascii=False)
        open(dest, "a").write("\n")
        print(f"provenance -> {dest} (workflow v{WORKFLOW_VERSION}, "
              f"{len(prov_tracks)} track(s) this run, {len(merged)} total)")

    print(f"\nProcessed {len(report)} file(s). "
          + (f"{len(warnings)} warning(s) — see report." if warnings else "All within spec."))
    if warnings:
        sys.exit(2)


def cmd_verify(args):
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    show = next((s for s in data["shows"] if s["slug"] == args.slug), None)
    if not show:
        raise SystemExit(f"no show with slug {args.slug}")
    prov = json.load(open(os.path.join(ROOT, "data", "processing", f"{args.slug}.json")))
    by_num = {str(t["num"]): t for t in show["tracks"]}
    bad = 0
    for num, pt in prov["tracks"].items():
        want = pt.get("md5")
        key = by_num[num].get("flac") or by_num[num]["file"]
        got = r2_md5(key)
        ok = got == want
        bad += not ok
        print(f"  track {num}: R2 {'OK ' if ok else 'MISMATCH'} ({got[:8]} vs {want[:8]})")
        if args.drive:
            # The Drive Processed/ backup carries the same filenames publish_show.py
            # uploaded to R2 (it copies the one local out/ dir to both), so the
            # track maps by basename. Until 2026-08-22 this branch printed
            # "skipping" and the command still exited 0 (Codex review, finding 4).
            dpath = f"{args.drive.rstrip('/')}/{os.path.basename(key)}"
            dgot = remote_md5(dpath)
            dok = dgot == want
            bad += not dok
            verdict = "OK " if dok else ("MISSING " if not dgot else "MISMATCH")
            print(f"           Drive {verdict} ({(dgot or '-')[:8]} vs {want[:8]})")
    print(f"\n{len(prov['tracks'])} track(s) checked, {bad} mismatch(es)"
          + (" (R2 + Drive)" if args.drive else "") + ".")
    sys.exit(1 if bad else 0)


def cmd_retag(args):
    """Retro-fit embedded metadata tags onto already-published shows: download
    each FLAC+MP3 from R2, rewrite the container with tags (-c copy — the audio
    stream and its provenance MD5 are untouched), verify, and upload back.
    Records `tags_embedded` in the sidecar. Drive Processed/ backups are NOT
    refreshed here (slow, stall-prone) — do that separately per show."""
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    if args.slug:
        shows = [s for s in data["shows"] if s["slug"] == args.slug]
    elif args.all:
        shows = [s for s in data["shows"] if s.get("tracks")]
    else:
        raise SystemExit("give a slug or --all")

    for show in shows:
        slug = show["slug"]
        prov_path = os.path.join(ROOT, "data", "processing", f"{slug}.json")
        prov = json.load(open(prov_path)) if os.path.exists(prov_path) else {}
        if prov.get("tags_embedded") and not args.force:
            print(f"{slug}: already tagged ({prov['tags_embedded']}) — skipping "
                  "(--force to re-tag, e.g. after a make-edit retitle)")
            continue
        ctx = show_tags(slug)
        tracks = show["tracks"]
        work = os.path.expanduser(f"~/work/retag/{slug}")
        os.makedirs(work, exist_ok=True)
        print(f"\n{slug}: {len(tracks)} track(s)")
        bad = 0
        for t in tracks:
            for key in filter(None, (t.get("flac"), t.get("file"))):
                name = key.split("/")[-1]
                local = os.path.join(work, name)
                tmp = os.path.join(work, "tagged_" + name)
                if subprocess.run(["rclone", "copyto", f"{BUCKET}/{key}", local,
                                   "--s3-no-check-bucket"]).returncode != 0:
                    print(f"  DOWNLOAD FAIL {key}"); bad += 1; continue
                tags = tag_args(ctx, name, t["num"], len(tracks),
                                prov.get("target_lufs", -20), title=t.get("title"))
                extra = ["-id3v2_version", "3"] if name.lower().endswith(".mp3") else []
                r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                                    "-i", local, "-map", "0", "-c", "copy"]
                                   + extra + tags + [tmp],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    print(f"  RETAG FAIL {key}: {r.stderr[-120:]}"); bad += 1; continue
                if audio_md5(tmp) != audio_md5(local):
                    print(f"  AUDIO CHANGED (refusing) {key}"); bad += 1; continue
                os.replace(tmp, local)
                if subprocess.run(["rclone", "copyto", local, f"{BUCKET}/{key}",
                                   "--s3-no-check-bucket"]).returncode != 0:
                    print(f"  UPLOAD FAIL {key}"); bad += 1; continue
            print(f"  [{t['num']:02d}] {t['title']} ok", flush=True)
        if bad:
            print(f"{slug}: {bad} failure(s) — NOT marking tagged")
        else:
            prov["tags_embedded"] = datetime.date.today().isoformat()
            json.dump(prov, open(prov_path, "w"), indent=2, ensure_ascii=False)
            open(prov_path, "a").write("\n")
            print(f"{slug}: done, sidecar marked tags_embedded")
        # local copies are per-show scratch — drop them immediately or a long
        # --all run fills the disk (learned 2026-07-10: 5 shows died on ENOSPC)
        import shutil
        shutil.rmtree(work, ignore_errors=True)


def cmd_versions(args):
    """Decode the workflow-version registry: what each version's processing did."""
    print(f"Current workflow version: {WORKFLOW_VERSION}\n")
    for v in sorted(WORKFLOW_VERSIONS):
        meta = WORKFLOW_VERSIONS[v]
        print(f"v{v}: {meta['desc']}")
        for k, val in meta.items():
            if k == "desc":
                continue
            print(f"     {k}: {val}")
        print()


def cmd_history(args):
    """Show, per track, which workflow version and exact process chain was applied
    — including a single track re-run later on a newer version."""
    path = os.path.join(ROOT, "data", "processing", f"{args.slug}.json")
    if not os.path.exists(path):
        raise SystemExit(f"no provenance for {args.slug} (not processed via the engine)")
    prov = json.load(open(path))
    print(f"{args.slug}  —  last run: workflow v{prov.get('workflow_version','?')}, "
          f"ffmpeg {prov.get('ffmpeg','?')}, {prov.get('date','?')}")
    vers = {}
    for num in sorted(prov["tracks"], key=int):
        t = prov["tracks"][num]
        v = t.get("ver", "?")
        vers[v] = vers.get(v, 0) + 1
        if args.chains:
            print(f"  track {num:>2}: v{v}  {t.get('chain','(unknown)')}")
        else:
            print(f"  track {num:>2}: v{v}")
    summary = ", ".join(f"v{k}: {n} track(s)" for k, n in sorted(vers.items(), key=lambda x: str(x[0])))
    print(f"\n  {len(prov['tracks'])} track(s) — {summary}")


def cmd_status(args):
    """Compute each show's processing status (and per-track `processed`) from the
    sidecars. With --write, persist `processing_status` per show and `processed`
    per track into recordings.json so the data is browsable/checkable without drift
    (re-run after any processing). Without --write, just print the report."""
    data_path = os.path.join(ROOT, "data", "recordings.json")
    data = json.load(open(data_path))
    order = {"needs-processing": 0, "redo": 1, "partial": 2, "done": 3}
    rows, tally = [], {}
    for show in sorted(data["shows"], key=lambda s: order.get(show_status(s), 9)):
        st = show_status(show)
        tally[st] = tally.get(st, 0) + 1
        tracks = show.get("tracks") or []
        path = os.path.join(ROOT, "data", "processing", f"{show['slug']}.json")
        pt = json.load(open(path)).get("tracks", {}) if os.path.exists(path) else {}
        ndone = sum(1 for t in tracks if str(t["num"]) in pt)
        kind = "tracks" if tracks else "whole-show"
        rows.append((st, show["slug"], kind, ndone, len(tracks)))
        if args.write:
            show["processing_status"] = st
            for t in tracks:
                if str(t["num"]) in pt:
                    t["processed"] = True
                else:
                    t.pop("processed", None)  # keep it accurate, no stale flags
    print(f"{'STATUS':17s} {'KIND':10s} {'DONE':>7s}  SLUG")
    print("-" * 70)
    for st, slug, kind, nd, nt in rows:
        cnt = f"{nd}/{nt}" if nt else "—"
        print(f"{st:17s} {kind:10s} {cnt:>7s}  {slug}")
    print("\n" + "  ".join(f"{k}: {v}" for k, v in sorted(tally.items(), key=lambda x: order.get(x[0], 9))))
    if args.write:
        json.dump(data, open(data_path, "w"), indent=2, ensure_ascii=False)
        open(data_path, "a").write("\n")
        print(f"\nwrote processing_status (+ per-track processed) to {data_path}")
    else:
        print("\n(report only — pass --write to persist into recordings.json)")


def cmd_version_map(args):
    """Archive-wide view of which workflow version(s) are on each show's
    tracks — the source of truth for reprocessing triage. A show's tracks can
    legitimately span more than one version: re-running a single track later
    updates only that track's `ver`/`chain` in the sidecar and leaves the rest
    alone (see AUDIO_PROCESSING.md's provenance "merge, don't overwrite"
    note), so a show is not "done" in one uniform sense — it's done per-track.
    --version N lists every track anywhere in the archive still on that exact
    version, for finding reprocessing candidates without opening every show."""
    proc_dir = os.path.join(ROOT, "data", "processing")
    data = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    titles = {show["slug"]: {str(t["num"]): t["title"] for t in (show.get("tracks") or [])}
              for show in data["shows"]}
    sidecars = sorted(f[:-5] for f in os.listdir(proc_dir) if f.endswith(".json"))

    if args.version is not None:
        hits = []
        for slug in sidecars:
            prov = json.load(open(os.path.join(proc_dir, f"{slug}.json")))
            for num in sorted(prov.get("tracks", {}), key=int):
                if str(prov["tracks"][num].get("ver")) == str(args.version):
                    hits.append((slug, num, titles.get(slug, {}).get(num, "?")))
        print(f"{len(hits)} track(s) currently on workflow v{args.version}:\n")
        for slug, num, title in hits:
            print(f"  {slug}  track {num:>2} — {title}")
        return

    rows, totals = [], {}
    for slug in sidecars:
        prov = json.load(open(os.path.join(proc_dir, f"{slug}.json")))
        vers = {}
        for t in prov.get("tracks", {}).values():
            v = t.get("ver", "?")
            vers[v] = vers.get(v, 0) + 1
            totals[v] = totals.get(v, 0) + 1
        rows.append((slug, vers, len(vers) > 1, len(prov.get("tracks", {}))))

    if args.only_mixed:
        rows = [r for r in rows if r[2]]
        if not rows:
            print("No shows have mixed workflow versions across their tracks.")
            return

    print(f"{'SLUG':45s} {'TRACKS':>6s}  VERSIONS")
    print("-" * 90)
    for slug, vers, mixed, n in sorted(rows, key=lambda r: (not r[2], r[0])):
        summary = ", ".join(f"v{k}: {c}" for k, c in sorted(vers.items(), key=lambda x: str(x[0])))
        flag = "  ⚠ MIXED" if mixed else ""
        print(f"{slug:45s} {n:>6d}  {summary}{flag}")

    print(f"\nArchive-wide track totals: "
          + ", ".join(f"v{k}: {c}" for k, c in sorted(totals.items(), key=lambda x: str(x[0]))))
    if not args.only_mixed:
        nmixed = sum(1 for r in rows if r[2])
        print(f"{nmixed} show(s) have more than one workflow version across their tracks.")


def main():
    ap = argparse.ArgumentParser(description="Audio processing workflow engine.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("diagnose")
    d.add_argument("input")
    d.add_argument("--artist", choices=list(ARTIST_TARGET))
    d.add_argument("--target", type=float)
    d.add_argument("--spectrograms", action="store_true",
                   help="also write a spectrogram PNG per track (visual QA for "
                        "suspect tapes: dropouts show as vertical stripes)")
    d.set_defaults(func=cmd_diagnose)

    pl = sub.add_parser("plan", help="dry run: per-track normalization decisions "
                                     "(linear / reduced target / applause limiter) "
                                     "without writing any audio")
    pl.add_argument("input")
    pl.add_argument("--artist", choices=list(ARTIST_TARGET))
    pl.add_argument("--target", type=float)
    pl.add_argument("--eq", help="literal corrective-EQ chain that process would use "
                                 "(plan measures the post-EQ signal, like process does)")
    pl.add_argument("--transient-cap-over-applause",
                    dest="transient_cap_over_applause",
                    action="store_true", help=TCAP_OVER_APPLAUSE_HELP)
    pl.add_argument("--transient-cap", dest="transient_cap", action="store_true",
                    help="opt in to the v8 sparse-transient cap (see WORKFLOW_VERSIONS[8]); "
                         "plan shows which tracks would qualify and their predicted "
                         "cap depth/engagement")
    pl.add_argument("--transient-cap-exclude", dest="transient_cap_exclude", default="",
                    help="comma-separated track numbers to keep out of the cap "
                         "(same veto process honors)")
    pl.add_argument("--transient-cap-partial", dest="transient_cap_partial", default="",
                    help="comma-separated track numbers allowed PARTIAL capping: a "
                         "track needing > 6 dB of recovery gets the full 6 dB "
                         "attenuation and lands honestly short of target instead of "
                         "declining — Rene's explicit per-track opt-in, never automatic")
    pl.add_argument("--transient-cap-force", dest="transient_cap_force", default="",
                    help="comma-separated track numbers where Rene, AFTER LISTENING, "
                         "overrides the sparsity gate (and any listen-flags) for that "
                         "track — his ears outrank the calibrated gate; recorded in "
                         "provenance")
    pl.add_argument("--transient-cap-max-gr", dest="transient_cap_max_gr", default="",
                    help="comma-separated track:dB pairs (e.g. '8:8.65') raising the "
                         "6 dB attenuation ceiling for ONE track — an explicit, "
                         "recorded exception after a loudness-matched listening test, "
                         "never a way to change the archive-wide policy; every capped "
                         "track's provenance always records the ceiling that was in "
                         "effect (policy_max_gr_db) and flags an override when this "
                         "is used")
    pl.set_defaults(func=cmd_plan)

    p = sub.add_parser("process")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--target", type=float, required=True)
    p.add_argument("--hpf", nargs="?", const=HPF_DEFAULT_HZ, type=float, default=None,
                   metavar="FREQ",
                   help=f"high-pass at FREQ Hz (default {HPF_DEFAULT_HZ:g} Hz when "
                        "given with no value — DC/subsonic rumble only). 80 Hz sits "
                        "close enough to the guitar's 82 Hz low E to thin acoustic "
                        "guitar, so reaching up that high needs an explicit "
                        "frequency, e.g. --hpf 80, never the bare flag's default")
    p.add_argument("--lpf", action="store_true",
                   help=f"low-pass at {LPF_DEFAULT_HZ:g} Hz; automatically clamped "
                        "below the source's own Nyquist frequency (with a printed "
                        "note) instead of silently applying a no-op filter on a "
                        "low-sample-rate source")
    p.add_argument("--notch", nargs="?", const=NOTCH_DEFAULT_HZ, type=float, default=None,
                   metavar="FREQ",
                   help=f"narrow mains-hum notch at FREQ Hz (default {NOTCH_DEFAULT_HZ:g} "
                        "Hz -- US mains -- when given with no value; pass 50 for a "
                        "50 Hz-mains recording). Genuinely narrow (a few Hz wide), "
                        "unlike the old two-octave-wide cut this replaces")
    p.add_argument("--notch-harmonics", dest="notch_harmonics", type=int, default=0,
                   help="also notch this many harmonics above --notch's fundamental "
                        "(0, the default, = fundamental only; e.g. 2 adds narrow "
                        "notches at 2x/3x as well) — opt in only when a harmonic is "
                        "actually visible/audible on that recording, not by default")
    p.add_argument("--eq", help="literal ffmpeg corrective-EQ chain applied before "
                                "loudnorm (e.g. de-mud + presence + air for a muffled tape); "
                                "recorded per-track in provenance")
    p.add_argument("--pre-edits", dest="pre_edits",
                   help="non-standard manual edits already applied in Audacity before "
                        "this run (e.g. 'noise reduction (Audacity, whole show)'); "
                        "recorded show-level in provenance and shown on the site")
    p.add_argument("--slug", help="write provenance sidecar for this show slug")
    p.add_argument("--provenance-out", dest="provenance_out", default=None,
                    help="write the provenance sidecar to this path instead of "
                         "data/processing/<slug>.json. Required for loudness-variant "
                         "renders: the default path MERGES into the archive's own "
                         "sidecar, so a variant render would silently overwrite the "
                         "-20 archive's provenance with the variant's numbers.")
    p.add_argument("--transient-cap-over-applause",
                   dest="transient_cap_over_applause",
                   action="store_true", help=TCAP_OVER_APPLAUSE_HELP)
    p.add_argument("--transient-cap", dest="transient_cap", action="store_true",
                    help="opt in to the v8 sparse-transient cap for tracks whose own "
                         "sparse musical transients set the ceiling (never default; "
                         "per-track eligibility gates still apply — see "
                         "WORKFLOW_VERSIONS[8])")
    p.add_argument("--transient-cap-exclude", dest="transient_cap_exclude", default="",
                    help="comma-separated track numbers to keep OUT of the cap even "
                         "when eligible (they take the normal linear/linear-reduced "
                         "path) — Rene's per-track veto")
    p.add_argument("--transient-cap-accept", dest="transient_cap_accept", default="",
                    help="comma-separated track numbers whose 'listen before shipping' "
                         "flags have been reviewed and accepted; without this, a "
                         "flagged track ABORTS the run instead of shipping unheard")
    p.add_argument("--transient-cap-partial", dest="transient_cap_partial", default="",
                    help="comma-separated track numbers allowed PARTIAL capping: a "
                         "track needing > 6 dB of recovery gets the full 6 dB "
                         "attenuation and lands honestly short of target instead of "
                         "declining — Rene's explicit per-track opt-in, never automatic")
    p.add_argument("--transient-cap-force", dest="transient_cap_force", default="",
                    help="comma-separated track numbers where Rene, AFTER LISTENING, "
                         "overrides the sparsity gate (and any listen-flags) for that "
                         "track — his ears outrank the calibrated gate; recorded in "
                         "provenance")
    p.add_argument("--transient-cap-max-gr", dest="transient_cap_max_gr", default="",
                    help="comma-separated track:dB pairs (e.g. '8:8.65') raising the "
                         "6 dB attenuation ceiling for ONE track — an explicit, "
                         "recorded exception after a loudness-matched listening test, "
                         "never a way to change the archive-wide policy; every capped "
                         "track's provenance always records the ceiling that was in "
                         "effect (policy_max_gr_db) and flags an override when this "
                         "is used")
    p.set_defaults(func=cmd_process)

    v = sub.add_parser("verify")
    v.add_argument("slug")
    v.add_argument("--drive", help="Drive Processed/ path (best-effort)")
    v.set_defaults(func=cmd_verify)

    rt = sub.add_parser("retag", help="retro-fit embedded tags onto published shows "
                                      "(container rewrite, audio MD5 preserved)")
    rt.add_argument("slug", nargs="?")
    rt.add_argument("--all", action="store_true", help="every track-listed show")
    rt.add_argument("--force", action="store_true",
                    help="re-tag even if already tags_embedded (after catalog edits)")
    rt.set_defaults(func=cmd_retag)

    vs = sub.add_parser("versions", help="describe what each workflow version does")
    vs.set_defaults(func=cmd_versions)

    h = sub.add_parser("history", help="per-track workflow version + process chain for a show")
    h.add_argument("slug")
    h.add_argument("--chains", action="store_true", help="also print the literal filter chain")
    h.set_defaults(func=cmd_history)

    st = sub.add_parser("status", help="per-show processing status (done/partial/redo/needs-processing)")
    st.add_argument("--write", action="store_true",
                    help="persist processing_status (+ per-track processed) into recordings.json")
    st.set_defaults(func=cmd_status)

    vm = sub.add_parser("version-map", help="archive-wide view of which workflow version(s) "
                                            "each show's tracks are on; flags shows whose tracks "
                                            "span more than one version")
    vm.add_argument("--only-mixed", action="store_true",
                    help="only list shows with more than one workflow version across their tracks")
    vm.add_argument("--version", type=int,
                    help="list every track archive-wide currently on this exact workflow version")
    vm.set_defaults(func=cmd_version_map)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
