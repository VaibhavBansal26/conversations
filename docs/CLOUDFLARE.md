# Running behind Cloudflare

Cloudflare in front of Conversations gives you TLS, DDoS absorption and a cache for the embed script. It also introduces three things that
bite WebSocket apps: real-client-IP handling, idle timeouts and what is safe to cache. This page covers each, and the optional Worker in
[`edge/`](../edge).

## 1. Real client IP: trust `CF-Connecting-IP` only with a shared secret

The app uses the client IP for rate limits, the per-IP connection cap and the visitor-session device check. Cloudflare puts the client IP in
`CF-Connecting-IP`, but **any client can send that header** if it can reach the origin directly, and an attacker who can forge it can dodge
every per-IP limit. So the app believes `CF-Connecting-IP` only when the request also carries a secret header that only your Cloudflare
configuration can add:

| Setting | Meaning |
| --- | --- |
| `CF_SHARED_SECRET` (app env) | A long random string. Unset = `CF-Connecting-IP` is ignored entirely. |
| `X-Edge-Secret: <same value>` | Added by Cloudflare to every request it forwards. |

Resolution order (`server/src/util/clientIp.ts`, covered by unit tests):

1. `X-Edge-Secret` equals `CF_SHARED_SECRET` and `CF-Connecting-IP` is present: use `CF-Connecting-IP`.
2. else if `TRUST_PROXY=true`: first entry of `X-Forwarded-For`.
3. else the TCP peer address.

Add the header with a **Transform Rule** (Rules > Transform Rules > Modify Request Header): *Set static* `X-Edge-Secret` to the secret, for
the whole hostname. Or let the optional Worker do it (section 4). Rotate the secret by deploying the new value to the app first (the app
accepts exactly one value, so schedule it in a quiet moment), then updating the rule.

Also firewall the origin so only Cloudflare (or your load balancer) can reach it. The shared secret protects the IP logic, it does not
replace network-level protection.

## 2. WebSockets through Cloudflare

* WebSockets are enabled by default on all plans (Network > WebSockets: On).
* Cloudflare closes a connection after **100 seconds without data** (on the free/pro plans; higher on enterprise). Socket.IO pings every
  `WS_PING_INTERVAL_MS` (default 25 s) which keeps it open; do not raise the interval above ~60 s behind Cloudflare.
* Cloudflare can close any connection during its own maintenance. Clients reconnect with exponential backoff and **80% jitter**
  (`reconnectionDelay` 1 s, max 30 s, `randomizationFactor` 0.8) and re-sync missed messages over REST, so a Cloudflare-side drop is invisible
  to users beyond a brief "reconnecting" banner.
* Set `WS_TRANSPORTS=websocket` once all your clients (web app, widget) are current. Polling-first adds a sticky-session requirement
  (Cloudflare Load Balancing session affinity, or an `ip_hash` at your own LB) that websocket-only does not have. The default stays
  `polling,websocket` so old embeds keep working.
* `WS_MAX_CONNECTIONS_PER_IP` should stay 0 (unlimited) or generous when `CF_SHARED_SECRET` is **not** set: without it every visitor looks like a
  Cloudflare edge address and a per-IP cap would throttle unrelated users.

## 3. What to cache

| Path | Cache? | Notes |
| --- | --- | --- |
| `/widget.js` | Yes | Origin sends `Cache-Control: public, max-age=300, stale-while-revalidate=86400`, an `ETag`, `Vary: Accept-Encoding` and pre-compressed br/gzip bodies. Cloudflare honours these; a deploy is live everywhere within 5 minutes. |
| `/assets/*` (web app) | Yes | Content-hashed filenames, `immutable`, one-year max-age. |
| `/public/widget/config` | Edge only, 30 s | Origin sends `s-maxage=30` and `Vary: Origin, X-API-Key`. **Cloudflare ignores `Vary` for most headers on non-Enterprise plans**, so do not rely on a plain Cache Rule for this path: it could serve one customer's config to another origin. Use the Worker in `edge/`, which puts API key and Origin into the cache key. |
| `/chat`, `/chat/bridge-test`, `/chat/assets/*` (hosted chat for mobile) | Assets only | The pages answer `Cache-Control: no-store` and their `Content-Security-Policy` differs per token, so never cache them or add a Cloudflare header-modifying rule that sets `X-Frame-Options` or a CSP. `/chat/assets/*` carry `max-age=300` like `widget.js` and can be cached. See [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md). |
| `/api/*`, `/public/*` (everything else), `/socket.io/*` | **No** | Per-user, per-session or realtime. A Cache Rule with "Bypass cache" for `/api/*`, `/public/*` and `/socket.io/*` makes this explicit. |
| `/files/*` | No (or by signed URL only) | URLs are signed and expire; caching would outlive the signature. |

## 4. The optional edge Worker

[`edge/worker.js`](../edge/worker.js) (about 60 lines, no dependencies) is **optional**: the app works without it.

* caches `/widget.js` for 5 minutes and `/public/widget/config` for 30 seconds, never anything with `Authorization` or `x-support-session`
  and never a non-200;
* keys the config cache by `(X-API-Key, Origin)`, because the origin evaluates the embed token's domain allow-list per Origin;
* adds `X-Edge-Secret` to every request it forwards, overwriting any client-supplied value.

Deploy:

```bash
cd edge
npx wrangler secret put EDGE_SECRET      # same value as the app's CF_SHARED_SECRET
# edit wrangler.toml: ORIGIN = "https://chat.example.com"  (the origin hostname, not the one the Worker is routed on)
npx wrangler deploy
npm test                                  # 3 tests, node:test, no Cloudflare needed
```

Route the Worker on your public hostname and point the origin at a different hostname (or an unproxied record) so the Worker does not call
itself.

Limitations: the Worker was unit-tested with faked `caches`/`fetch` only; it has not been run on Cloudflare's runtime in this repo's
CI. WebSocket upgrade requests are passed through `fetch(upstream)`, which Workers support, but there is no automated test for that path.

## 5. Checklist

1. `CF_SHARED_SECRET` set on the app, same value in the Transform Rule or Worker.
2. Origin reachable only from Cloudflare.
3. Cache Rules: bypass `/api/*`, `/public/*`, `/socket.io/*`, `/files/*`.
4. `TRUST_PROXY=true` only if a proxy of yours sits between Cloudflare and the app (nginx in `deploy/nginx.conf` does).
5. SSL/TLS mode "Full (strict)".
6. Confirm with `curl -s https://chat.example.com/readyz` and a browser WebSocket test in DevTools (status 101).
