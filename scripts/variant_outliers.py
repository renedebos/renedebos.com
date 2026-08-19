#!/usr/bin/env python3
"""Rank -14 variant tracks by how much the transient cap moved their dynamics.

Per plans/loudness-variants §4-measured, LRA delta (variant LRA minus the -20
archive's LRA for the same track) is the honest outlier signal, and engagement %
is not: on archive input the near-peak/engagement screens measure against a
yardstick the first limiter pass already lowered (§4-ab), so every track reads
artificially dense. LRA is what says whether the dynamics survived.

This is the input to §4-gating's "listen to the five worst outliers before
shipping" step -- a spot-check on output, not a gate.

  python3 scripts/variant_outliers.py [--top N] [--variant loud-14]
"""
import argparse, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--variant", default="loud-14")
    a = ap.parse_args()

    vdir = os.path.join(ROOT, "data", "processing", "variants", a.variant)
    if not os.path.isdir(vdir):
        raise SystemExit(f"no variant provenance at {vdir}")
    titles = {}
    for s in json.load(open(os.path.join(ROOT, "data", "recordings.json")))["shows"]:
        for t in (s.get("tracks") or []):
            titles[(s["slug"], str(t["num"]))] = t["title"]

    rows, shows = [], 0
    for fn in sorted(os.listdir(vdir)):
        if not fn.endswith(".json"):
            continue
        slug = fn[:-5]
        shows += 1
        var = json.load(open(os.path.join(vdir, fn))).get("tracks", {})
        apath = os.path.join(ROOT, "data", "processing", f"{slug}.json")
        arc = json.load(open(apath)).get("tracks", {}) if os.path.exists(apath) else {}
        for num, v in var.items():
            av = arc.get(num, {})
            if "lra" not in v or "lra" not in av:
                continue
            tc = v.get("transient_cap") or {}
            rows.append({
                "slug": slug, "num": int(num),
                "title": titles.get((slug, num), "?"),
                "d_lra": round(v["lra"] - av["lra"], 2),
                "arc_lra": av["lra"], "var_lra": v["lra"],
                "lufs": v.get("lufs"), "short": round(v.get("lufs", 0) + 14, 2),
                "gr": tc.get("gr_db"), "eng": tc.get("engaged_pct"),
                "longest": tc.get("longest_s"), "mode": v.get("mode"),
            })

    if not rows:
        raise SystemExit("no comparable tracks yet")
    rows.sort(key=lambda r: r["d_lra"])
    caps = [r for r in rows if r["mode"] == "sparse-transient-cap"]
    print(f"{shows} show(s), {len(rows)} tracks, {len(caps)} transient-capped")
    lr = [r["d_lra"] for r in rows]
    print(f"LRA delta: worst {lr[0]:+.2f}  median {lr[len(lr)//2]:+.2f}  best {lr[-1]:+.2f} LU")
    shy = [r for r in rows if r["short"] < -0.5]
    print(f"{len(shy)} track(s) landed >0.5 dB shy of -14 "
          f"(deepest {min((r['short'] for r in shy), default=0):+.2f} dB)\n")

    hdr = f"{'ΔLRA':>6} {'arch':>5}→{'var':<5} {'LUFS':>7} {'GR':>5} {'eng%':>5} {'long':>5}  track"
    print(hdr); print("-" * len(hdr))
    for r in rows[:a.top]:
        g = f"{r['gr']:.1f}" if r["gr"] is not None else "  -"
        e = f"{r['eng']:.1f}" if r["eng"] is not None else "  -"
        L = f"{r['longest']:.2f}" if r["longest"] is not None else "   -"
        print(f"{r['d_lra']:+6.2f} {r['arc_lra']:5.1f}→{r['var_lra']:<5.1f} "
              f"{r['lufs']:7.2f} {g:>5} {e:>5} {L:>5}  "
              f"{r['slug']} tr{r['num']:02d} {r['title']}")


if __name__ == "__main__":
    main()
