# 0024. The hosted chat uses a per-token flag and the app's own origin

Status: accepted (2026-10-21).

## Context

Native apps need the chat without a website: a web view opens a full-page chat. The embed token's domain allow-list (`Origin` must match the token's domain; missing or `null` never matches) is a security boundary for the website widget and must not weaken. A page served by the app itself calls the API same-origin: its POSTs carry `Origin: PUBLIC_URL`, its GETs carry no `Origin` at all, and a native HTTP client has none either. [ADR 0020](0020-widget-preview-flag.md) solved the same problem for the in-app preview with a short-lived signed flag; the hosted chat is long-lived and used by real customers, so a 10-minute flag does not fit.

## Decision

- A column `tokens.hosted_chat_enabled` (default 0, set per token by a manager, audited). For a token with the flag, `authenticateToken` also accepts `Origin` equal to `PUBLIC_URL`'s origin, or no `Origin` together with `x-hosted-chat: 1`. Everything else (flag off, `null`, other origins, the unmarked absence of `Origin`) is refused exactly as before. The token's own domain keeps working.
- Sessions are not marked: `sessionOriginAllowed` and the socket handshake accept the app's origin when the token still has the flag, so switching it off ends hosted use immediately, with no session clean-up.
- Hosted requests never set `last_seen_*`, so the install check still means "your website loaded the widget".
- `GET /chat` is served by the app with its own header set: strict CSP (everything `'self'`, no inline script or style), `frame-ancestors 'self'` plus the token's domain, no `X-Frame-Options` when framing is allowed and `DENY` otherwise. Only an allow-listed `lang`, `dir`, `theme` and the token's own domain are written into the HTML. Invalid, revoked or flag-off tokens and suspended workspaces get one generic 403 page.

## Alternatives considered

- **Allow the app's own origin for every token** (rejected in ADR 0020 as well): any page on the app's origin would act as every workspace's widget.
- **Reuse the signed preview flag with a long life**: the flag is a bearer credential in a URL; long-lived links are worse than a column a manager can switch off.
- **A separate token type for apps**: more surface (new table, rotation, UI) for the same property; the flag on the existing token reuses rotation, revocation, audit and the install UI.
- **Skip the `Origin` check for the marker header alone, for all tokens**: would open the widget token to any non-browser client without a decision by the workspace. Native clients can already set any `Origin` they like, so the check protects against cross-site browser use only; the flag keeps that decision explicit.

## Consequences

- With the flag on, any client that sends `x-hosted-chat: 1` without an `Origin` can use that token. The token is public (it is in every website's HTML), so this reveals nothing and the same client could always have forged `Origin`. Protecting known customers is the job of identity verification ([ADR 0025](0025-signed-visitor-identity.md)).
- A cross-site browser request always carries an `Origin`, so no website gains access through the marker.
- Behind a proxy `PUBLIC_URL` must be the address the web view loads, or the hosted chat's calls are refused (documented in MOBILE-BRIDGE.md troubleshooting).
