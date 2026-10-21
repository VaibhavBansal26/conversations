# 0019. Per-workspace provider connections

Status: accepted (2026-10-21).

## Context

Twilio and SendGrid credentials were deployment-wide environment variables (`TWILIO_*`, `SENDGRID_*`). In a multi-tenant product every workspace would send and receive through the operator's account, and the operator would pay for and answer for everybody's messages. Workspace admins had no way to connect their own accounts.

## Decision

- A workspace stores its own credentials (`channel_connections`, one row per channel). They are encrypted with `DATA_ENCRYPTION_KEY`, bound to the row by additional authenticated data, never returned (masked to the last four characters) and never logged.
- A `ProviderRegistry` resolves the provider per workspace: its own connection, else the platform default from the environment (self-hosters keep working), else the console provider (test mode, [ADR 0018](0018-test-mode-delivery.md)). A workspace that has a connection never falls back: unverified, rejected or undecryptable connections fail every send with an explanatory message. Rows are cached per node with cluster-wide invalidation; decrypted clients live only in process memory.
- Inbound webhooks get one URL per connection (`/webhooks/c/<id>/...`). The id routes to the connection and the request is verified with **that** connection's credentials: Twilio's signature with the workspace's own Auth Token, SendGrid Event Webhook with the workspace's ECDSA key, Inbound Parse (unsignable) with a per-connection secret. Even a valid request can only touch the workspace's own numbers, addresses and messages. The platform-wide `/webhooks/twilio/*` and `/webhooks/sendgrid/*` endpoints remain for the environment default.
- Provider failures are normalised (`ProviderError.code` plus a one-sentence hint) so the UI can say what to do; a provider 401 on a live send disables the connection until it is verified again.
- Numbers are only accepted when Twilio lists them for the connected account, so typing a number cannot claim someone else's.

## Alternatives considered

- **OAuth / Twilio Connect and SendGrid partner programmes.** Better UX and revocable grants, but each needs the platform to be registered as a partner with the vendor; pasted credentials work today and can be replaced by OAuth later behind the same registry.
- **Subaccounts under one platform Twilio account.** Isolation by subaccount, but the platform still pays and carries compliance for every tenant.
- **Keep environment variables only.** Fine for one company; wrong for a multi-tenant product.

## Consequences

- The operator must set `DATA_ENCRYPTION_KEY` to let workspaces connect accounts; losing it makes stored credentials unreadable (workspaces paste them again).
- Nothing in the automated suite reaches Twilio or SendGrid; real-provider behaviour is covered only by documentation review and `npm run smoke:channels` ([CHANNELS.md](../CHANNELS.md)).
- System email (invitations, resets, digests) remains a platform concern.
