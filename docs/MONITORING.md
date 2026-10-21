# Error monitoring (Sentry)

Optional. Without `SENTRY_DSN` nothing is loaded and nothing is sent. Design and reasoning: [ADR 0022](adr/0022-optional-sentry-allow-list-scrubber.md).

## Turn it on

1. Create a Sentry project for Node (and, if you want browser errors, a second one for Browser; one project works for both).
2. Set the variables below on the server (on Render: Environment > add variable) and redeploy. No web rebuild is needed: the browser reads its settings from `GET /runtime-config.json`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTRY_DSN` | unset (off) | Server DSN. |
| `SENTRY_WEB_DSN` | `SENTRY_DSN` | DSN handed to the browser. A browser DSN is visible to every visitor of the app; that is how browser Sentry works and it only permits submitting events. |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Environment tag. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.05` | Share of requests traced (0 turns tracing off). Errors are always captured. |
| `SENTRY_RELEASE` | `RENDER_GIT_COMMIT`, then `GIT_SHA` | Release name. |

See [CONFIGURATION.md](CONFIGURATION.md) (generated). An invalid DSN is logged at start-up and monitoring stays off; it does not stop the server.

3. Check it: sign in to the platform console (`/admin`), open **Monitoring** and press **Send a test error** (superadmin only). It sends one clearly labelled error through the real capture path and reports whether delivery was confirmed.

## What is captured

- Unhandled exceptions and rejections (process level), 5xx responses and uncaught route errors, permanent background job failures, socket event handler errors, and (browser) render errors from the error boundary plus unhandled errors and rejections.
- Not captured: 4xx responses, validation errors, rate limiting, aborted requests, socket disconnects and network drops in the browser.
- Tags: `route` (the pattern, for example `/api/rooms/:id/messages`), `method`, `status`, `request_id` or `socket_id` (also in the logs), `workspace` (salted hash, not the id), `plan`, `area` (`http`, `socket`, `job`, `process`, `react`), `event` (socket event name), `job_type`.

## What is never sent

Events are rebuilt from an allow-list; anything not listed is dropped, not redacted. Never sent: request and response bodies, headers (including `Authorization` and cookies), query strings and URLs, IP addresses and user records, message text, contact names, emails and phone numbers, attachments, Twilio, SendGrid and Stripe credentials, visitor session and widget tokens, breadcrumbs, local variables and source lines. Free text that is kept (the exception message and function names) is additionally pattern-redacted for emails, phone numbers, JWTs, Bearer and Basic values, provider key formats and long hex strings. No session replay in the browser. `widget.js` contains no monitoring code.

Tests: `server/tests/monitoring.test.ts` (scrubber matrix over headers, cookies, bodies, URLs with tokens, emails, phones, nested objects and arrays; 4xx ignored, 5xx captured with tags; no DSN means no SDK, no network; invalid DSN does not crash; flush on shutdown) and `web/src/monitoring/monitoring.test.tsx`. All use a fake transport.

## Operating notes

- Shutdown flushes pending events (up to 2 seconds) before the process exits.
- The server initialises the monitor before the database and sockets so start-up failures are reported.
- Automatic HTTP and database instrumentation is deliberately off (it observes URLs and SQL). Request transactions are created by a middleware and named by route pattern. Performance data is sampled and carries no payloads.
- The browser SDK is a separate lazy chunk (about 150 KB gzip), downloaded about 1.5 seconds after load and only when `/runtime-config.json` has a DSN.

## Source maps (optional, your CI, your token)

The app never holds a Sentry auth token and does not upload source maps. To get readable browser stacks, add a CI step with your own token (kept in the CI secret store):

```sh
npm run build --prefix web
npx @sentry/cli sourcemaps inject web/dist
SENTRY_AUTH_TOKEN=... npx @sentry/cli sourcemaps upload --org <org> --project <project> --release "$RENDER_GIT_COMMIT" web/dist
```

Set `build.sourcemap: true` in `web/vite.config.ts` for that build, and delete the `.map` files from `dist` before deploying if you do not want them public. Use the same release name as `SENTRY_RELEASE`. Not run in this repository (needs your Sentry account).

## Not verified

Delivery to a real Sentry project, the Sentry UI grouping and the source-map flow were not exercised here; tests prove what the SDK would send through a fake transport.
