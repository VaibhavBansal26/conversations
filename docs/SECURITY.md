# Security

Summary of what is protected, how, and what is not. Detail lives in the linked documents. **Reporting a vulnerability:** email the maintainers privately (do not open a public issue) with steps to reproduce; expect an acknowledgement within 3 working days. There is no bug bounty.

## Data handled

| Data | Where | Notes |
| --- | --- | --- |
| Messages, contacts (name, email, phone), notes, attachments | database, `DATA_DIR/uploads` | customer PII; message bodies are sanitised on input and never logged |
| Team accounts | `users`, `members` | scrypt password hashes; TOTP secrets encrypted with a key derived from `JWT_SECRET`; recovery codes stored hashed |
| Analytics identity pepper | `analytics_pepper` | AES-256-GCM under `DATA_ENCRYPTION_KEY` (key id in the ciphertext, bound to the workspace), independent of `JWT_SECRET`; shown only to holders of `analytics_identity:manage` (and keys with that scope), never logged; set, rotate and read are audited (fingerprint only) |
| Sessions | `auth_sessions`, `refresh_tokens` | only hashes of refresh tokens; IP stored as a truncated hash |
| API keys, embed tokens | `api_keys` (SHA-256 only), `tokens` | the plaintext of an API key is shown once |
| Billing | `billing_accounts`, `usage_ledger`, `payment_requests` | Stripe ids, card brand and last four. **No card numbers ever reach this system** (Stripe Checkout) |
| Audit log | `audit_log` | append-only (database triggers); contains ids and reasons, never secrets or message content |
| Analytics exports | derived | never contain raw email, phone, names or text: HMAC keys only ([ANALYTICS.md](ANALYTICS.md)) |

## Threat model (short)

Assets: customer conversations and contact data, workspace credentials, the ability to send SMS and email at the workspace's cost, billing state. Adversaries: an anonymous internet client; a visitor of one workspace's widget; a malicious or compromised team member; a member of another workspace (tenant); a compromised provider webhook source; an operator mistake.

| Threat | Mitigation | Evidence |
| --- | --- | --- |
| Reading another tenant's data | every query is scoped by `workspace_id`; foreign ids answer 404; socket namespaces per workspace; visitor sessions bound to one workspace and device/IP | tenancy tests in `auth.test.ts`, `rooms.test.ts`, `visitors.test.ts`, `analytics.test.ts` |
| Privilege escalation inside a workspace | permissions checked centrally, deny by default (`403 NO_POLICY`), role-by-route matrix test, no granting of permissions you lack, immutable built-in roles | [RBAC.md](RBAC.md), `rbac.test.ts` |
| Account takeover | scrypt, constant-time login for unknown emails, lockouts (account and IP), optional TOTP, single-use rotating refresh tokens with reuse detection that kills the session, session revocation on password change/reset | [RBAC.md](RBAC.md), `accounts.test.ts` |
| Abuse of platform power | operators are separate accounts with mandatory TOTP, 30-minute tokens in memory only, role split, every action audited and visible to the affected workspace; support access is read-only | [ADMIN.md](ADMIN.md), `admin.test.ts` |
| Forged webhooks | Twilio and Stripe signatures (HMAC, constant-time, replay window), SendGrid signature or shared secret; failures feed an IP strike limit | `webhooks.test.ts`, `billing.test.ts` |
| Replayed or duplicated payments | Stripe events journalled by id; ledger idempotency keys; Stripe idempotency keys on charges | [STRIPE.md](STRIPE.md) |
| Spam, enumeration and brute force | layered rate limiter with fail-closed policies on auth, OTP and webhooks, escalating blocks | [RATE-LIMITING.md](RATE-LIMITING.md) |
| Stored XSS via messages | HTML sanitised with an allow-list on input; the web app renders text, not raw HTML; attachments served with `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, signed expiring URLs | `html.test.ts`, `attachments.test.ts` |
| Widget abuse from other sites | embed token bound to a domain and checked against `Origin` (the in-app preview uses a 10-minute signed flag valid for one token from the app's own origin only, [ADR 0020](adr/0020-widget-preview-flag.md)); visitor session secret plus device/IP binding; OTP verification for sensitive flows | `visitors.test.ts` |
| Hosted chat (`/chat`) abused from other sites | off per token by default; accepted only from the app's own origin (or a marked request without `Origin`), never `null` or another site; strict CSP with no inline code; `frame-ancestors` limited to the token's domain; the website allow-list is unchanged ([ADR 0024](adr/0024-hosted-chat-origin-model.md)) | `hosted-chat.test.ts`, `10-hosted-chat.spec.ts` |
| Impersonating a known customer through the chat | optional signed identity: `HMAC_SHA256(secret, external_id\|email)` computed on the customer's server, secret encrypted at rest with `DATA_ENCRYPTION_KEY`, wrong hash is 401, enforcement ignores unsigned identity ([ADR 0025](adr/0025-signed-visitor-identity.md)) | `identity.test.ts` |
| A hostile page or host on the mobile bridge | strict versioned envelope, 16 KiB limit, 30 commands per 10 s, no `eval`, link allow-list (https, mailto, tel), message origin and source checks in iframe mode, no tokens or session ids ever cross the bridge ([ADR 0026](adr/0026-bridge-protocol-v1.md)) | `bridge.contract.test.ts`, bridge conformance page |
| Prompt injection through messages | conversation text is wrapped in delimited untrusted blocks (and any delimiter inside is stripped); AI output is treated as text, never executed; offline fallback | [AI.md](AI.md) |
| An AI agent manipulated by a visitor, or saying what it must not | the agent never sees an injection attempt (rules decide first), untrusted text is delimited, its output is validated with zod, tools are a closed list checked against the agent's allowed actions and audited, answers pass guards (banned claims, ungrounded commitments, links that are not the knowledge-base page's own), and the visitor is always told it is an AI and can ask for a person at any time | [AI-AGENTS.md](AI-AGENTS.md) section 3, [ADR 0029](adr/0029-ai-agent-pipeline.md), `agents.test.ts` |
| A visitor claiming someone else's email or phone to read their history | a form never merges contacts: an address that belongs to another contact is stored as `unverified_email` on the visitor's own contact, the response does not reveal that it exists, and linking stays with the signed identity and the OTP checks | [AI-AGENTS.md](AI-AGENTS.md) section 4, `visitor-info.test.ts` |
| Bots filling the details form | server-side validation of every field, a honeypot that stores nothing and shows no error, and the per-visitor rate limits of the public routes | `visitor-info.test.ts` |
| Eavesdropping on or hijacking a call | signalling goes to the other party's bound socket only (never to the room), only the seat that placed the call and the visitor of that conversation may signal, from the socket the call is bound to; sizes are bounded; TURN credentials are minted per call from a secret that never reaches a browser; nothing is recorded and media does not pass through the server | [CALLS.md](CALLS.md), `calls.test.ts` |
| A call link leaking or being guessed | 128-bit random token plus HMAC, only its hash stored, single use, one device, one conversation, short life (30 min default, 24 h max), revocable, replaced by a newer one; one generic refusal for every failure; the page never caches, frames or sends a referrer, strips the token from the address bar and uses POST bodies; the access log, error reports and audit log are scrubbed; the session it mints can only join that call. A link sent by email or SMS stays in that message | [ADR 0037](adr/0037-call-links.md), `call-links.test.ts` |
| An AI call saying or doing something unsafe, or running up a bill | calls with the AI go through the same pipeline and safety guards as text (browser engine); the optional realtime engine acts only through server-run tools, is watched by a transcript monitor, and has a duration limit, a minute budget, a concurrency cap and a kill switch; the OpenAI key stays on the server (only a short-lived secret per call reaches the browser); no audio is recorded; the camera is never sent for AI calls | [ADR 0033](adr/0033-ai-calls-browser-speech.md), [ADR 0035](adr/0035-optional-realtime-voice-engine.md) |
| An uploaded agent picture carrying data or script | magic-byte check, 1 MB, size limits, no animation, every metadata block removed, served with `nosniff` and a sandboxing CSP, workspace-scoped | [ADR 0034](adr/0034-agent-portraits-and-the-talking-face.md), `agent-avatar.test.ts` |
| Phone calls used to run up a bill or harass someone | the workspace's own Twilio only; consent to be called on that exact number recorded first; opt-outs honoured; empty country allow-list by default; premium-rate numbers blocked; per-agent hourly and per-workspace daily limits that fail closed; quiet hours; dial time limit and sweeps; webhooks signed with the workspace's token and idempotent | [CALLS.md](CALLS.md), `phone-calls.test.ts` |
| Spoofed client IP | `TRUST_PROXY` off by default; the client address is the entry `TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For`; Cloudflare's header believed only with the shared secret | [CLOUDFLARE.md](CLOUDFLARE.md) |
| Denial of service | admission control and load shedding, per-socket event budgets, slow-consumer eviction, body and upload limits, per-tenant queues | [SCALING.md](SCALING.md), `ratelimit.*.test.ts` |
| Lost or altered history | database triggers make the audit log append-only; outbox gives at-least-once with idempotent consumers; messages are soft-deleted | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Secrets

* `JWT_SECRET` is required in production (the server refuses to start without it) and must be identical on every node. Provider keys (`TWILIO_*`, `SENDGRID_*`, `STRIPE_*`, `ANTHROPIC_API_KEY`), `DATABASE_URL`, `REDIS_URL` and `METRICS_TOKEN` come from your secret store; every secret variable is marked in [CONFIGURATION.md](CONFIGURATION.md). Nothing in the repository contains a real key, and the test suite uses fake providers.
* `DATA_ENCRYPTION_KEY` (32 random bytes) is required in production once analytics is used; it is separate from `JWT_SECRET` so rotating the signing secret cannot make the identity pepper unreadable. Without it the pepper routes and exports answer `503 DATA_ENCRYPTION_KEY_REQUIRED`.
* Workspaces' own Twilio / SendGrid credentials (`channel_connections`) are encrypted with `DATA_ENCRYPTION_KEY` (AES-256-GCM, bound to the workspace and channel), shown only as the last four characters, redacted from provider error text and re-sealed under the current key when read under `DATA_ENCRYPTION_KEY_PREVIOUS`. Inbound provider webhooks are verified with the *workspace's* credentials, so one tenant's secret cannot authenticate traffic for another ([CHANNELS.md](CHANNELS.md), [ADR 0019](adr/0019-per-workspace-channel-connections.md)). Not verified against the real providers.
* Error monitoring (Sentry) is off unless `SENTRY_DSN` is set. When on, events are rebuilt from an allow-list so request bodies, headers, cookies, query strings, users, message text, contact data, provider credentials and session or widget tokens cannot be included, and the workspace appears only as a salted hash ([MONITORING.md](MONITORING.md), [ADR 0022](adr/0022-optional-sentry-allow-list-scrubber.md)). The browser DSN is public by design (it can only submit events).
* Rotation: see "Secret rotation" in [RUNBOOK.md](RUNBOOK.md).
* Logs are JSON lines with request ids; secrets, tokens, message content and raw rate-limit keys are never logged (limiter logs carry policy ids and hashed key prefixes).

## Privacy and retention

* Per-workspace retention (`retention_days`) archives messages to NDJSON.gz and removes them; deleting a contact removes their conversations and messages (partition-key scoped purge); backups follow your database's own retention.
* Exports for analytics are pseudonymous by construction. The pepper that links them is a per-workspace secret controlled by the workspace.
* Billing data is limited to Stripe ids and the card's brand and last four digits.

* Visitor details collected by the chat (name, email, phone, custom fields, a consent timestamp and text) are stored on the contact and follow its retention and deletion. They go to a language model only when the workspace does not redact personal data (`ai_redact_pii`), and values are never written to logs or to the audit detail (only field names are).
* AI agent turns record the visitor's words shortened (masked when the workspace redacts personal data) and are deleted with their ticket.

## Not covered

No external penetration test has been performed. No SSO/SAML for team members or operators. No per-field encryption of message bodies at rest (use database/disk encryption). Malware scanning of attachments is not implemented (files are served sandboxed and as downloads unless an image, PDF or audio type). Stripe flows have not been run against Stripe itself in this environment ([STRIPE.md](STRIPE.md)).
