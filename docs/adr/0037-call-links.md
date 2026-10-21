# 0037. Call links: an unguessable address that lets one person join one call, and nothing else

Status: accepted (2026-10-21).

## Context

Visitors who have closed the chat cannot be rung, and some people never open the chat page at all (a phone call someone wants to turn into video, an email follow-up, the AI assistant asked to "send me a link"). The team and the AI assistant need a way to hand a visitor an address that joins a voice or video call at once: no account, no password, no form. An address that works as a credential is dangerous by nature (it ends up in logs, referrers, screenshots and chat histories), so the design is mostly about what the address can do and where it can leak.

## Decision

1. **The token is random and checkable without the database.** `id` is 16 random bytes (128 bits, base64url); the token is `id.` plus an HMAC-SHA256 of the id under a server secret (43 characters), so a guess needs 128 bits, and a malformed or forged token is refused before any query. The database stores only the SHA-256 of the whole token (migration 040), never the token. The team's own copy of the thread never shows the address either: the visitor's copy of the card derives it again from the link id, which only this server can do. A link used up or revoked has no address to show.
2. **One link, one conversation, one call, one device.** A link belongs to one room; making a new one replaces the old (at most one live link per conversation); it expires (30 minutes by default, 5 minutes to 24 hours by setting or per request); it is revocable; the first device that opens it owns it (a second device gets the generic refusal; the same device can come back); the call that starts through it uses it up when it ends. Links are limited to 10 per conversation per hour.
3. **Opening a link mints a session that can only take part in that call.** `visitor_sessions.call_link_id` marks it. Its room scope is the one room; its sockets join a `vcall:` channel (call events only, no `message:new`, no history); the socket accepts a short allow-list of events (the `call:*` signalling and the `aicall:*` events); public REST answers `403 LINK_SESSION`. It expires with the link plus the time a running call may take.
4. **One generic refusal.** Unknown, malformed, expired, used, revoked, wrong device, AI off, calls off: the same `404 LINK_UNAVAILABLE` and the same sentence on the page, so a probe learns nothing. Failures strike the caller's address; repeated failures block it (`calls.link.fail.ip`), and previews and redeems have their own limits.
5. **The page is one document for every address.** `GET /call/<token>` returns the same static page whatever the token (never `404`, never cached, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a strict CSP). The script reads the token, removes it from the address bar at once (`history.replaceState`), and sends it in a POST body only (preview, redeem). The access log, the error reports and the audit log never contain it (`scrubCallPath`, scrubber patterns).
6. **Disclosure comes first.** For an AI link the page names the assistant and says it is an AI, not a person, before anything is asked; the only input is an optional display name. The browser asks for the microphone (and camera, for a team video call) when the call starts. The same engines, the same TURN credentials and the same state machine as every other call run on the page.
7. **Three ways to give it out.** The team's "Copy call link" (and the card it posts in the thread), the AI agent's `share_call_link` tool (an allowed action, off by default), and, only for a contact who agreed to be contacted (and never one who unsubscribed or opted out), email or SMS through the workspace's own providers, which report `not_sent_test_mode` honestly in test mode. A link sent that way stays in that message like any message: that is stated in the docs and the settings page.
8. **Off by default** (`calls.links.enabled`), with switches for the AI and for the team.

## Alternatives considered

- **A signed JWT with an expiry**: stateless, but cannot be single-use, revoked or bound to a device without a table anyway; the table is cheap.
- **Storing the token** so the thread can show it: a database leak would hand out live links; deriving it from the id keeps that out of the database.
- **A normal visitor session for the link** (so the visitor sees the whole chat): the link would then be a key to the conversation's history, not just to a call.
- **Showing why a link failed**: helps an honest visitor a little and an attacker a lot.

## Consequences

- A reload of the page after the token was stripped shows the generic message: the visitor asks for a new link (a deliberate cost of keeping the credential out of the address bar and history).
- The link works as a bearer credential for its lifetime: anyone who receives it first can join. Short lifetimes, one device and replace-on-new limit that; the docs say it.
- The host app's bridge receives the address when the visitor taps Join (`link_clicked`, source `call_link`), so it can open the system browser; it must treat it as a secret.
