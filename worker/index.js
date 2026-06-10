const WORKER_ORIGIN = 'https://wav-download.renedebos.workers.dev';

const FREE_FILES = new Set([
  'JerryHannan - 19 Broadway 2001-01-08 SBD (Rugburns).wav',
  'Soundcloud/JerryHannan_CafeJava_ThePatriotGame.wav',
]);

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

  const isWav = file.toLowerCase().endsWith('.wav');
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', isWav ? 'audio/wav' : 'audio/mpeg');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');

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
async function handleAuth(request, env, origin) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response('Bad request', { status: 400, headers: corsHeaders(origin) }); }

  const { password, filename } = body;

  if (!password || password !== env.WAV_PASSWORD) {
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
// For WAV files: validates HMAC token before serving.
// For non-WAV (MP3 etc.): no token required.
async function handleDownload(request, env, url, origin) {
  const file = url.searchParams.get('file');
  if (!file) return new Response('Missing file', { status: 400 });

  const isWav = file.toLowerCase().endsWith('.wav');

  if (isWav && !FREE_FILES.has(file)) {
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
  }

  const object = await env.R2_BUCKET.get(file);
  if (!object) return new Response('Not found', { status: 404 });

  const filename = file.split('/').pop();
  const contentType = isWav ? 'audio/wav' : 'audio/mpeg';
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Content-Length', String(object.size));

  return new Response(object.body, { status: 200, headers });
}
