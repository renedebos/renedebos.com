"""DSP planning / policy decisions: how one track gets normalized (workflow
v5 applause-aware headroom recovery, v8 opt-in sparse-transient-cap) and the
literal ffmpeg filter-chain builders for each render mode (linear,
applause-limiter, sparse-transient-cap). This is the policy core CLAUDE.md's
"Loudness policy" section governs -- read that in full before changing
anything here. Moved out of audio_process.py 2026-08-22 verbatim.
"""
import re
import subprocess

from engine_analysis import fmt_dur, fmt_ts, measure, probe
from engine_constants import (
    APPLAUSE_BODY_EXCESS, APPLAUSE_CREST_MIN, APPLAUSE_EDGE_S,
    APPLAUSE_LIMIT_DB, APPLAUSE_MIN_BENEFIT, APPLAUSE_MIN_SHORTFALL,
    APPLAUSE_WIN_S, TCAP_AUTO_ENGAGE_PCT, TCAP_AUTO_EVENT_S, TCAP_FRAME_MS,
    TCAP_LIMIT_DB, TCAP_MAX_GR, TCAP_MAX_NEAR_PEAK_PCT, TCAP_MIN_BENEFIT,
    TCAP_NEAR_PEAK_DB, TCAP_REJECT_ENGAGE_PCT, TCAP_REJECT_EVENT_S,
    TCAP_REJECT_NEAR_PEAK_PCT, TP_CEILING,
)


# ── normalization planning (workflow v5) ─────────────────────────────────────

def window_stats(path, pre="", win_s=APPLAUSE_WIN_S):
    """Per-window sample peak and RMS (dB), one decode pass. The raw material
    for telling applause from loud music: a clap is a millisecond spike
    towering over its window's RMS; genuinely loud music is sustained, so its
    peaks sit close to the local average."""
    sr = int(probe(path)["sr"])
    af = ((pre + ",") if pre else "") + (
        f"asetnsamples=n={int(win_s * sr)},"
        "astats=metadata=1:reset=1:measure_perchannel=none,"
        "ametadata=mode=print:file=-")
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error",
                        "-i", path, "-af", af, "-f", "null", "-"],
                       capture_output=True, text=True)
    wins, t, peak, rms = [], None, None, None
    for line in r.stdout.splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            if t is not None and peak is not None and rms is not None:
                wins.append((t, peak, rms))
            t, peak, rms = float(m.group(1)), None, None
            continue
        m = re.search(r"Overall\.Peak_level=(-?[\d.]+)", line)
        if m:
            peak = float(m.group(1))
        m = re.search(r"Overall\.RMS_level=(-?[\d.]+)", line)
        if m:
            rms = float(m.group(1))
    if t is not None and peak is not None and rms is not None:
        wins.append((t, peak, rms))
    return wins


def plan_track(path, target, pre="", transient_cap=False, tcap_partial=False,
               tcap_force=False, tcap_max_gr=None, tcap_over_applause=False):
    """Decide how one track gets normalized (workflow v5; v8 adds the opt-in
    transient_cap flag). Returns a dict: mode ('linear' | 'linear-reduced' |
    'applause-limiter' | 'transient-cap'), target (projected output LUFS),
    gain_db/limit_db/regions for limiter mode, the loudnorm measurement
    (reusable by process), in_lra, and human-review flags.

    With transient_cap=True (never the default), a track that would fall back
    to linear-reduced because MUSIC transients set the ceiling may instead be
    upgraded by try_transient_cap() — full-target gain plus a millisecond
    true-peak cap — when it passes the sparsity/size gates. applause-limiter
    still wins when it applies: it leaves the music strictly linear.

    Conservative by construction: only EDGE windows (within min(30 s, dur/6)
    of the head/tail — applause lives at split boundaries) can be applause,
    and only when the pure crest signature fires (peak >= 27 dB over the
    window RMS) or the window's peak beats the loudest BODY window by >= 2 dB
    (mixed final-chord+applause windows dilute crest). High-crest windows
    mid-song count as music — they cap the gain rather than get limited — and
    are flagged for ears. The gain is sized to the music peaks
    (gain <= limit - music_peak), so the limiter cannot engage on any window
    classified as music."""
    j = measure(path, target, pre=pre)
    in_I, in_TP, in_LRA = float(j["input_i"]), float(j["input_tp"]), float(j["input_lra"])
    pred = in_TP + (target - in_I)
    maxlin = round(in_I - in_TP + TP_CEILING, 2)
    plan = {"measure": j, "in_lra": in_LRA, "flags": [],
            "pred": round(pred, 2), "maxlin": maxlin}
    if pred <= TP_CEILING:
        plan.update(mode="linear", target=target,
                    note=f"one constant gain to the show target; predicted TP "
                         f"{pred:+.1f} dBTP fits under the {TP_CEILING:g} ceiling")
        return plan
    if pred - TP_CEILING <= APPLAUSE_MIN_SHORTFALL:
        # applause-limiter never engages on overshoots this small (not worth a
        # limiter), so the cap doesn't need to defer to it here
        if transient_cap and try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=tcap_partial, force=tcap_force, max_gr=tcap_max_gr):
            return plan
        plan.update(mode="linear-reduced", target=maxlin,
                    note=f"gain to {target:g} LUFS would overshoot the TP ceiling by "
                         f"{pred - TP_CEILING:.1f} dB — small enough to simply take the "
                         f"track's own max linear target; dynamics untouched")
        return plan

    wins = window_stats(path, pre=pre)
    if not wins:
        plan.update(mode="linear-reduced", target=maxlin,
                    note="window scan produced no data — fell back to the max linear target")
        plan["flags"].append("window scan produced no data — fell back to reduced target")
        return plan
    dur = wins[-1][0] + APPLAUSE_WIN_S
    # short songs: don't let the edge zones swallow the body of the piece
    edge_s = min(APPLAUSE_EDGE_S, dur / 6)
    body_peak = max((p for t0, p, _ in wins
                     if t0 >= edge_s and (t0 + APPLAUSE_WIN_S) <= dur - edge_s),
                    default=None)
    applause, music, mid_suspects = [], [], []
    for t0, peak, rms in wins:
        edge = t0 < edge_s or (t0 + APPLAUSE_WIN_S) > dur - edge_s
        # Two ways an EDGE window is applause: the pure signature (a spike
        # towering over near-silence), or a peak that beats everything in the
        # song's body by APPLAUSE_BODY_EXCESS — the final chord ringing under
        # the applause raises the window RMS and hides the crest, but a split
        # live tape whose loudest transient sits in the first/last seconds and
        # ISN'T applause is not a credible claim.
        is_applause = edge and (
            peak - rms >= APPLAUSE_CREST_MIN
            or (body_peak is not None and peak >= body_peak + APPLAUSE_BODY_EXCESS))
        if is_applause:
            applause.append((t0, peak))
        else:
            music.append((t0, peak))
            if not edge and peak - rms >= APPLAUSE_CREST_MIN:
                mid_suspects.append(t0)
    if mid_suspects:
        plan["flags"].append(
            "mid-song high-crest window(s) at "
            + ", ".join(fmt_ts(t) for t in mid_suspects[:4])
            + (f" +{len(mid_suspects) - 4} more" if len(mid_suspects) > 4 else "")
            + " — treated as music (caps the gain), listen to confirm")
    if not applause or not music:
        # the music itself sets the ceiling — exactly the case the opt-in
        # transient cap exists for (applause-limiter has nothing to act on)
        if transient_cap and try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=tcap_partial, force=tcap_force, max_gr=tcap_max_gr):
            return plan
        plan.update(mode="linear-reduced", target=maxlin,
                    note=f"gain to {target:g} LUFS would overshoot the TP ceiling by "
                         f"{pred - TP_CEILING:.1f} dB, and no applause was found at the "
                         f"head/tail — the music itself sets the ceiling, so the track "
                         f"takes its honest quieter max linear target")
        if not applause:
            plan["flags"].append("no applause found at head/tail — the music itself "
                                 "sets the ceiling; honest quieter target")
        return plan
    music_peak = max(p for _, p in music)
    gain = round(min(target - in_I, APPLAUSE_LIMIT_DB - music_peak), 2)
    benefit = gain - (TP_CEILING - in_TP)  # dB recovered vs the v4 reduced target
    if benefit < APPLAUSE_MIN_BENEFIT:
        if transient_cap and try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=tcap_partial, force=tcap_force, max_gr=tcap_max_gr):
            return plan
        plan.update(mode="linear-reduced", target=maxlin,
                    note=f"gain to {target:g} LUFS would overshoot the TP ceiling by "
                         f"{pred - TP_CEILING:.1f} dB; the loudest peaks are in (or "
                         f"within 2 dB of) the music itself, so limiting would only "
                         f"recover {max(benefit, 0):.1f} dB — the track takes its "
                         f"honest quieter max linear target instead")
        plan["flags"].append(f"applause limiting would only recover "
                             f"{max(benefit, 0):.1f} dB — not worth a limiter")
        return plan
    # Applause-limiter sizes its gain so the MUSIC peaks land at the ceiling,
    # which is why it can leave a track well short of a loud target: once the
    # clap is tamed, the music's own peaks are the wall. Where the cap is
    # opted into and the applause plan would still land >= 1 dB short, offer
    # the track to the cap first — it can go further by shaving the music's
    # transients too, exactly as it does on every non-applause track.
    #
    # Before 2026-08-16 this branch committed unconditionally and the cap was
    # never consulted, which stranded the archive's 42 applause-limited
    # tracks a median 6.7 dB below the rest of a loud render.
    #
    # STRICTLY OPT-IN (--transient-cap-over-applause), and that is not
    # cosmetic. Left automatic it silently rewrites the ARCHIVE too: measured
    # on mad-cafe-java-1999-09-09 at the normal −20 target, Truck moved from
    # applause-limiter @ −23.65 to sparse-transient-cap @ −20.0, and Anna May
    # from −22.26 to −20.3. Louder and arguably more consistent — but that is
    # a change to published audio, on the one track CLAUDE.md names as
    # never-cap material, with no listening test behind it. The loudness
    # variant campaign passes this flag; ordinary publishes never do, so the
    # archive keeps rendering exactly as it does today.
    #
    # Precedence is otherwise unchanged: when applause-limiting already
    # reaches the target it still wins, because leaving the music strictly
    # linear is the less invasive treatment.
    #
    # The sparsity screen is handed `music_peak` as its reference (see
    # try_transient_cap's docstring) — measuring against the clap would let
    # exactly the repeatedly-loud material the policy protects slip through.
    applause_target = round(in_I + gain, 2)
    if (transient_cap and tcap_over_applause
            and target - applause_target >= TCAP_MIN_BENEFIT):
        if try_transient_cap(plan, path, target, pre, in_I, in_TP,
                             partial=tcap_partial, force=tcap_force,
                             max_gr=tcap_max_gr, density_ref=music_peak,
                             fallback_desc="the applause-limiter's own target"):
            return plan
    plan.update(mode="applause-limiter", gain_db=gain, limit_db=APPLAUSE_LIMIT_DB,
                music_peak_db=music_peak, applause_windows=applause, dur=dur)
    limiter_finalize(plan)
    # Transparency (2026-08-08, codex-notes suggestion): when the cap was
    # requested but applause-limiter took precedence AND the track still lands
    # >= 1 dB short of nominal, measure the near-peak density fresh from THIS
    # source and report it as context — it answers "why not cap the rest?"
    # without anyone having to know the precedence rule. Informational only;
    # never changes the treatment.
    if transient_cap and target - plan["target"] >= TCAP_MIN_BENEFIT:
        fpeaks = [p for _, p, _ in window_stats(path, pre=pre,
                                                win_s=TCAP_FRAME_MS / 1000)]
        if fpeaks:
            top = max(fpeaks)
            near_pct = 100.0 * sum(1 for p in fpeaks
                                   if p >= top - TCAP_NEAR_PEAK_DB) / len(fpeaks)
            plan["near_peak_pct"] = round(near_pct, 2)
            why = ("the cap was offered this track first "
                   "(--transient-cap-over-applause) and declined — see the "
                   "decline flag above"
                   if tcap_over_applause else
                   "applause-limiter takes precedence; the music stays "
                   "strictly linear")
            # Only warn about the clap-as-yardstick distortion when applause
            # actually tops the file. On a track whose own music sets the peak
            # (Truck: music peak -0.0 dB, no applause regions) the screen is
            # already measuring against the music and the caveat would be
            # actively misleading — which is exactly how the "1.6% vs 12.3%"
            # figure got misattributed to this effect. See §4a-result of
            # plans/loudness-variants/loudness-variants-plan.md.
            caveat = ""
            if top - music_peak >= 1.0:
                caveat = (f" Caveat: applause tops this file by "
                          f"{top - music_peak:.1f} dB, so the screen is "
                          f"referenced to a clap and UNDERSTATES the music's "
                          f"own density; any stacked-cap question must be "
                          f"decided by engagement stats at a real threshold, "
                          f"not this number.")
            plan["flags"].append(
                f"context: {near_pct:.1f}% of 50 ms frames within 3 dB of this "
                f"source's overall peak (informational — {why}).{caveat}")
    return plan


def limiter_regions(applause, gain, limit_db, dur):
    return [(round(t0, 1), round(min(t0 + APPLAUSE_WIN_S, dur), 1),
             round(p + gain - limit_db, 1))
            for t0, p in applause if p + gain > limit_db]


def limiter_finalize(plan):
    """(Re)derive target/regions/note from plan's current gain_db/limit_db.
    Called after the initial sizing and again by cmd_process's true-peak
    safety loop whenever gain_db is backed off, so the provenance note always
    describes what was actually rendered, not the first guess."""
    regions = limiter_regions(plan["applause_windows"], plan["gain_db"],
                              plan["limit_db"], plan["dur"])
    max_red = max((r for _, _, r in regions), default=0.0)
    reg_txt = ", ".join(f"{fmt_dur(a)}–{fmt_dur(b)}" for a, b, _ in regions)
    plan["target"] = round(float(plan["measure"]["input_i"]) + plan["gain_db"], 2)
    plan["regions"], plan["max_reduction_db"] = regions, max_red
    plan["note"] = (f"applause (not music) set the ceiling: one constant "
                    f"{plan['gain_db']:+.1f} dB gain sized to the music peaks "
                    f"({plan['music_peak_db']:.1f} dB), with only the applause "
                    f"transients at {reg_txt} limited (up to {max_red:.1f} dB); "
                    f"the music is untouched linear")
    if max_red > 10:
        note = "limiter would cut applause peaks by " \
               f"{max_red:.1f} dB — heavy; listen to the applause"
        if note not in plan["flags"]:
            plan["flags"].append(note)


def limiter_chain(plan, pre=""):
    """The literal ffmpeg filter chain for an applause-limiter track. Also the
    provenance `chain` ground truth. No loudnorm: loudnorm's linear mode would
    refuse this gain (its TP measurement includes the applause) — the plain
    volume gain IS the linear normalization, sized to the music peaks."""
    amp = 10 ** (plan["limit_db"] / 20)
    return ((pre + ",") if pre else "") + (
        f"volume={plan['gain_db']}dB,alimiter=limit={amp:.6f}:"
        f"attack=5:release=100:level=false:latency=1")


# ── sparse-transient cap (workflow v8, opt-in) ───────────────────────────────

def try_transient_cap(plan, path, target, pre, in_I, in_TP, partial=False,
                      force=False, max_gr=None, density_ref=None,
                      fallback_desc="its reduced linear target"):
    """Attempt to upgrade a would-be linear-reduced track to the opt-in
    transient-cap mode (workflow v8). Mutates and returns `plan` on success;
    returns None (leaving only flags behind) when any eligibility gate fails,
    in which case the caller proceeds to its own fallback exactly as if the
    flag were off. Called only when --transient-cap was passed, and normally
    only after the applause classifier has declined (applause-limiter is less
    invasive — music strictly linear — so it keeps precedence). The one
    exception is --transient-cap-over-applause, which offers an
    applause-limited track to the cap first when the applause plan alone
    would still land short; there the fallback is applause-limiter, not
    linear-reduced, which is what `fallback_desc` names in the decline flags.

    `max_gr`, when given, is an explicit per-track EXCEPTION to the standard
    TCAP_MAX_GR policy ceiling (--transient-cap-max-gr) — e.g. after a
    loudness-matched listening test showed a deeper cut is inaudible on one
    specific track. Never a way to change the ceiling for the show or the
    archive; recorded in provenance (policy_max_gr_db / override) precisely
    so an exception is always distinguishable from standard-policy output.

    `density_ref`, when given, is the dB level the sparsity screen measures
    against instead of the track's own overall peak. It exists for one case:
    a track where APPLAUSE tops the file. There `max(peaks)` is a clap, so
    almost no musical frame sits within TCAP_NEAR_PEAK_DB of it and near_pct
    reads far too low. Measured case: Anna May on mad-cafe-java-1999-09-09,
    whose music peaks at about −11 dB while the applause runs some 11 dB
    above it — the whole screen would otherwise be referenced to a clap.
    (Truck, the track this correction was first written for, turns out NOT to
    be such a case: its music peak is −0.0 dB and the file has no applause
    regions at all, so `density_ref` is a no-op there and the once-quoted
    "1.6% vs 12.3%" figure did not come from this effect. See §4a-result of
    plans/loudness-variants/loudness-variants-plan.md.)
    Passing the music's own peak restores
    the number the screen was designed to produce. This makes the gate
    STRICTER on these tracks, never looser; it is a correction, not a
    bypass. The engagement gate below needs no such fix — it counts frames
    that exceed the limit after gain, which is already applause-independent,
    and is the "engagement stats at a real threshold" the written policy asks
    this question to be decided on."""
    effective_max_gr = TCAP_MAX_GR if max_gr is None else max_gr
    plan["max_gr"] = effective_max_gr
    overshoot = plan["pred"] - TP_CEILING  # dB of boost linear-only must forgo
    if overshoot < TCAP_MIN_BENEFIT:
        return None  # lands within 1 dB of target anyway — not worth a limiter
    if overshoot > effective_max_gr and not partial:
        plan["flags"].append(
            f"transient-cap declined: reaching {target:g} LUFS needs "
            f"{overshoot:.1f} dB of capping, over the {effective_max_gr:g} dB hard "
            f"cap — the track stays honestly quiet at {fallback_desc} "
            f"(per-track partial capping is available as Rene's "
            f"explicit opt-in: --transient-cap-partial)")
        return None
    wins = window_stats(path, pre=pre, win_s=TCAP_FRAME_MS / 1000)
    peaks = [p for _, p, _ in wins]
    times = [t for t, _, _ in wins]
    if not peaks:
        plan["flags"].append("transient-cap declined: frame scan produced no data")
        return None
    top = max(peaks) if density_ref is None else density_ref
    peak_desc = ("its own peak" if density_ref is None
                 else "the music's own peak (applause excluded)")
    near_pct = 100.0 * sum(1 for p in peaks if p >= top - TCAP_NEAR_PEAK_DB) / len(peaks)
    if near_pct > TCAP_REJECT_NEAR_PEAK_PCT and not force:
        plan["flags"].append(
            f"transient-cap declined: {near_pct:.1f}% of the track sits within "
            f"{TCAP_NEAR_PEAK_DB:g} dB of {peak_desc} (> "
            f"{TCAP_REJECT_NEAR_PEAK_PCT:g}% — repeatedly loud, not a sparse "
            f"transient; Truck-territory content) — {fallback_desc} instead "
            f"(Rene can override per track after listening: --transient-cap-force)")
        return None
    # Size the gain against the ATTENUATION cap, not just the target: the
    # shave at the loudest instant is in_TP + gain - limit, and the written
    # policy caps that at 6.0 dB. A track whose full-target gain would shave
    # more gets the excess trimmed off its gain instead — it lands a hair shy
    # of nominal (recorded via target_lufs) rather than over-shaved.
    gain = round(target - in_I, 2)
    excess = round(in_TP + gain - TCAP_LIMIT_DB - effective_max_gr, 2)
    if excess > 0:
        gain = round(gain - excess, 2)
    # Reject band on PREDICTED ENGAGEMENT — the measurement the listening
    # evidence actually sampled (passed tracks: 0.1-0.8% engaged, events
    # <= 0.15 s). Beyond the review band the limiter would behave like
    # repeated compression, which no evidence covers.
    reds, events, longest_s, longest_t = _tcap_engagement(peaks, gain, TCAP_LIMIT_DB, times)
    engaged_pct = 100.0 * len(reds) / len(peaks)
    if not force and (engaged_pct > TCAP_REJECT_ENGAGE_PCT
                      or longest_s > TCAP_REJECT_EVENT_S):
        where = f" at {int(longest_t // 60)}:{longest_t % 60:04.1f}" if longest_t is not None else ""
        plan["flags"].append(
            f"transient-cap declined: the limiter would engage on "
            f"{engaged_pct:.1f}% of the track (longest event {longest_s:.2f} s{where}) "
            f"— beyond the review band ({TCAP_REJECT_ENGAGE_PCT:g}% / "
            f"{TCAP_REJECT_EVENT_S:g} s); repeated-compression territory, no "
            f"listening evidence — {fallback_desc} instead "
            f"(--transient-cap-force after listening to override)")
        return None
    plan.update(mode="sparse-transient-cap", target=round(in_I + gain, 2),
                gain_db=gain, limit_db=TCAP_LIMIT_DB,
                sr=int(probe(path)["sr"]), tcap_peaks=peaks, tcap_times=times,
                near_peak_pct=round(near_pct, 2))
    tcap_finalize(plan)
    if force and near_pct > TCAP_MAX_NEAR_PEAK_PCT:
        # recorded, not blocking: force means Rene already listened — his
        # ears outrank the calibrated gate, and the provenance says so
        plan["flags"].append(
            f"sparsity screen ({near_pct:.1f}% near-peak > "
            f"{TCAP_MAX_NEAR_PEAK_PCT:g}%) overridden by Rene after listening "
            f"(--transient-cap-force)")
    if excess > 0:
        plan["flags"].append(
            f"gain trimmed {excess:.2f} dB to honor the {effective_max_gr:g} dB "
            f"attenuation cap — lands at {plan['target']:g} LUFS instead of "
            f"{target:g} (inaudible; the cap is the policy, the target is not)")
    return plan


def _tcap_engagement(peaks, gain, limit, times=None):
    """Predicted limiter engagement from the 50 ms frame-peak scan: sorted
    per-frame reductions where the gained signal exceeds the threshold, event
    count, the longest continuous engagement in seconds, and (when `times` is
    given) that longest run's own start time in seconds -- the single
    timestamp most worth a human ear, surfaced in review-tier flags so
    listening doesn't require scrubbing the whole track."""
    reds = sorted(p + gain - limit for p in peaks if p + gain > limit)
    events = longest = run = 0
    run_start = longest_start = None
    for i, p in enumerate(peaks):
        if p + gain > limit:
            if run == 0:
                run_start = i
            run += 1
            if run > longest:
                longest = run
                longest_start = run_start
            if run == 1:
                events += 1
        else:
            run = 0
    longest_t = times[longest_start] if times and longest_start is not None else None
    return reds, events, longest * (TCAP_FRAME_MS / 1000), longest_t


def tcap_finalize(plan):
    """(Re)derive the transient-cap stats + note from plan's current
    gain_db/limit_db — called after initial sizing and again by cmd_process's
    true-peak retry loop whenever limit_db is backed off, so the provenance
    always describes what was actually rendered. All engagement numbers are
    predictions from the 50 ms frame-peak scan of the SOURCE (sample-peak
    domain); the render loop separately verifies the output's true peak."""
    gain, limit = plan["gain_db"], plan["limit_db"]
    peaks = plan["tcap_peaks"]
    times = plan.get("tcap_times")
    in_TP = float(plan["measure"]["input_tp"])
    # the projected output loudness follows the gain — authoritative here so
    # a lockstep gain backoff in the retry loop updates it too
    plan["target"] = round(float(plan["measure"]["input_i"]) + gain, 2)
    reds, events, longest_s, longest_t = _tcap_engagement(peaks, gain, limit, times)
    gr = round(in_TP + gain - limit, 2)  # reduction at the loudest instant (true-peak based)
    plan["tcap"] = {
        "gain_db": gain, "limit_db": limit, "gr_db": gr,
        "near_peak_pct": plan["near_peak_pct"],
        "engaged_pct": round(100.0 * len(reds) / len(peaks), 2),
        "events": events, "longest_s": round(longest_s, 2),
        "longest_at_s": round(longest_t, 2) if longest_t is not None else None,
        "p95_gr_db": round(reds[int(0.95 * (len(reds) - 1))], 2) if reds else 0.0,
        # source LRA, so the preservation claim is auditable from the sidecar
        # alone (entry-level `lra` is the OUTPUT measurement)
        "in_lra": plan["in_lra"],
    }
    t = plan["tcap"]
    plan["note"] = (
        f"sparse musical transients (not applause) set the ceiling: one constant "
        f"{gain:+.1f} dB gain to the full {plan['target']:g} LUFS target, with a "
        f"1 ms/50 ms true-peak cap shaving up to {gr:.1f} dB off the transients "
        f"(~{t['engaged_pct']:.1f}% of the track, {events} event(s), longest "
        f"{t['longest_s']:.2f} s; {t['near_peak_pct']:.1f}% near-peak density)")
    # REVIEW tier (tiered gates, 2026-08-08): anything beyond the auto envelope
    # the A/B evidence covers (engagement <= 1%, events <= 0.2 s, density
    # <= 2%) is capped but hard-blocks publish until Rene's ears rule via
    # accept/exclude/force. The reject band was already handled at sizing.
    # The flagged event's own start time is included so listening doesn't
    # require scrubbing the whole track for the moment in question.
    where = f" at {int(longest_t // 60)}:{longest_t % 60:04.1f}" if longest_t is not None else ""
    if t["longest_s"] > TCAP_AUTO_EVENT_S:
        note = (f"transient cap engages continuously for {t['longest_s']:.2f} s{where} "
                f"(auto envelope {TCAP_AUTO_EVENT_S:g} s) — review tier, "
                "listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)
    if t["engaged_pct"] > TCAP_AUTO_ENGAGE_PCT:
        note = (f"transient cap engages on {t['engaged_pct']:.1f}% of the track "
                f"(auto envelope {TCAP_AUTO_ENGAGE_PCT:g}%) — review tier, "
                "listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)
    if t["near_peak_pct"] > TCAP_MAX_NEAR_PEAK_PCT:
        note = (f"near-peak density {t['near_peak_pct']:.1f}% (auto envelope "
                f"{TCAP_MAX_NEAR_PEAK_PCT:g}%) — review tier, "
                "listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)
    effective_max_gr = plan.get("max_gr", TCAP_MAX_GR)
    if gr > effective_max_gr + 0.01:
        # structurally impossible: sizing trims the gain to the cap and the
        # retry loop moves gain in lockstep once the cap is reached — if this
        # fires, the invariant is broken, not merely a loud track. Compared
        # against whatever ceiling was actually in effect for this track
        # (standard policy, or an explicit --transient-cap-max-gr exception).
        note = (f"attenuation {gr:.2f} dB EXCEEDS the {effective_max_gr:g} dB cap — "
                f"invariant broken; do not ship, listen before shipping")
        if note not in plan["flags"]:
            plan["flags"].append(note)


def tcap_chain(plan, pre=""):
    """The literal ffmpeg filter chain for a transient-cap track — also the
    provenance `chain` ground truth. alimiter thresholds SAMPLE peaks, so it
    runs at 4x the source rate (inter-sample peaks become real samples there)
    with an internal ceiling 0.5 dB under the archive's -1 dBTP (downsampling
    reconstructs some overshoot); cmd_process still measures the actual output
    true peak afterwards and aborts if it doesn't comply. The gain is a plain
    unconditional volume multiply — same no-hidden-dynamic-mode guarantee as
    linear_chain (v6)."""
    amp = 10 ** (plan["limit_db"] / 20)
    sr = plan["sr"]
    return ((pre + ",") if pre else "") + (
        f"volume={plan['gain_db']}dB:precision=double,"
        f"aresample={sr * 4},"
        f"alimiter=limit={amp:.6f}:attack=1:release=50:level=false:latency=1,"
        f"aresample={sr}")


def linear_chain(plan, pre=""):
    """The literal ffmpeg filter chain for a plain-linear or linear-reduced
    track (v6+). loudnorm/ebur128 (via plan_track's measurement pass) decide
    the gain; this single explicit volume multiply performs it — no loudnorm
    at render time, so there is no possibility of ffmpeg's own linear/dynamic
    fallback choosing dynamic-mode processing instead. plan['target'] is
    already the correct target for either mode (the nominal show target for
    'linear', the track's own max-linear target for 'linear-reduced')."""
    gain = round(plan["target"] - float(plan["measure"]["input_i"]), 2)
    return ((pre + ",") if pre else "") + f"volume={gain}dB:precision=double"
