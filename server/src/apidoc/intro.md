# REST API

Base URL: `http://localhost:3000` in development (`PUBLIC_URL` in production). JSON in, JSON out, UTC ISO-8601 timestamps, opaque string ids. Machine-readable spec: [openapi.json](openapi.json) (OpenAPI 3.1, generated). Socket.IO protocol: [REALTIME.md](REALTIME.md). Platform operator API (`/admin/api`): [ADMIN.md](ADMIN.md). Analytics API (`/api/v1/analytics`, API keys): [ANALYTICS.md](ANALYTICS.md).

This page is generated from the code (`npm run docs:api` in `server/`); `docs:check` fails when it is stale or when a route has no entry. The examples below are exercised by `server/tests/docs.examples.test.ts`.

## Authentication

| Surface | Credential | How to get it |
| --- | --- | --- |
| Team API `/api/*` | `Authorization: Bearer <access token>` (15 minutes) | `POST /api/auth/login` or `/register`; renew with `POST /api/auth/refresh` (single-use refresh token, rotated) |
| Analytics API `/api/v1/analytics/*` | `Authorization: Bearer ca_live_...` | `POST /api/v1/api-keys` (permission `api_keys:manage`) |
| Widget `/public/*` | `x-api-key: cvt_...` embed token (bound to a domain) plus `x-support-session` after `POST /public/sessions` | Settings > Embed tokens |
| Webhooks `/webhooks/*` | provider signature (Twilio, SendGrid, Stripe) | configured in the provider |
| Platform console `/admin/api/*` | operator token (30 minutes, mandatory TOTP) | `POST /admin/api/login` then `/mfa/verify` |

What each route requires (a permission, "signed in", "public", "API key", "operator") is in the *Access* column of the reference; permissions are explained in [RBAC.md](RBAC.md). A route without a rule is refused (`403 NO_POLICY`).

```bash
BASE=http://localhost:3000

# 1. create a workspace (returns a session)
curl -s $BASE/api/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","password":"correct horse battery","workspace_name":"Acme"}'
# => {"token":"eyJ...","refresh_token":"...","expires_in":900,"user":{...},"member":{...},"workspace":{...}}

TOKEN=eyJ...   # the "token" above

# 2. create a contact and a conversation
curl -s $BASE/api/contacts -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Casey","email":"casey@example.test"}'
curl -s $BASE/api/rooms -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"contact_id":"<contact id>"}'
# => {"room":{"id":"...",...},"created":true}

# 3. send a chat message; the same client_msg_id sent twice stores ONE message
curl -s $BASE/api/rooms/<room id>/messages -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"text","source":"dm","content":"Hi Casey","client_msg_id":"7d1c5f4e-1111-4a6b-9c0e-000000000001"}'

# 4. read the history (keyset cursor, newest page first)
curl -s "$BASE/api/rooms/<room id>/messages?limit=30" -H "authorization: Bearer $TOKEN"
```

## Errors

Every error is `{"error": {"code": "...", "message": "...", "details"?: ...}}` with a matching HTTP status. `code` is stable and meant for programs; `message` is for people.

| Status | Typical codes |
| --- | --- |
| 400 | `VALIDATION_ERROR` (with `details: [{path, message}]`), `INVALID_JSON`, `INVALID_CURSOR` |
| 401 | `UNAUTHORIZED`, `INVALID_TOKEN`, `SESSION_REVOKED`, `INVALID_CREDENTIALS`, `WEBHOOK_SIGNATURE` |
| 402 | `INSUFFICIENT_CREDITS`, `ACCOUNT_LOCKED`, `SEAT_LIMIT` |
| 403 | `PERMISSION_DENIED` (with `details.permission`), `PRIVILEGE_ESCALATION`, `WORKSPACE_SUSPENDED`, `IMPERSONATION_READ_ONLY`, `NO_POLICY` |
| 404 | `NOT_FOUND` (also for another workspace's ids: existence is never confirmed across tenants) |
| 409 | `CONFLICT`-class codes such as `ALREADY_SUBSCRIBED`, `ROLE_IN_USE`, `NOT_OPEN` |
| 413 | `BODY_TOO_LARGE`, `FILE_TOO_LARGE` |
| 421 | `WRONG_REGION` (the workspace lives in another region; `details.region` says which) |
| 422 | semantic failures: `EMPTY_MESSAGE`, `CONTACT_PHONE_REQUIRED`, `SMS_TOO_LONG`, `INVALID_CODE` |
| 429 | `RATE_LIMITED` |
| 503 | `BILLING_NOT_CONFIGURED`, overload shedding, fail-closed limiter with the store down |
| 504 | `REQUEST_TIMEOUT` |

## Pagination

Lists use **keyset cursors**, never offsets: `?limit=<n>&cursor=<opaque>` returns `{data: [...], next_cursor | pagination: {...}}` and the next page is requested with the returned cursor. Message history uses `before` / `after` message ids. Cursors are opaque and stable under concurrent inserts. Exports (`/api/v1/analytics/export/*`) return NDJSON and an `X-Next-Cursor` header.

## Idempotency

Sending a message with the same `client_msg_id` in the same room is applied once; a repeat returns the stored message (`created: false`) even when two requests race. Webhooks are idempotent on provider ids (Stripe event ids, Twilio `MessageSid`). Platform credit adjustments accept an `Idempotency-Key` header.

## Rate limits

Every successful response on a limited route carries the standard `RateLimit-Policy` and `RateLimit` headers plus `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` for the tightest limit that applied. A `429` has `Retry-After` (seconds), and the body names the policy:

```json
{"error": {"code": "RATE_LIMITED", "message": "Too many requests", "policy": "api.write", "retry_after_s": 2}}
```

Clients should wait `Retry-After` plus jitter. The policy table (algorithms, limits per plan, fail-open or fail-closed) is [RATE-LIMITING.md](RATE-LIMITING.md); the last column of the reference lists the policies each route passes through.

## Versioning

The team API is unversioned and changes additively; the analytics API is `v1` (fields are only added, consumers ignore unknown fields, `GET /api/v1/analytics/schema` returns `schema_version`). Breaking changes are listed in [CHANGELOG.md](../CHANGELOG.md).
