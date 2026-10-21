# 0020. The widget preview uses a signed flag, not a relaxed origin check

Status: accepted (2026-10-21).

## Context

Workspaces could not try the widget: the embed token is bound to a customer's domain and checked against `Origin`; a page served by the app itself sends no `Origin` on a same-origin GET, and its origin is not the token's domain, so `widget-demo.html` could not load the widget from its own host ([APPROACH.md](../APPROACH.md) named this as a known limitation and as a security boundary). Users could not see how the widget feels or reply to themselves without owning a website.

## Decision

- A manager asks for a preview link (`POST /api/tokens/:id/preview`, permission `tokens:manage`, audit entry). The link carries an HMAC-signed flag naming one token and its workspace, valid for 10 minutes. The preview page embeds the real `widget.js` with `data-preview=<flag>`; the widget sends it as `x-preview`.
- The server accepts the flag only for that token, and only from the app's own origin (no `Origin` header, or exactly `PUBLIC_URL`'s origin). Sessions it creates carry `preview = 1`, last 12 hours, and are accepted from the app's own origin only, over REST and sockets. The normal path is unchanged: real tokens still require the exact domain match, and a preview session is refused from any other site.
- Preview requests do not set `last_seen_*`, so "verify installation" reflects the real site only.

## Alternatives considered

- **Allow the app's own origin for every token.** Simple, but any logged-in or anonymous page on the app's origin could then act as every workspace's widget, and the check is a security boundary.
- **`Sec-Fetch-Site: same-origin` allowance** (the idea in the old limitation note): the header is browser-set but trivially absent or forged by non-browser clients, and it would apply to all tokens.
- **Iframe the customer's site.** Does not work for sites that forbid framing, and still needs the customer's domain.

## Consequences

- A leaked preview link lets someone chat as a visitor into that workspace for 10 minutes (and keep a 12-hour session); it never reveals the token, and only works from the app's own origin. Conversations created this way are real conversations.
- The flag secret derives from `JWT_SECRET`; rotating it invalidates outstanding links, which is harmless.
