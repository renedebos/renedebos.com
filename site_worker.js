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

const ID_RE = /^[a-z0-9-]{1,80}$/;
// Liberal in what we accept: trailing slash (chat apps often append one when
// linkifying), any letter case, and HEAD as well as GET (link previewers).
const SLUG_RE = /^\/play\/([a-f0-9]{6,64})\/?$/i;
const MAX_TRACKS = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/playlist" && request.method === "POST") {
      return createShortLink(request, env, url.origin);
    }

    const m = url.pathname.match(SLUG_RE);
    if (m && (request.method === "GET" || request.method === "HEAD")) {
      return resolveShortLink(m[1].toLowerCase(), env);
    }

    const resp = await env.ASSETS.fetch(request);
    if (resp.status === 404) {
      // Serve the branded 404 ourselves (see routing note above); no-store so
      // a transient miss (mid-deploy, propagation) can't shadow a fix later.
      const page = await env.ASSETS.fetch(new URL("/404.html", url));
      return new Response(request.method === "HEAD" ? null : page.body, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return resp;
  },
};

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

function redirect(to, extra) {
  return new Response(null,
    { status: 302, headers: Object.assign({ Location: to }, extra || {}) });
}
