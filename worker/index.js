// Deployed automatically by .github/workflows/deploy-worker.yml on any
// change under worker/ — no manual `wrangler deploy` needed since 2026-07-10.
const WORKER_ORIGIN = 'https://wav-download.renedebos.workers.dev';

function audioType(file) {
  const f = file.toLowerCase();
  if (f.endsWith('.wav')) return 'audio/wav';
  if (f.endsWith('.flac')) return 'audio/flac';
  return 'audio/mpeg';
}

function corsHeaders(origin) {
  const allowed = ['https://renedebos.com', 'https://www.renedebos.com'];
  const allowedOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/stream') return handleStream(request, env, url, origin);
    if (url.pathname === '/auth')   return handleAuth(request, env, origin);
    if (url.pathname === '/download') return handleDownload(request, env, url, origin);

    return new Response('Not found', { status: 404 });
  },
};

// ── /stream?file=ENCODED_PATH ─────────────────────────────────────────────────
// Serves audio from private R2 for the in-page player.  Supports Range so
// seeking works.  No password required — the bucket is private so the public
// URL no longer exists.
async function handleStream(request, env, url, origin) {
  const file = url.searchParams.get('file');
  if (!file) return new Response('Missing file', { status: 400 });

  // The player only ever streams the lossy proxies (MP3/, MP3-14/, the
  // Soundcloud singles: .mp3, one .m4a). An ALLOWLIST of those extensions,
  // not a denylist of .wav/.flac: until 2026-08-22 the check only refused
  // lossless audio, so any other password-gated object -- the complete-archive
  // ZIP that build_archive_zip.py puts under Downloads/ -- could have been
  // fetched here without passing /auth + /download (Codex review, finding 1;
  // latent, the ZIP was not in the bucket at the time). Everything gated stays
  // reachable only through /auth + /download.
  const lower = file.toLowerCase();
  if (!lower.endsWith('.mp3') && !lower.endsWith('.m4a')) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders(origin) });
  }

  const rangeHeader = request.headers.get('Range');
  let rangeOpt;

  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const offset = parseInt(m[1], 10);
      rangeOpt = m[2] ? { offset, length: parseInt(m[2], 10) - offset + 1 } : { offset };
    }
  }

  const object = await env.R2_BUCKET.get(file, rangeOpt ? { range: rangeOpt } : undefined);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', audioType(file));
  headers.set('Accept-Ranges', 'bytes');
  // Edge-cacheable. A `v` cache-buster (content fingerprint, added by the build)
  // means the URL changes whenever the audio does, so it's safe to cache hard and
  // still go live instantly on re-upload. Un-versioned URLs get a short TTL.
  const versioned = url.searchParams.get('v');
  headers.set('Cache-Control',
    versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');

  if (rangeOpt) {
    const offset = rangeOpt.offset;
    const length = rangeOpt.length ?? (object.size - offset);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

// ── POST /auth  body: { password, filename } ──────────────────────────────────
// Verifies the password against WAV_PASSWORD env secret.
// Returns a short-lived HMAC-signed token the client uses for /download.

// Constant-time equality via HMAC comparison: hash both sides with a random
// per-isolate key and compare the digests — comparing digests leaks nothing
// about where the plaintexts differ. Key is created lazily: the Workers
// runtime disallows random generation in global scope.
let ctKeyPromise = null;
function ctKey() {
  if (!ctKeyPromise) {
    ctKeyPromise = crypto.subtle.importKey('raw',
      crypto.getRandomValues(new Uint8Array(32)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return ctKeyPromise;
}
async function timingSafeEqual(a, b) {
  const key = await ctKey();
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const ua = new Uint8Array(da), ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// Best-effort brute-force damping (per isolate): a failure budget per minute
// plus a fixed delay on every wrong password. Not a hard guarantee — isolates
// are many — but it turns online guessing from thousands/sec into a crawl;
// the password's strength is the real defence.
let authFails = 0, authWindow = 0;
function authThrottled() {
  const now = Date.now();
  if (now - authWindow > 60000) { authWindow = now; authFails = 0; }
  return authFails >= 20;
}

async function handleAuth(request, env, origin) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response('Bad request', { status: 400, headers: corsHeaders(origin) }); }

  const { password, filename } = body;

  if (authThrottled()) {
    return new Response(JSON.stringify({ error: 'Too many attempts — wait a minute' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  if (!password || !(await timingSafeEqual(password, env.WAV_PASSWORD))) {
    authFails++;
    await new Promise((r) => setTimeout(r, 1000));
    return new Response(JSON.stringify({ error: 'Incorrect password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  if (!filename) {
    return new Response('Missing filename', { status: 400, headers: corsHeaders(origin) });
  }

  const expires = Date.now() + 60 * 60 * 1000; // 1 hour
  const message = `${filename}:${expires}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const token = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return new Response(JSON.stringify({ token, expires }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── /download?file=ENCODED_PATH&token=TOKEN&expires=TS ────────────────────────
// Every download requires a valid HMAC token from /auth — free downloads were
// removed from the site (2026-07-10); streaming via /stream is the only
// ungated path.
async function handleDownload(request, env, url, origin) {
  const file = url.searchParams.get('file');
  if (!file) return new Response('Missing file', { status: 400 });

  const token = url.searchParams.get('token');
  const expires = parseInt(url.searchParams.get('expires') || '0', 10);

  if (!token || !expires) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders(origin) });
  }
  if (Date.now() > expires) {
    return new Response('Token expired', { status: 401, headers: corsHeaders(origin) });
  }

  const message = `${file}:${expires}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = Uint8Array.from(atob(token), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(message));

  if (!valid) {
    return new Response('Invalid token', { status: 401, headers: corsHeaders(origin) });
  }

  const object = await env.R2_BUCKET.get(file);
  if (!object) return new Response('Not found', { status: 404 });

  const filename = file.split('/').pop();
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', audioType(file));
  // ASCII-safe quoted filename (quotes/control chars stripped) plus RFC 5987
  // filename* for the full UTF-8 name — no way to malform the header.
  const ascii = filename.replace(/["\\\u0000-\u001f\u007f-\uffff]/g, '_');
  headers.set('Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { status: 200, headers });
}
