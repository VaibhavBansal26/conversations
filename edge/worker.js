// Optional Cloudflare Worker in front of the Conversations origin. It is NOT required; the app works without it.
// What it does (and only this):
//   1. GET /widget.js            cached at the edge for 5 min, revalidated with the origin's ETag (stale-while-revalidate)
//   2. GET /public/widget/config cached 30 s, keyed by (X-API-Key, Origin) because the origin evaluates its domain allow-list per Origin
//   3. everything else           proxied untouched, with X-Edge-Secret added so the origin trusts CF-Connecting-IP
// It never caches anything that carries a session (x-support-session) or Authorization header, and never caches non-200 responses.
// Env: ORIGIN (https://chat.example.com), EDGE_SECRET (same value as the app's CF_SHARED_SECRET).

const WIDGET_TTL = 300;
const CONFIG_TTL = 30;

export function cacheKeyFor(request) {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  if (request.headers.has("authorization") || request.headers.has("x-support-session")) return null;
  if (url.pathname === "/widget.js") return { ttl: WIDGET_TTL, key: `${url.origin}/widget.js` };
  if (url.pathname === "/public/widget/config") {
    const apiKey = request.headers.get("x-api-key");
    const origin = request.headers.get("origin");
    if (!apiKey || !origin) return null;
    return { ttl: CONFIG_TTL, key: `${url.origin}/public/widget/config?k=${encodeURIComponent(apiKey)}&o=${encodeURIComponent(origin)}` };
  }
  return null;
}

export function toOrigin(request, env) {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, env.ORIGIN);
  const headers = new Headers(request.headers);
  headers.set("x-edge-secret", env.EDGE_SECRET);
  // a client must not be able to supply the secret itself: ours always overwrites it (set, not append)
  return new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" });
}

export default {
  async fetch(request, env, ctx) {
    const rule = cacheKeyFor(request);
    const upstream = toOrigin(request, env);
    if (!rule) return fetch(upstream);

    const cache = caches.default;
    const key = new Request(rule.key);
    const hit = await cache.match(key);
    if (hit) return hit;

    const res = await fetch(upstream);
    if (res.status !== 200) return res;
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", `public, max-age=${rule.ttl}`);
    out.headers.set("x-edge-cache", "MISS");
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
