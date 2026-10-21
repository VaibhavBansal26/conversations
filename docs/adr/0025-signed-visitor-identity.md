# 0025. Signed visitor identity (HMAC over external id and email)

Status: accepted (2026-10-21).

## Context

The widget identifies a visitor by what they type. A known contact on a new device must pass a one-time code ([WIDGET.md](../WIDGET.md)), which is right for anonymous websites and wrong for an app where the user is already signed in: every new phone asks for a code, and an app cannot prove who its user is. The reverse risk: if an app passes `email` as a plain URL parameter, any user of the app could pass another user's email.

## Decision

- Per workspace, an optional secret `cvi_...` (table `workspace_identity`, encrypted with `DATA_ENCRYPTION_KEY` via `util/dataCrypto.ts`, shown once, rotation replaces it, audited). The host backend signs `identity_hash = hex(HMAC_SHA256(secret, external_id|lower(email)))`; the server recomputes and compares in constant time.
- A valid hash makes a verified session for exactly one contact, found by `contacts.external_id` first and then by email (which adopts the id); an email owned by another id is `409`. A wrong hash is `401` in every mode, a hash with no secret is `422`, so integration mistakes are loud. Without a hash the behaviour is unchanged, unless **enforcement** is on, when typed email, phone and external id are ignored and the visitor stays anonymous.
- `contacts.external_id` is a column with a unique partial index per workspace, not a JSON attribute, so lookup is indexed, race-safe and identical on SQLite and PostgreSQL.
- Phone is not signed: under a verified identity it is ignored.

## Alternatives considered

- **JWT signed by the host** (Intercom style): more flexible claims, but a JWT library on both sides and expiry handling for a value we compare once at session creation. The HMAC is one line in every language and has fixed test vectors.
- **Public-key signatures:** the host would keep a private key and we a public one, so a database leak would not reveal the signing secret. Worth it at larger scale; the secret is encrypted at rest and the HMAC is far easier to adopt. Revisit if a customer asks.
- **Trust unsigned external ids:** exactly the impersonation this is meant to prevent.

## Consequences

- The secret lives on the customer's server; an app that embeds it defeats the feature, and the docs say so in every language snippet.
- Losing `DATA_ENCRYPTION_KEY` makes the secret unreadable; the workspace is then treated as having none (never "accept anything") and a manager creates a new one.
- Enforcement can lock out integrations that never signed; it is off by default.
