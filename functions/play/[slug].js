// GET /play/{slug} — resolve a short playlist link from KV and redirect to the
// player with the exact track list in the hash (the /playlist/ page already
// hydrates from #p=). Unknown slugs land on the empty playlist builder.
// Playlists are immutable once stored, so the redirect is edge-cacheable.

const SLUG_RE = /^[a-f0-9]{6,64}$/;

export async function onRequestGet({ params, env }) {
  const slug = params.slug;
  if (!SLUG_RE.test(slug)) return redirect("/playlist/", 302);

  const raw = await env.PLAYLISTS.get(slug);
  if (raw === null) return redirect("/playlist/", 302);

  let ids;
  try {
    ids = JSON.parse(raw).ids;
  } catch {
    return redirect("/playlist/", 302);
  }
  return redirect("/playlist/#p=" + ids.join(","), 302,
    { "Cache-Control": "public, max-age=86400" });
}

function redirect(to, status, extra) {
  return new Response(null,
    { status, headers: Object.assign({ Location: to }, extra || {}) });
}
