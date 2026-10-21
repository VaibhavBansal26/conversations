# Documentation index

Every document under `docs/` is listed here (a check fails otherwise). Generated files say so at the top and are verified by `npm run docs:check --prefix server`; see [CONTRIBUTING.md](../CONTRIBUTING.md) for how to update docs with a change.

## If you want to...

| If you want to... | Read |
| --- | --- |
| install the chat widget, understand domain rules, fix a widget that does not show | [WIDGET.md](WIDGET.md) |
| put the chat in a mobile app's web view, use the JavaScript bridge, verify signed-in users | [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md), [bridge/](bridge/envelope.schema.json) |
| build native chat screens with the public API, or plan push notifications | [MOBILE-API.md](MOBILE-API.md), [openapi-public.json](openapi-public.json) |
| use the iOS or Android wrapper, React Native or Flutter | [MOBILE-SDKS.md](MOBILE-SDKS.md) |
| use or understand team chat (channels, DMs, threads) | [TEAM-CHAT.md](TEAM-CHAT.md) |
| connect Twilio and SendGrid, read the SMS/email setup guide | [CHANNELS.md](CHANNELS.md) |
| deploy it for free (Render, GitHub-connected) | [DEPLOY.md](DEPLOY.md) |
| run it and see it work | [../README.md](../README.md) (quick start), [TESTING.md](TESTING.md) |
| understand how it is built | [ARCHITECTURE.md](ARCHITECTURE.md), [APPROACH.md](APPROACH.md), [adr/README.md](adr/README.md) |
| configure it (every environment variable) | [CONFIGURATION.md](CONFIGURATION.md) |
| call the API, or see the exact request and response fields | [API.md](API.md), [openapi.json](openapi.json) |
| use the realtime socket protocol | [REALTIME.md](REALTIME.md) |
| understand roles, permissions, sessions, two-factor | [RBAC.md](RBAC.md) |
| set up plans, credits, auto-recharge, customer payments | [STRIPE.md](STRIPE.md) |
| operate many workspaces (suspend, credits, support access) | [ADMIN.md](ADMIN.md) |
| feed analytics to another system | [ANALYTICS.md](ANALYTICS.md), [analytics-api/schema-version.json](analytics-api/schema-version.json) |
| tune or understand rate limits | [RATE-LIMITING.md](RATE-LIMITING.md) |
| put it behind Cloudflare | [CLOUDFLARE.md](CLOUDFLARE.md) |
| size a deployment, know the limits | [SCALING.md](SCALING.md), [PERFORMANCE.md](PERFORMANCE.md) |
| validate the big numbers in a cloud account | [CLOUD-LOADTEST.md](CLOUD-LOADTEST.md), `../loadtest/README.md` |
| run it in production, handle an incident | [RUNBOOK.md](RUNBOOK.md) |
| get told about errors (Sentry), and know what is never sent | [MONITORING.md](MONITORING.md) |
| review security, report a vulnerability | [SECURITY.md](SECURITY.md) |
| learn the vocabulary (and the legacy names) | [GLOSSARY.md](GLOSSARY.md), [MIGRATION-NOTES.md](MIGRATION-NOTES.md) |
| understand the AI features | [AI.md](AI.md) |
| understand tickets, AI support agents, departments, visitor details and calls | [AI-AGENTS.md](AI-AGENTS.md), [DEPARTMENTS.md](DEPARTMENTS.md) |
| place voice and video calls (also group calls), set up TURN, understand call states and limits | [CALLS.md](CALLS.md) |
| send visitors a copy of their conversation by email (who may receive it, what it contains) | [TRANSCRIPTS.md](TRANSCRIPTS.md) |
| get push notifications on your devices, set up VAPID keys, understand what a notification may contain | [TRANSCRIPTS.md](TRANSCRIPTS.md) | copies of a conversation by email: recipients and confirmation, contents, limits, the automatic copy, unsubscribe, routes, what is verified |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) |
| set up departments, opening hours, routing modes, capacity, service levels and routing rules | [DEPARTMENTS.md](DEPARTMENTS.md) |
| see what changed | [../CHANGELOG.md](../CHANGELOG.md) |

## Documents

| Document | What it is |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | system context, containers, code layout, data model, key flows, background work, limits |
| [APPROACH.md](APPROACH.md) | stack choices, design principles, judgement calls, known limitations |
| [AI.md](AI.md) | AI features, providers, prompt safety, offline heuristics |
| [AI-AGENTS.md](AI-AGENTS.md) | tickets and their lifecycle, AI support agents, departments and routing, visitor details in the widget, voice and video calls: what is built, tested and unverified |
| [CALLS.md](CALLS.md) | voice and video calls: browser calls (signalling, states, TURN and STUN with coturn samples, permissions, privacy, what is verified) and phone calls |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | in-app, email and Web Push notifications for team members (events, privacy, VAPID setup, what is and is not verified), the visitor side, and the mobile push (APNs/FCM) design that is not built |
| [DEPARTMENTS.md](DEPARTMENTS.md) | departments (inboxes with routing configuration): hours and holidays, who is available, routing modes, capacity, the queue, service levels, transfer, routing rules, race safety |
| [TESTING.md](TESTING.md) | test strategy, how to run, test catalogue, edge-case map, test counts |
| [MIGRATION-NOTES.md](MIGRATION-NOTES.md) | legacy to new mapping of collections, endpoints, events, and defects not carried over |
| [CONFIGURATION.md](CONFIGURATION.md) | every environment variable: type, default, example, meaning, security notes (generated) |
| [API.md](API.md) | REST conventions, errors, pagination, rate-limit headers, examples, route reference (generated) |
| [openapi.json](openapi.json) | OpenAPI 3.1 description of the REST API (generated) |
| [REALTIME.md](REALTIME.md) | Socket.IO protocol: connecting, audiences, client and server events |
| [RBAC.md](RBAC.md) | permissions, roles, deny-by-default enforcement, sessions, refresh rotation, MFA, invitations, audit |
| [STRIPE.md](STRIPE.md) | plans, credits, auto-recharge, grace and soft lock, Connect payment requests, webhooks, what is untested |
| [ADMIN.md](ADMIN.md) | the platform console: operators, sign-in, suspension, credits, support access, audit |
| [ANALYTICS.md](ANALYTICS.md) | metric definitions, the API, API keys, privacy, schemas and contract tests |
| [analytics-api/](analytics-api/schema-version.json) | JSON Schemas of the analytics API responses (generated, validated by contract tests) |
| [RATE-LIMITING.md](RATE-LIMITING.md) | the layered limiter, policy table (generated), failure modes, operations |
| [CLOUDFLARE.md](CLOUDFLARE.md) | edge Worker, trusted client IP, caching the widget, WAF notes |
| [SCALING.md](SCALING.md) | targets, capacity model with measured constants, sizing tables, bottlenecks, tuning, measured versus extrapolated |
| [PERFORMANCE.md](PERFORMANCE.md) | every measurement: method, machine, numbers, caveats |
| [CLOUD-LOADTEST.md](CLOUD-LOADTEST.md) | how to validate the extrapolated figures at scale, result tables, cost estimate |
| [RUNBOOK.md](RUNBOOK.md) | capacity and billing incident playbooks, dashboards, alerts, SLOs, deploys, secrets, backups |
| [MONITORING.md](MONITORING.md) | optional Sentry error monitoring: configuration, exactly what is and is not sent, testing it, source maps in CI |
| [CHANNELS.md](CHANNELS.md) | SMS and email: test mode, per-workspace Twilio and SendGrid connections, webhook verification, provider caveats, smoke test |
| [WIDGET.md](WIDGET.md) | install guide (HTML, WordPress, Shopify, GTM, React), the in-app preview, domain rules, CSP needs, troubleshooting, office hours, OTP |
| [TEAM-CHAT.md](TEAM-CHAT.md) | internal team chat: channels, direct and group messages, threads, privacy rules, notifications, retention, limits |
| [SECURITY.md](SECURITY.md) | data handled, threat model, secrets, privacy, what is not covered |
| [GLOSSARY.md](GLOSSARY.md) | domain terms and legacy term mapping |
| [design/DESIGN.md](design/DESIGN.md) | web design system: tokens, components, shortcuts, responsive rules, and the screenshot set (`design/*.jpg`) |
| [PROVENANCE.md](PROVENANCE.md) | which legacy UI ideas the web redesign adapted, and what was deliberately not carried over |
| [adr/README.md](adr/README.md) | architecture decision records |
| [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md) | the hosted chat at `/chat` for web views and iframes: URL parameters, origin and CSP model, identity verification with snippets, bridge protocol v1 (commands, events, transports), sequence diagrams, conformance page, troubleshooting |
| [bridge/](bridge/envelope.schema.json) | JSON Schemas of the bridge envelope, commands and events (hand-written, tied to the shipped bridge by contract tests) |
| [MOBILE-API.md](MOBILE-API.md) | using the public REST and Socket.IO API from a native app: tokens and origin, the flow in curl, TypeScript, Swift and Kotlin, reconnect and background rules, rate limits and error codes, security do and do not, push notification design note |
| [openapi-public.json](openapi-public.json) | OpenAPI 3.1 of the public visitor API only (generated, staleness checked by `docs:check`) |
| [MOBILE-SDKS.md](MOBILE-SDKS.md) | the iOS package, Android library, React Native and Flutter guides, and exactly what was built, tested or only scaffolded |
