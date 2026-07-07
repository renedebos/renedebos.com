// renedebos-site: serves the static site (Workers assets) plus the playlist
// short-link endpoints. Deployed by the GitHub Action via `npx wrangler deploy`
// (config in wrangler.jsonc); the wav-download Worker in worker/ is separate.
//
// Routing: paths that match an uploaded asset are served directly and never
// reach this script; everything else lands here. We handle the two API routes
// and fall back to the assets binding (whose not_found_handling serves the
// branded 404 page) for the rest.
//
// Short links (PLAYLIST FEATURE.md, Phase 4): slugs are content-addressed —
// the first 6 hex chars of SHA-256 of the track-id list, lengthened only on
// collision with different content — so the same playlist always maps to the
// same slug and re-shares dedupe. Entries never expire.

const ID_RE = /^[a-z0-9-]{1,80}$/;
const SLUG_RE = /^\/play\/([a-f0-9]{6,64})$/;
const MAX_TRACKS = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/playlist" && request.method === "POST") {
      return createShortLink(request, env);
    }

    const m = url.pathname.match(SLUG_RE);
    if (m && request.method === "GET") {
      return resolveShortLink(m[1], env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function createShortLink(request, env) {
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
      return ok(slug);
    }
    const same = safeIds(existing);
    if (same && same.join(",") === ids.join(",")) return ok(slug); // dedupe
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

function ok(slug) {
  return new Response(JSON.stringify({ slug, url: "https://renedebos.com/play/" + slug }),
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
