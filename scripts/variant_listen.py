#!/usr/bin/env python3
"""Build a blind, loudness-matched A/B of the worst -14 variant tracks.

The whole point of the -14 campaign's listening step (plans/loudness-variants
§4-gating) is to answer one question with ears rather than numbers: does the
transient cap's dynamic-range reduction actually sound like anything? Two rules
make that question answerable, and both are non-negotiable:

  1. LOUDNESS-MATCHED. The variant is ~6 dB louder by construction. Louder
     always wins a naive A/B, so the variant is attenuated back to the archive's
     own integrated loudness. Attenuation is one constant multiplier -- it moves
     the volume, never the dynamics -- so what is left to hear is exactly the
     limiting, and nothing else.
  2. AS MP3, BOTH SIDES, SAME GENERATION. Per CLAUDE.md, comparisons run on
     MP3 (24-bit FLAC stutters in Chrome here and reads as dropouts). Both
     sides are decoded, gain-adjusted and re-encoded identically, so encode
     generation cannot masquerade as a difference.

Blind by default: which side is A and which is B is randomised per track and
written to reveal.json, which the page does not read.

  python3 scripts/variant_listen.py [--top 5] [--port 8768]
"""
import argparse, hashlib, json, os, random, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.expanduser("~/work/variants/loud-14")
OUT = os.path.expanduser("~/work/variants/listen")
BUCKET = "r2:hannan-audio"


def lufs(path):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
                        "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?\d+\.\d+)\s+LUFS", r.stderr)
    if not m:
        raise SystemExit(f"could not measure {path}")
    return float(m[-1])


def encode(src, dst, gain_db):
    af = f"volume={gain_db:.3f}dB:precision=double"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
                    "-af", af, "-c:a", "libmp3lame", "-b:a", "320k",
                    "-id3v2_version", "3", dst], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--controls", type=int, default=2,
                    help="hidden null controls mixed in unlabelled. Prefer "
                         "`linear` tracks: there the variant is the archive "
                         "times one constant, so loudness-matching makes the "
                         "two sides the same audio. Hearing a difference on a "
                         "control means the session is not discriminating and "
                         "its verdict should be discarded, not acted on.")
    ap.add_argument("--port", type=int, default=8768)
    ap.add_argument("--no-serve", action="store_true")
    a = ap.parse_args()

    m = json.load(open(os.path.join(ROOT, "data", "recordings.json")))
    meta = {}
    for s in m["shows"]:
        for t in (s.get("tracks") or []):
            meta[(s["slug"], t["num"])] = t

    # rank by LRA delta, worst first (see scripts/variant_outliers.py for why
    # LRA and not engagement)
    vdir = os.path.join(ROOT, "data", "processing", "variants", "loud-14")
    rows = []
    for fn in sorted(os.listdir(vdir)):
        slug = fn[:-5]
        var = json.load(open(os.path.join(vdir, fn)))["tracks"]
        ap_ = os.path.join(ROOT, "data", "processing", f"{slug}.json")
        if not os.path.exists(ap_):
            continue
        arc = json.load(open(ap_))["tracks"]
        for num, v in var.items():
            av = arc.get(num, {})
            if "lra" not in v or "lra" not in av:
                continue
            rows.append((round(v["lra"] - av["lra"], 2), slug, int(num), v, av))
    rows.sort(key=lambda r: r[0])
    picks = [(r, False) for r in rows[:a.top]]
    if not picks:
        raise SystemExit("no rendered tracks yet")

    # Null controls: smallest |ΔLRA| first, and among equals prefer `linear`
    # (pure constant gain -> identical audio once matched). Never reuse a track
    # already picked as an outlier.
    chosen = {(r[1], r[2]) for r in rows[:a.top]}
    order_mode = {"linear": 0, "linear-reduced": 1}
    ctl = sorted((r for r in rows if (r[1], r[2]) not in chosen),
                 key=lambda r: (abs(r[0]), order_mode.get(r[3].get("mode"), 2)))
    picks += [(r, True) for r in ctl[:a.controls]]
    # Shuffle so a control cannot be identified by its position in the list.
    random.shuffle(picks)

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    reveal, cards = [], []
    for i, ((d_lra, slug, num, v, av), is_ctl) in enumerate(picks, 1):
        t = meta[(slug, num)]
        variant_mp3 = os.path.join(WORK, slug, "mp3",
                                   os.path.splitext(t["flac"].split("/")[-1])[0] + ".mp3")
        if not os.path.exists(variant_mp3):
            print(f"skip {slug} tr{num}: variant MP3 not rendered yet")
            continue
        arch_local = os.path.join(OUT, f"_arch{i}.mp3")
        print(f"[{i}/{len(picks)}] {slug} tr{num} {t['title']}  (ΔLRA {d_lra:+.2f})")
        subprocess.run(["rclone", "copyto", f"{BUCKET}/{t['file']}", arch_local,
                        "--s3-no-check-bucket", "--multi-thread-streams", "8",
                        "--multi-thread-cutoff", "4M"], check=True,
                       capture_output=True)

        ref = lufs(arch_local)                 # the archive's own loudness = the reference
        var_l = lufs(variant_mp3)
        print(f"      archive {ref:.2f} LUFS, variant {var_l:.2f} LUFS "
              f"-> matching variant by {ref - var_l:+.2f} dB")
        # Both sides re-encoded so encode generation is identical on A and B.
        sides = {"archive": (arch_local, 0.0), "variant": (variant_mp3, ref - var_l)}
        order = ["archive", "variant"]
        random.shuffle(order)
        for label, which in zip("AB", order):
            src, g = sides[which]
            encode(src, os.path.join(OUT, f"t{i}{label}.mp3"), g)
        os.remove(arch_local)
        reveal.append({"n": i, "control": is_ctl, "mode": v.get("mode"),
                       "slug": slug, "num": num, "title": t["title"],
                       "d_lra": d_lra, "A": order[0], "B": order[1],
                       "arch_lra": av["lra"], "var_lra": v["lra"],
                       "match_db": round(ref - var_l, 2),
                       "tcap": v.get("transient_cap")})
        cards.append({"n": i, "title": t["title"],
                      "sub": f"{slug} · track {num}"})

    json.dump(reveal, open(os.path.join(OUT, "reveal.json"), "w"), indent=2)
    open(os.path.join(OUT, "index.html"), "w").write(PAGE.replace("__CARDS__", json.dumps(cards)))
    nc = sum(1 for r in reveal if r["control"])
    print(f"\n{len(cards)} track(s) ready in {OUT} "
          f"({len(cards)-nc} outliers + {nc} hidden control(s), order shuffled)")
    print("Blind: A/B order is randomised per track; key is in reveal.json (page never reads it).")
    if not a.no_serve:
        print(f"\nServing http://127.0.0.1:{a.port}/  (Ctrl-C to stop)")
        subprocess.run(["python3", os.path.join(ROOT, "scripts", "ab_server.py"),
                        str(a.port), OUT])


PAGE = r"""<!doctype html><meta charset=utf-8><title>-14 variant · blind A/B</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:dark}
 body{background:#14110e;color:#efe7db;font:16px/1.55 system-ui,sans-serif;margin:0;padding:28px}
 .wrap{max-width:720px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px} .lede{opacity:.7;font-size:14px;margin:0 0 24px}
 .t{border:1px solid #3a332a;border-radius:10px;padding:16px;margin:0 0 14px;background:#1b1713}
 .ti{font-weight:600} .ts{opacity:.6;font-size:13px;margin-bottom:12px}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 button{font:inherit;padding:9px 16px;border-radius:7px;border:1px solid #4a4034;
   background:#241f19;color:#efe7db;cursor:pointer;min-height:44px}
 button.on{background:#c98f3f;border-color:#c98f3f;color:#1a1510;font-weight:600}
 button:disabled{opacity:.4;cursor:default}
 .pos{font-variant-numeric:tabular-nums;opacity:.65;font-size:13px;margin-left:auto}
 .hint{font-size:13px;opacity:.55;margin-top:10px}
</style>
<div class=wrap>
<h1>&minus;14 variant &mdash; blind A/B</h1>
<p class=lede>Both sides are loudness-matched, so volume is not a clue. A and B are
in random order per track. Switch freely while playing &mdash; position is kept.
Listen for the loud/quiet contrast flattening, not for level.</p>
<div id=list></div>
</div>
<script>
const CARDS = __CARDS__;
const list = document.getElementById('list');
CARDS.forEach(c => {
  const d = document.createElement('div'); d.className = 't';
  d.innerHTML = `<div class=ti>${c.n}. ${c.title}</div><div class=ts>${c.sub}</div>
   <div class=row>
     <button data-p>Play</button>
     <button data-s="A">A</button><button data-s="B">B</button>
     <span class=pos>0:00</span>
   </div>
   <div class=hint>A/B switches instantly at the same position.</div>`;
  const au = {A:new Audio(`t${c.n}A.mp3`), B:new Audio(`t${c.n}B.mp3`)};
  // Both elements play together, one muted — the only way to guarantee the two
  // sides stay sample-aligned across a switch without a restart.
  Object.values(au).forEach(a => { a.preload='auto'; a.volume=1; });
  let cur='A', playing=false;
  const btnP=d.querySelector('[data-p]'), pos=d.querySelector('.pos');
  const btns={A:d.querySelector('[data-s="A"]'),B:d.querySelector('[data-s="B"]')};
  const paint=()=>{for(const k in btns) btns[k].classList.toggle('on',k===cur);};
  const apply=()=>{for(const k in au) au[k].muted=(k!==cur);};
  paint(); apply();
  btnP.onclick=async()=>{
    if(playing){ Object.values(au).forEach(a=>a.pause()); playing=false; btnP.textContent='Play'; return; }
    const t=au[cur].currentTime; Object.values(au).forEach(a=>{a.currentTime=t;});
    await Promise.all(Object.values(au).map(a=>a.play()));
    playing=true; btnP.textContent='Pause';
  };
  for(const k in btns) btns[k].onclick=()=>{
    // resync before swapping so drift can never be mistaken for a difference
    const t=au[cur].currentTime; cur=k;
    for(const j in au) if(Math.abs(au[j].currentTime-t)>0.05) au[j].currentTime=t;
    apply(); paint();
  };
  au.A.addEventListener('timeupdate',()=>{
    const t=au[cur].currentTime|0; pos.textContent=`${t/60|0}:${String(t%60).padStart(2,'0')}`;
  });
  list.appendChild(d);
});
</script>
"""

if __name__ == "__main__":
    main()
