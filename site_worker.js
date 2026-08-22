// renedebos-site: serves the static site (Workers assets) plus the playlist
// short-link endpoints. Deployed by the GitHub Action via `npx wrangler deploy`
// (config in wrangler.jsonc); the wav-download Worker in worker/ is separate.
//
// Routing: `run_worker_first: true` in wrangler.jsonc makes every request hit
// this script before Cloudflare's asset layer gets a say — that's required,
// not cosmetic: with the default (assets-first) routing, Cloudflare's own
// `not_found_handling` fallback intercepts full-page navigations to ANY
// non-matching path (including /play/{slug} and /api/playlist, which are
// dynamic, not files) before this script ever runs, serving and edge-caching
// its generic 404 regardless of what this script would have returned —
// confirmed 2026-07-08 (plain fetch() calls reached the script fine; actual
// browser navigation, which sends Sec-Fetch-Mode: navigate, did not). So
// `not_found_handling` is OFF, and the branded 404 below is served by this
// script instead, which is guaranteed to run for every request.
//
// Short links (PLAYLIST FEATURE.md, Phase 4): slugs are content-addressed —
// the first 6 hex chars of SHA-256 of the track-id list, lengthened only on
// collision with different content — so the same playlist always maps to the
// same slug and re-shares dedupe. Entries never expire.
//
// Share-a-song links (plans/share/track-share-plan.md): /t/{code} -> the
// performance's deep link on its show page, autoplay flagged. Unlike
// playlists, the set of performances is known when the site is built, so the
// codes are a BUILD OUTPUT (assets/track-links.json, written by
// scripts/build.py, checked by scripts/verify_markup.py) read through the
// assets binding -- no create call, no KV, nothing to rate-limit. A code that
// is not in the map falls through to the branded 404 below, on purpose: a
// mistyped link should fail visibly, not land on some other song.

// Permanent redirects for retired URLs (SEO/bookmarks), checked before the
// asset layer. Add an entry here whenever a page's path changes.
const LEGACY_REDIRECTS = {
  "/jerry-hannan-19-broadway-2001/": "/shows/jerry-19-broadway-2001-01-08/",
  "/archive/": "/",
  // The /player/ popup window was retired 2026-08-20 (see PLAYLIST FEATURE.md
  // Phase 7). An old bookmark keeps working: the hash never reaches the
  // server, so /player/#p=<ids> lands on /playlist/#p=<ids>, which
  // playlist-boot.js hydrates into exactly that queue.
  "/player/": "/playlist/",
};

const ID_RE = /^[a-z0-9-]{1,80}$/;
// Liberal in what we accept: trailing slash (chat apps often append one when
// linkifying), any letter case, and HEAD as well as GET (link previewers).
const SLUG_RE = /^\/play\/([a-f0-9]{6,64})\/?$/i;
const TRACK_RE = /^\/t\/([a-f0-9]{5,64})\/?$/i;
const MAX_TRACKS = 500;

// Applied to every dynamic response (redirects, /api/*, the branded 404) via
// secure() below. Cached static responses (homepage, /playlist/, etc.) don't
// reliably go through this script on a cache hit, so the same header set is
// ALSO baked in statically via the root `_headers` file — keep both in sync
// if this changes. CSP: the site is dependency-free, so everything is
// same-origin except the wav-download Worker (audio streams + gated
// downloads) and the contact-form Worker (the /contact/ page's fetch
// target). Show pages carry small inline bootstrap <script>s and the
// manual an inline <style>, hence 'unsafe-inline' — external injection is
// still blocked, which is the attack that matters on a static site.
const WAV_WORKER = "https://wav-download.renedebos.workers.dev";
const CONTACT_WORKER = "https://contact-form.renedebos.workers.dev";
// Cloudflare Web Analytics. The beacon is injected by Cloudflare at the edge,
// not by anything in this repo, so before 2026-08-19 it was silently blocked
// by script-src on every page and the analytics collected nothing.
//
// HOST, not the documented `.../beacon.min.js` path: the real URL carries a
// version suffix (.../beacon.min.js/v4513226c...), and a CSP source path only
// prefix-matches when it ends in "/" -- otherwise it must match exactly. The
// documented path source would therefore never match what is actually
// requested.
//
// No connect-src entry is needed: under AUTOMATIC injection the beacon posts
// to same-origin /cdn-cgi/rum, already covered by 'self'. Manual embedding
// would need cloudflareinsights.com added there -- we do not embed manually.
const CF_ANALYTICS = "https://static.cloudflareinsights.com";
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    `default-src 'self'; script-src 'self' 'unsafe-inline' ${CF_ANALYTICS}; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    `connect-src 'self' ${WAV_WORKER} ${CONTACT_WORKER}; media-src 'self' ${WAV_WORKER}; ` +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
};

function secure(resp) {
  const out = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const legacyTarget = LEGACY_REDIRECTS[url.pathname];
    if (legacyTarget) return secure(redirect(legacyTarget, {}, 301));

    if (url.pathname === "/api/playlist" && request.method === "POST") {
      return secure(await createShortLink(request, env, url.origin));
    }

    const m = url.pathname.match(SLUG_RE);
    if (m && (request.method === "GET" || request.method === "HEAD")) {
      return secure(await resolveShortLink(m[1].toLowerCase(), env));
    }

    const t = url.pathname.match(TRACK_RE);
    if (t && (request.method === "GET" || request.method === "HEAD")) {
      const hit = await resolveTrackLink(t[1].toLowerCase(), env, url);
      if (hit) return secure(hit);
      // unknown code: fall through to the asset layer, which 404s below
    }

    const resp = await env.ASSETS.fetch(request);
    if (resp.status === 404) {
      // Serve the branded 404 ourselves (see routing note above); no-store so
      // a transient miss (mid-deploy, propagation) can't shadow a fix later.
      const page = await env.ASSETS.fetch(new URL("/404.html", url));
      return secure(new Response(request.method === "HEAD" ? null : page.body, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      }));
    }
    return secure(resp);
  },
};

// Per-IP daily cap on NEW playlist creates. Dedupe hits (same content, same
// slug) don't count. Coarse on purpose: KV is eventually consistent, so this
// won't stop a fast burst, but it stops any sustained attempt to burn the KV
// write quota. 40/day is far beyond honest use.
const CREATES_PER_DAY = 40;

async function overCreateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const n = parseInt((await env.PLAYLISTS.get(key)) || "0", 10);
  if (n >= CREATES_PER_DAY) return true;
  await env.PLAYLISTS.put(key, String(n + 1), { expirationTtl: 90000 });
  return false;
}

async function createShortLink(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err(400, "invalid JSON");
  }
  const ids = body && body.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TRACKS
      || !ids.every((x) => typeof x === "string" && ID_RE.test(x))) {
    return err(400, "ids must be 1-" + MAX_TRACKS + " track ids");
  }

  const value = JSON.stringify({ ids, created: new Date().toISOString() });
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(ids.join(",")));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  for (const len of [6, 10, hex.length]) {
    const slug = hex.slice(0, len);
    const existing = await env.PLAYLISTS.get(slug);
    if (existing === null) {
      // only a genuinely NEW playlist consumes rate-limit budget
      if (await overCreateLimit(request, env)) {
        return err(429, "too many new playlists today — try again tomorrow");
      }
      await env.PLAYLISTS.put(slug, value);
      return ok(slug, origin);
    }
    const same = safeIds(existing);
    if (same && same.join(",") === ids.join(",")) return ok(slug, origin); // dedupe
  }
  return err(500, "could not allocate a slug"); // unreachable in practice
}

async function resolveShortLink(slug, env) {
  const raw = await env.PLAYLISTS.get(slug);
  if (raw === null) return redirect("/playlist/");

  let ids;
  try {
    ids = JSON.parse(raw).ids;
  } catch {
    return redirect("/playlist/");
  }
  // Stored playlists are immutable, so the redirect is edge-cacheable.
  return redirect("/playlist/#p=" + ids.join(","),
    { "Cache-Control": "public, max-age=86400" });
}

// The code -> deep-link map, fetched through the assets binding once per
// isolate and kept for its lifetime; a failed fetch is forgotten so the next
// request tries again rather than 404ing every share link until a restart.
let trackLinks = null;

function loadTrackLinks(env, url) {
  if (!trackLinks) {
    trackLinks = env.ASSETS.fetch(new URL("/assets/track-links.json", url))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("track-links " + r.status))))
      .catch(() => { trackLinks = null; return {}; });
  }
  return trackLinks;
}

async function resolveTrackLink(code, env, url) {
  const links = await loadTrackLinks(env, url);
  const target = Object.prototype.hasOwnProperty.call(links, code) ? links[code] : null;
  if (typeof target !== "string" || target.charCodeAt(0) !== 47) return null;
  // An hour, not the day /play/ gets: a playlist entry is immutable, but a
  // republished show can move a code's target.
  return redirect(target, { "Cache-Control": "public, max-age=3600" });
}

function safeIds(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v.ids) ? v.ids : null;
  } catch {
    return null;
  }
}

function ok(slug, origin) {
  // Match the host the request came in on (apex vs www) so the browser's own
  // verification fetch (see scripts/playlist.js) is same-origin, not blocked
  // by CORS — a www visitor who got an apex link would fail that check.
  return new Response(JSON.stringify({ slug, url: origin + "/play/" + slug }),
    { headers: { "Content-Type": "application/json" } });
}

function err(status, message) {
  return new Response(JSON.stringify({ error: message }),
    { status, headers: { "Content-Type": "application/json" } });
}

function redirect(to, extra, status) {
  return new Response(null,
    { status: status || 302, headers: Object.assign({ Location: to }, extra || {}) });
}
