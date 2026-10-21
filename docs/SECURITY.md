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
| Widget abuse from other sites | embed token bound to a domain and checked against `Origin`; visitor session secret plus device/IP binding; OTP verification for sensitive flows | `visitors.test.ts` |
| Prompt injection through messages | conversation text is wrapped in delimited untrusted blocks (and any delimiter inside is stripped); AI output is treated as text, never executed; offline fallback | [AI.md](AI.md) |
| Spoofed client IP | `TRUST_PROXY` off by default; the client address is the entry `TRUSTED_PROXY_HOPS` from the right of `X-Forwarded-For`; Cloudflare's header believed only with the shared secret | [CLOUDFLARE.md](CLOUDFLARE.md) |
| Denial of service | admission control and load shedding, per-socket event budgets, slow-consumer eviction, body and upload limits, per-tenant queues | [SCALING.md](SCALING.md), `ratelimit.*.test.ts` |
| Lost or altered history | database triggers make the audit log append-only; outbox gives at-least-once with idempotent consumers; messages are soft-deleted | [ARCHITECTURE.md](ARCHITECTURE.md) |

## Secrets

* `JWT_SECRET` is required in production (the server refuses to start without it) and must be identical on every node. Provider keys (`TWILIO_*`, `SENDGRID_*`, `STRIPE_*`, `ANTHROPIC_API_KEY`), `DATABASE_URL`, `REDIS_URL` and `METRICS_TOKEN` come from your secret store; every secret variable is marked in [CONFIGURATION.md](CONFIGURATION.md). Nothing in the repository contains a real key, and the test suite uses fake providers.
* `DATA_ENCRYPTION_KEY` (32 random bytes) is required in production once analytics is used; it is separate from `JWT_SECRET` so rotating the signing secret cannot make the identity pepper unreadable. Without it the pepper routes and exports answer `503 DATA_ENCRYPTION_KEY_REQUIRED`.
* Workspaces' own Twilio / SendGrid credentials (`channel_connections`) are encrypted with `DATA_ENCRYPTION_KEY` (AES-256-GCM, bound to the workspace and channel), shown only as the last four characters, redacted from provider error text and re-sealed under the current key when read under `DATA_ENCRYPTION_KEY_PREVIOUS`. Inbound provider webhooks are verified with the *workspace's* credentials, so one tenant's secret cannot authenticate traffic for another ([CHANNELS.md](CHANNELS.md), [ADR 0019](adr/0019-per-workspace-channel-connections.md)). Not verified against the real providers.
* Rotation: see "Secret rotation" in [RUNBOOK.md](RUNBOOK.md).
* Logs are JSON lines with request ids; secrets, tokens, message content and raw rate-limit keys are never logged (limiter logs carry policy ids and hashed key prefixes).

## Privacy and retention

* Per-workspace retention (`retention_days`) archives messages to NDJSON.gz and removes them; deleting a contact removes their conversations and messages (partition-key scoped purge); backups follow your database's own retention.
* Exports for analytics are pseudonymous by construction. The pepper that links them is a per-workspace secret controlled by the workspace.
* Billing data is limited to Stripe ids and the card's brand and last four digits.

## Not covered

No external penetration test has been performed. No SSO/SAML for team members or operators. No per-field encryption of message bodies at rest (use database/disk encryption). Malware scanning of attachments is not implemented (files are served sandboxed and as downloads unless an image, PDF or audio type). Stripe flows have not been run against Stripe itself in this environment ([STRIPE.md](STRIPE.md)).
