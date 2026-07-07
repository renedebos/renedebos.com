// POST /api/playlist — store a playlist's track-id list in KV, return a short
// slug for /play/{slug}. Deployed automatically with the Pages site (this is a
// Pages Function, not a separate Worker). Spec: PLAYLIST FEATURE.md, Phase 4.
//
// Slugs are content-addressed: the first 6 hex chars of SHA-256 of the id
// list, lengthened only on the (astronomically rare) collision with different
// content. Same playlist → same slug, so re-shares dedupe instead of piling
// up KV entries. Entries never expire — playlists are tiny.

const ID_RE = /^[a-z0-9-]{1,80}$/;
const MAX_TRACKS = 500;

export async function onRequestPost({ request, env }) {
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
