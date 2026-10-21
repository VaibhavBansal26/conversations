# 0022. Optional Sentry monitoring that rebuilds events from an allow-list

Status: accepted (2026-10-21).

## Context

Operators want to hear about unexpected errors without watching logs. The product handles customer conversations, phone numbers, email addresses and provider credentials, so an error reporter that copies request data is a privacy incident waiting to happen. Sentry's SDK collects request bodies, headers, cookies and user data depending on version and integration defaults, and those defaults change between releases.

## Decision

- **Off by default.** With no `SENTRY_DSN` (or an invalid one) the server uses a no-op monitor: `@sentry/node` is not imported, no listeners are installed and nothing leaves the process. The SDK is loaded with a dynamic `import()` only when a valid DSN is set.
- **Rebuild, do not redact.** `beforeSend` and `beforeSendTransaction` construct a new event from a short allow-list (exception type, a pattern-redacted message, stack frames without source lines or variables, release, environment, a fixed set of tags, the HTTP method). A field that the scrubber does not name is never sent, so a new SDK integration or a default that changes in a later version cannot start leaking. The SDK is additionally configured not to collect (`sendDefaultPii: false`, `dataCollection` all off, no default integrations, no breadcrumbs, `includeLocalVariables`-style data off) so the scrubber is the second line, not the only one.
- **Identify, never identity.** Tags carry the route *pattern* (`/api/rooms/:id/messages`), request or socket id, plan, and `workspace` as a salted SHA-256 prefix. Raw ids, URLs and query strings are not sent.
- **Ignore the expected.** 4xx, validation, rate-limit, aborted requests and socket disconnects are dropped before they are sent; they are user-visible outcomes, not defects.
- **Static trace lifecycle.** `@sentry/node` 11 streams spans by default, which bypasses `beforeSendTransaction`; the server sets `traceLifecycle: "static"` so transactions pass the same allow-list. Request transactions are created by a small middleware named by route pattern. Automatic http/pg instrumentation is not enabled (it would observe URLs and SQL).
- **Browser: same rules, lazy.** The web app fetches `/runtime-config.json` after first paint and only then downloads the Sentry chunk (excluded from the per-chunk budget, never part of the initial payload). No replay, no breadcrumbs, a copy of the scrubber, an error boundary. `widget.js` has no monitoring so a third-party site is never affected.
- **No Sentry credentials in the app.** No auth token, no source-map upload at runtime; [MONITORING.md](../MONITORING.md) shows the CI step to use with the operator's own token.

## Alternatives considered

- **Sentry's default scrubbing and `denyUrls`/`ignoreErrors` only**: denies known fields; anything new leaks by default.
- **OpenTelemetry only**: already supported for traces, but gives no error grouping or alerting.
- **Self-hosted error collector**: more to operate for a product that deploys to a free tier.

## Consequences

- Fewer fields in each event than Sentry's defaults: no local variables, no source context lines, no request headers. Debugging relies on the stack, tags and the request id that also appears in the logs.
- Two copies of the scrubber (server and web) must be kept in step; both have tests.
- Not verified against a real Sentry project in this environment: tests use a fake transport.
