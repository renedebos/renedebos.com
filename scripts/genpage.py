#!/usr/bin/env python3
"""Generate the 19 Broadway 2001-01-08 show page from the local mp3 dir."""
import html, math, os, subprocess, urllib.parse

MP3_DIR = os.path.expanduser("~/hannan-audio/19broadway-2001-01-08/mp3")
R2_PREFIX = "MP3/JerryHannan - 19 Broadway 2001-01-08/"
WORKER = "https://wav-download.renedebos.workers.dev"
OUT = os.path.expanduser("~/renedebos.com/jerry-hannan-19-broadway-2001/index.html")

tracks = []
for f in sorted(os.listdir(MP3_DIR)):
    if not f.endswith(".mp3"):
        continue
    dur = float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", os.path.join(MP3_DIR, f)]).strip())
    size = os.path.getsize(os.path.join(MP3_DIR, f))
    base = f[len("JerryHannan - 19 Broadway 2001-01-08 - "):-len(".mp3")]
    num, title = base.split(" ", 1)
    tracks.append((int(num), title, f, dur, size))

def mmss(s):
    return f"{int(s // 60)}:{int(s % 60):02d}"

total = sum(t[3] for t in tracks)
total_str = f"{int(total // 3600)}h {int(total % 3600 // 60)}m" if total >= 3600 else mmss(total)

items = []
for num, title, fname, dur, size in tracks:
    key = R2_PREFIX + fname
    stream = WORKER + "/stream?file=" + urllib.parse.quote(key)
    t = html.escape(title)
    mb = max(1, round(size / 1_000_000))
    items.append(f'''
      <div class="recording-item">
        <div class="recording-meta">
          <div>
            <div class="recording-title"><span class="track-num">{num:02d}</span>{t}</div>
            <div class="recording-detail">{mmss(dur)} &middot; MP3 320 kbps &middot; {mb} MB</div>
          </div>
        </div>
        <div class="custom-player" data-src="{html.escape(stream, quote=True)}">
          <button class="play-btn" aria-label="Play"><svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg></button>
          <div class="progress-wrap">
            <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
            <div class="time-row"><span class="time-label current">0:00</span><span class="time-label">{mmss(dur)}</span></div>
          </div>
          <a class="download-btn" href="{html.escape(stream, quote=True)}" download="{html.escape(fname, quote=True)}" title="Download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M7 10l5 5 5-5"/><path d="M3 18h18"/></svg></a>
        </div>
      </div>''')

page = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jerry Hannan — Live at 19 Broadway, January 8, 2001</title>
<meta name="description" content="Jerry Hannan live at 19 Broadway, Fairfax, January 8, 2001 — soundboard recording, all 30 songs as individual MP3 tracks.">
<meta property="og:title" content="Jerry Hannan — Live at 19 Broadway, January 8, 2001">
<meta property="og:description" content="Soundboard recording of the full show, split into 30 individual tracks. Stream or download in MP3 320 kbps.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://renedebos.com/jerry-hannan-19-broadway-2001/">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♪</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}

  :root {{
    --bg: #f5f2ed;
    --surface: #faf8f5;
    --text: #1a1916;
    --muted: #6b6860;
    --border: #dedad3;
    --accent: #2c4a3e;
    --accent-light: #e8efe8;
    --player-bg: #ffffff;
    --sans: 'DM Sans', sans-serif;
    --serif: 'DM Serif Display', serif;
  }}

  body {{
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    font-size: 15px;
    line-height: 1.6;
  }}

  header {{
    padding: 5rem 2rem 4rem;
    text-align: center;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }}

  .site-eyebrow {{
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 1.2rem;
    font-weight: 400;
  }}

  h1 {{
    font-family: var(--serif);
    font-size: clamp(2.2rem, 5vw, 3.6rem);
    font-weight: 400;
    letter-spacing: -0.02em;
    line-height: 1.1;
    color: var(--text);
  }}

  h1 em {{
    font-style: italic;
    color: var(--accent);
  }}

  .site-tagline {{
    margin-top: 1.2rem;
    font-size: 14px;
    color: var(--muted);
    font-weight: 300;
    letter-spacing: 0.03em;
  }}

  nav {{
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 2rem;
    padding: 1.5rem 2rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
  }}

  nav a {{
    font-size: 13px;
    text-decoration: none;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 500;
    transition: color 0.2s;
    padding-bottom: 2px;
    border-bottom: 1.5px solid transparent;
  }}

  nav a:hover {{
    color: var(--accent);
    border-bottom-color: var(--accent);
  }}

  main {{
    max-width: 820px;
    margin: 0 auto;
    padding: 4rem 2rem 6rem;
  }}

  .recording-list {{
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    background: var(--border);
  }}

  .recording-item {{
    background: var(--player-bg);
    padding: 1.4rem 1.6rem;
    transition: background 0.15s;
  }}

  .recording-item:hover {{
    background: var(--surface);
  }}

  .recording-meta {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
    gap: 1rem;
  }}

  .recording-title {{
    font-size: 15px;
    font-weight: 500;
    color: var(--text);
    line-height: 1.3;
  }}

  .track-num {{
    display: inline-block;
    min-width: 2em;
    color: var(--muted);
    font-weight: 300;
    font-variant-numeric: tabular-nums;
  }}

  .recording-detail {{
    font-size: 12px;
    color: var(--muted);
    margin-top: 3px;
    font-weight: 300;
    letter-spacing: 0.02em;
    padding-left: 2em;
  }}

  .custom-player {{
    display: flex;
    align-items: center;
    gap: 10px;
    overflow: visible;
  }}

  .play-btn {{
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1.5px solid var(--accent);
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
  }}

  .play-btn:hover {{
    background: var(--accent);
    color: white;
  }}

  .play-btn svg {{
    width: 14px;
    height: 14px;
  }}

  .progress-wrap {{
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }}

  .progress-bar-track {{
    width: 100%;
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
    overflow: hidden;
  }}

  .progress-bar-fill {{
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    width: 0%;
    transition: width 0.1s linear;
  }}

  .time-row {{
    display: flex;
    justify-content: space-between;
  }}

  .time-label {{
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
  }}

  .download-btn {{
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 5px 12px;
    border-radius: 3px;
    background: var(--accent-light);
    color: var(--accent);
    text-decoration: none;
    flex-shrink: 0;
    transition: background 0.2s, color 0.2s;
    white-space: nowrap;
  }}
  .download-btn:hover {{ background: var(--accent); color: white; }}
  .download-btn svg {{ width: 13px; height: 13px; flex-shrink: 0; }}

  .dl-label {{
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }}

  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}

  footer {{
    text-align: center;
    padding: 2.5rem;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.04em;
    background: var(--surface);
  }}
  footer a {{ color: var(--accent); text-decoration: none; }}

  @media (max-width: 600px) {{
    header {{ padding: 3rem 1.5rem 2.5rem; }}
    main {{ padding: 2.5rem 1.25rem 4rem; }}
    nav {{ gap: 1rem; }}
    nav a {{ font-size: 11px; }}
  }}
</style>
</head>
<body>

<header>
  <p class="site-eyebrow">The Hannan Recordings</p>
  <h1>Jerry Hannan<br><em>Live at 19 Broadway</em></h1>
  <p class="site-tagline">Fairfax, California &mdash; January 8, 2001 &middot; Soundboard</p>
</header>

<nav>
  <a href="/">&larr; Back to the Archive</a>
  <a href="#tracks">Tracks</a>
</nav>

<main>

  <section style="max-width:620px;margin:0 auto 4rem;padding-bottom:3rem;border-bottom:1px solid var(--border);">
    <h2 style="font-family:var(--serif);font-size:1.5rem;font-weight:400;margin-bottom:1rem;color:var(--text);">About This Show</h2>
    <p style="font-size:14px;color:var(--muted);line-height:1.8;font-weight:300;margin-bottom:0.9rem;">
      On January 8, 2001, Jerry Hannan played a solo show at 19 Broadway, the long-running club in downtown Fairfax, California. Unlike most recordings in this archive, which were captured from the audience on a small microphone, this one was recorded directly from the soundboard to DAT &mdash; so the sound is unusually clear and close.
    </p>
    <p style="font-size:14px;color:var(--muted);line-height:1.8;font-weight:300;margin-bottom:0.9rem;">
      The full tape has now been split into its {len(tracks)} individual songs: Jerry&rsquo;s originals alongside traditional Irish songs and a handful of covers. Each track can be played right here or downloaded as a 320&nbsp;kbps MP3.
    </p>
    <p style="font-size:13px;color:var(--muted);line-height:1.7;font-weight:300;font-style:italic;border-top:1px solid var(--border);padding-top:1rem;margin-top:0.5rem;">
      {len(tracks)} tracks &middot; {total_str} total &middot; The complete show is also available as a single lossless WAV on the <a href="/" style="color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent);">main archive page</a>.
    </p>
  </section>

  <section id="tracks">
    <div class="recording-list">
{"".join(items)}
    </div>
  </section>

</main>

<footer>
  Part of <a href="/">The Hannan Recordings</a> archive
</footer>

<script>
function formatTime(s) {{
  if (!isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}}

const playIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>`;
const pauseIcon = `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>`;
const loadingIcon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 0.75s linear infinite;display:block"><circle cx="8" cy="8" r="5.5" stroke-dasharray="20" stroke-dashoffset="6" stroke-linecap="round"/></svg>`;

let activePlayer = null;

document.querySelectorAll('.custom-player').forEach(player => {{
  const src = player.dataset.src;
  const audio = new Audio();
  audio.preload = 'none';

  const btn = player.querySelector('.play-btn');
  const fill = player.querySelector('.progress-bar-fill');
  const track = player.querySelector('.progress-bar-track');
  const currentEl = player.querySelector('.current');

  let loaded = false;

  function load() {{
    if (!loaded) {{ audio.src = src; loaded = true; }}
  }}

  audio.addEventListener('timeupdate', () => {{
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    fill.style.width = pct + '%';
    currentEl.textContent = formatTime(audio.currentTime);
  }});

  audio.addEventListener('waiting', () => {{
    btn.innerHTML = loadingIcon;
  }});

  audio.addEventListener('playing', () => {{
    btn.innerHTML = pauseIcon;
    activePlayer = player;
  }});

  audio.addEventListener('ended', () => {{
    btn.innerHTML = playIcon;
    fill.style.width = '0%';
    currentEl.textContent = '0:00';
    if (activePlayer === player) activePlayer = null;
    // Auto-advance to the next track
    const items = Array.from(document.querySelectorAll('.custom-player'));
    const next = items[items.indexOf(player) + 1];
    if (next) next.querySelector('.play-btn').click();
  }});

  btn.addEventListener('click', () => {{
    load();
    if (audio.paused) {{
      document.querySelectorAll('.custom-player').forEach(p => {{
        if (p !== player) {{
          const a = p._audio;
          if (a && !a.paused) {{ a.pause(); p.querySelector('.play-btn').innerHTML = playIcon; }}
        }}
      }});
      audio.play();
      btn.innerHTML = audio.readyState < 3 ? loadingIcon : pauseIcon;
    }} else {{
      audio.pause();
      btn.innerHTML = playIcon;
    }}
  }});

  track.addEventListener('click', e => {{
    load();
    const rect = track.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    if (audio.duration) audio.currentTime = pct * audio.duration;
  }});

  player._audio = audio;
}});

document.addEventListener('keydown', e => {{
  if (e.code !== 'Space') return;
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  e.preventDefault();
  if (!activePlayer) return;
  const audio = activePlayer._audio;
  const btn = activePlayer.querySelector('.play-btn');
  if (audio.paused) {{
    audio.play();
    btn.innerHTML = loadingIcon;
  }} else {{
    audio.pause();
    btn.innerHTML = playIcon;
  }}
}});

// MP3 downloads go through the Worker /download endpoint (no password needed)
const WORKER = '{WORKER}';
document.querySelectorAll('a.download-btn').forEach(btn => {{
  if (!btn.querySelector('.dl-label')) {{
    const label = document.createElement('span');
    label.className = 'dl-label';
    label.textContent = 'Download';
    btn.appendChild(label);
  }}
  btn.addEventListener('click', e => {{
    e.preventDefault();
    const fileParam = new URL(btn.href).searchParams.get('file');
    const filename = btn.getAttribute('download') || decodeURIComponent(fileParam.split('/').pop());
    const a = document.createElement('a');
    a.href = WORKER + '/download?file=' + encodeURIComponent(fileParam);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }});
}});
</script>
</body>
</html>
'''

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    f.write(page)
print(f"Wrote {OUT}: {len(tracks)} tracks, total {total_str}")
