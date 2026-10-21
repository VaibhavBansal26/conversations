# Conversations

A unified customer inbox: **live chat** (embeddable widget), **SMS** and **email** in one place, with inboxes and round-robin routing, notes and mentions, snooze, templates, notifications and optional AI assistance (suggested replies, summaries, triage, rewriting, a widget auto-responder).

Standalone and self-contained: Node + SQLite, no external services required to run (SMS/email/AI fall back to console/offline providers). Scales out with PostgreSQL + Redis behind any load balancer (see [docs/SCALING.md](docs/SCALING.md)): partitioned messages, shared presence and rate limits, an outbox feeding an event bus, graceful drain, load-tested harness included.

## What is in it

- **Inbox**: live chat widget, SMS (Twilio) and email (SendGrid) in one place; inboxes with round-robin routing, notes and @mentions, snooze, templates, notifications, CSAT, optional AI assistance.
- **Team chat**: channels (public or private), direct and group messages, threads, reactions, pins, search, shared customer-conversation cards ([docs/TEAM-CHAT.md](docs/TEAM-CHAT.md)).
- **Channels you connect yourself**: each workspace pastes its own Twilio and SendGrid credentials and is told plainly when a channel is in test mode ([docs/CHANNELS.md](docs/CHANNELS.md)); the chat widget has a guided install and an in-app preview ([docs/WIDGET.md](docs/WIDGET.md)).
- **Access**: 38 permissions, four built-in roles plus custom roles, two-factor, invitations, audit log ([docs/RBAC.md](docs/RBAC.md)).
- **Money**: plans, prepaid credits with auto-recharge, and payment requests customers pay into the workspace's own Stripe account ([docs/STRIPE.md](docs/STRIPE.md); off unless `STRIPE_SECRET_KEY` is set).
- **Analytics**: dashboard and a versioned API with pseudonymous exports ([docs/ANALYTICS.md](docs/ANALYTICS.md)).
- **Operators**: a separate platform console at `/admin` ([docs/ADMIN.md](docs/ADMIN.md)); create the first operator with `npm run admin --prefix server -- create`.
- **Scale-out**: PostgreSQL (partitioned) + Redis behind any load balancer; load-test kit and capacity model included ([docs/SCALING.md](docs/SCALING.md)). Not run at 1,000,000 connections: see what was measured and what is extrapolated.

## Quick start

Requires Node >= 22.13 (developed on 24) and npm.

```bash
npm run setup          # install server/, web/ and e2e/ dependencies
npm run seed           # optional: demo workspace (demo@example.test / demo-password-123), dev only
                       # SEED_AI=1 npm run seed adds departments, an AI agent that is on and calls (docs/AI-AGENTS.md)
npm run dev            # API on http://localhost:3000, web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with the demo user (or register a new workspace). Try the widget: create an embed token for `localhost:3000` in *Settings -> Tokens*, or simply open *Settings -> Chat widget -> Install* and press *Try it now* to chat as a visitor in one tab and reply as an agent in another ([docs/WIDGET.md](docs/WIDGET.md)).

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
npm run docs:check          # links, index, generated docs (also part of npm test)
```

`npm run e2e` boots the built server and drives it with real HTTP and Socket.IO clients (visitor -> agent -> visitor round trip with receipts, plus a signed inbound-SMS webhook).

## Configuration

Everything is environment driven and validated at boot (`server/src/config.ts`); every variable is documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md) (generated) and `.env.example` is a starting point. Defaults make `npm run dev` work with no env at all.

| Concern | Variables |
| --- | --- |
| Secrets | `JWT_SECRET` (required in production), `DATA_ENCRYPTION_KEY` (required in production once analytics is used: encrypts the identity pepper) |
| Public URL / CORS | `PUBLIC_URL`, `CORS_ORIGINS`, `TRUST_PROXY` |
| SMS | `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (also verifies inbound webhooks) |
| Email | `EMAIL_PROVIDER=sendgrid`, `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY` or `WEBHOOK_SHARED_SECRET` |
| AI | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`); offline heuristics without a key |
| Scale-out | `DATABASE_URL` (PostgreSQL), `REDIS_URL`; both auto-detected. `DATABASE_REPLICA_URL`, `DATABASE_PGBOUNCER`, `NODE_ID` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, `PLAN_ENFORCEMENT` |
| Limits and edge | `WS_*` limits, `CF_SHARED_SECRET`, `TRUSTED_PROXY_HOPS`, `RATE_LIMIT_SCALE` (load tests only), `METRICS_TOKEN` |

Wiring real providers: point Twilio's inbound and status webhooks at `PUBLIC_URL/webhooks/twilio/sms` and `/webhooks/twilio/status`; point SendGrid inbound parse at `PUBLIC_URL/webhooks/sendgrid/inbound?secret=<WEBHOOK_SHARED_SECRET>` and the event webhook at `/webhooks/sendgrid/events`. Register your numbers, verified senders and inbound addresses in *Settings*.

## Mobile apps

The same chat runs in a native app's web view: switch **Hosted chat** on for a token (*Settings -> Chat widget -> Install*) and open `https://YOUR-APP/chat?token=cvt_...`. A documented, versioned JavaScript bridge reports unread counts, messages and links and accepts `identify`, `setLanguage`, `setTheme`, `reset` and more; users signed in to your app are recognised without a code through a server-signed identity hash. Guides: [docs/MOBILE-BRIDGE.md](docs/MOBILE-BRIDGE.md) (page, parameters, origin and identity model, bridge protocol), [docs/MOBILE-API.md](docs/MOBILE-API.md) (the public REST and Socket.IO API for fully native screens, push design note), [docs/MOBILE-SDKS.md](docs/MOBILE-SDKS.md) (iOS Swift package, Android library, React Native and Flutter guides, with what is built and what is only scaffolded).

## Embedding the widget

```html
<script src="https://YOUR-HOST/widget.js" data-token="cvt_..." async></script>
```

The token is bound to a domain (`example.com`, `*.example.com`, `localhost:3000`) in *Settings -> Tokens*. Appearance, required info, office hours, welcome/away messages and chat type are edited in *Settings -> Widget* with a live preview.

## Repository layout

```
server/    Hono + Socket.IO API, SQLite/PostgreSQL, Redis, jobs, rate limiter, AI   (docs/ARCHITECTURE.md)
web/       React agent app (inbox, settings, analytics, operator console), Tailwind v4 design system, Web Worker helpers   (docs/design/DESIGN.md)
e2e/       Playwright browser tests and the screenshot set for docs/design   (docs/TESTING.md)
edge/      optional Cloudflare Worker (widget cache, edge secret)
sdks/      native wrappers for the hosted chat: ios (Swift package), android (Kotlin library), react-native and flutter guides (not part of the Docker build)
loadtest/  multi-process socket/REST load harness, fault injection, dataset loader
deploy/    nginx, HAProxy, Kubernetes (kustomize, KEDA)    docker-compose.yml
docs/      ARCHITECTURE, SCALING, PERFORMANCE, RATE-LIMITING, RUNBOOK, CLOUDFLARE, ADRs, ...
```

Documentation index: [docs/README.md](docs/README.md). Quick links: [API](docs/API.md) | [Realtime](docs/REALTIME.md) | [Configuration](docs/CONFIGURATION.md) | [RBAC](docs/RBAC.md) | [Stripe](docs/STRIPE.md) | [Admin](docs/ADMIN.md) | [Analytics](docs/ANALYTICS.md) | [Security](docs/SECURITY.md) | [Changelog](CHANGELOG.md) | [Contributing](CONTRIBUTING.md) | [Architecture](docs/ARCHITECTURE.md) | [Scaling](docs/SCALING.md) | [Performance](docs/PERFORMANCE.md) | [Rate limiting](docs/RATE-LIMITING.md) | [Cloudflare](docs/CLOUDFLARE.md) | [Runbook](docs/RUNBOOK.md) | [Cloud load test](docs/CLOUD-LOADTEST.md) | [Approach](docs/APPROACH.md) | [AI](docs/AI.md) | [Testing](docs/TESTING.md) | [Migration notes](docs/MIGRATION-NOTES.md) | [Design system](docs/design/DESIGN.md) | [UI provenance](docs/PROVENANCE.md) | [ADRs](docs/adr/README.md)
