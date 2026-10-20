# Conversations

A unified customer inbox: **live chat** (embeddable widget), **SMS** and **email** in one place, with inboxes and round-robin routing, notes and mentions, snooze, templates, notifications and optional AI assistance (suggested replies, summaries, triage, rewriting, a widget auto-responder).

Standalone and self-contained: Node + SQLite, no external services required to run (SMS/email/AI fall back to console/offline providers). Scales out with PostgreSQL + Redis behind any load balancer (see [docs/SCALING.md](docs/SCALING.md)): partitioned messages, shared presence and rate limits, an outbox feeding an event bus, graceful drain, load-tested harness included.

## Quick start

Requires Node >= 22.13 (developed on 24) and npm.

```bash
npm run setup          # install server/ and web/ dependencies
npm run seed           # optional: demo workspace (demo@example.test / demo-password-123), dev only
npm run dev            # API on http://localhost:3000, web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with the demo user (or register a new workspace). Try the widget: create an embed token for `localhost:3000` in *Settings -> Tokens*, then open http://localhost:3000/widget-demo.html and paste the token (the seed already creates tokens for `localhost:5173` and `localhost:3000`).

### Production-style run

```bash
npm run build
JWT_SECRET=$(openssl rand -hex 32) npm start     # serves API, sockets, widget and the built web app on :3000
# or
npm run package && docker run -p 3000:3000 -v conv-data:/data -e JWT_SECRET=... conversations
```

### Run the scale-out topology locally

```bash
docker compose up --build        # 2 app nodes + nginx + Redis + PostgreSQL on http://localhost:8080
```

Without Docker: `loadtest/` starts PostgreSQL (embedded binary), Redis (`redis-server` on PATH) and N nodes for you (`node loadtest/run.mjs multinode --nodes 3`).

### Verify everything

```bash
npm run typecheck && npm test && npm run build && npm run e2e
```

`npm run e2e` boots the built server and drives it with real HTTP and Socket.IO clients (visitor -> agent -> visitor round trip with receipts, plus a signed inbound-SMS webhook).

## Configuration

Everything is environment driven and validated at boot (`server/src/config.ts`); see `.env.example` for the full list. Defaults make `npm run dev` work with no env at all.

| Concern | Variables |
| --- | --- |
| Secrets | `JWT_SECRET` (required in production) |
| Public URL / CORS | `PUBLIC_URL`, `CORS_ORIGINS`, `TRUST_PROXY` |
| SMS | `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (also verifies inbound webhooks) |
| Email | `EMAIL_PROVIDER=sendgrid`, `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY` or `WEBHOOK_SHARED_SECRET` |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`); offline heuristics without a key |
| Scale-out | `DATABASE_URL` (PostgreSQL), `REDIS_URL`; both auto-detected. `DATABASE_REPLICA_URL`, `DATABASE_PGBOUNCER`, `NODE_ID` |
| Limits and edge | `WS_*` limits, `CF_SHARED_SECRET`, `TRUSTED_PROXY_HOPS`, `RATE_LIMIT_SCALE` (load tests only), `METRICS_TOKEN` |

Wiring real providers: point Twilio's inbound and status webhooks at `PUBLIC_URL/webhooks/twilio/sms` and `/webhooks/twilio/status`; point SendGrid inbound parse at `PUBLIC_URL/webhooks/sendgrid/inbound?secret=<WEBHOOK_SHARED_SECRET>` and the event webhook at `/webhooks/sendgrid/events`. Register your numbers, verified senders and inbound addresses in *Settings*.

## Embedding the widget

```html
<script src="https://YOUR-HOST/widget.js" data-token="cvt_..." async></script>
```

The token is bound to a domain (`example.com`, `*.example.com`, `localhost:3000`) in *Settings -> Tokens*. Appearance, required info, office hours, welcome/away messages and chat type are edited in *Settings -> Widget* with a live preview.

## Repository layout

```
server/    Hono + Socket.IO API, SQLite/PostgreSQL, Redis, jobs, rate limiter, AI   (docs/ARCHITECTURE.md)
web/       React agent app (inbox, settings), Web Worker helpers
edge/      optional Cloudflare Worker (widget cache, edge secret)
loadtest/  multi-process socket/REST load harness, fault injection, dataset loader
deploy/    nginx, HAProxy, Kubernetes (kustomize, KEDA)    docker-compose.yml
docs/      ARCHITECTURE, SCALING, PERFORMANCE, RATE-LIMITING, RUNBOOK, CLOUDFLARE, ADRs, ...
```

Documentation: [Architecture](docs/ARCHITECTURE.md) | [Scaling](docs/SCALING.md) | [Performance](docs/PERFORMANCE.md) | [Rate limiting](docs/RATE-LIMITING.md) | [Cloudflare](docs/CLOUDFLARE.md) | [Runbook](docs/RUNBOOK.md) | [Cloud load test](docs/CLOUD-LOADTEST.md) | [Approach](docs/APPROACH.md) | [AI](docs/AI.md) | [Testing](docs/TESTING.md) | [Migration notes](docs/MIGRATION-NOTES.md) | [ADRs](docs/adr/README.md)
