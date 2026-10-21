# Analytics

Two surfaces share one set of definitions:

* the **dashboard** in the agent app (`/analytics`, permission `analytics:read`): KPI tiles, time series and breakdowns drawn with accessible SVG charts (no chart library);
* the **analytics API** (`/api/v1/analytics/*`), authenticated with workspace API keys, consumed by the separate Python intelligence service. The contract is `analysis/ANALYTICS-CONTRACT.md` of the build; this repo ships JSON Schemas for it in [`docs/analytics-api/`](analytics-api/schema-version.json) and contract tests that validate real responses against them.

## Per-room facts: `room_metrics`

Everything is computed from one table with one row per conversation, maintained **in the same transaction** that changes the room (message insert, close, reopen, snooze, assign, CSAT, AI triage). It is therefore always consistent with the room and never needs a backfill job; the migration seeds it from existing rooms. Dashboard and API read it, not the 50M-row messages table.

Definitions (`server/src/services/roomMetrics.ts`):

| Metric | Definition |
| --- | --- |
| messages in / out | messages exchanged with the contact. Internal notes and system lines are **not** counted; bot messages count as outbound |
| first response | from the first contact message to the first message by a **human agent** (bots, notes and system lines never count) |
| resolution | from the start of the open interval (creation, or the latest reopen) to the close, **minus time spent snoozed** |
| business time | both times are **business seconds** when the workspace has office hours enabled, calendar seconds otherwise (`businessSeconds` in `office.ts`) |
| reopen / snooze counts | incremented when a closed room gets a new message or reopens, and per snooze |
| CSAT | 1 to 5 score the visitor gives once after the team closes the conversation (widget prompt, `POST /public/rooms/:id/csat`, one answer per closure) |
| percentiles | p50 / p90 over rooms in range, nearest-rank: `percentile_disc` on PostgreSQL, a count and an offset on SQLite |

## API

Base `/api/v1/analytics`, `Authorization: Bearer ca_live_...`. Every response is scoped to the key's workspace (another workspace's data is a 404 / absent, never a 403 that confirms it exists).

| Endpoint | Scope | Returns |
| --- | --- | --- |
| `GET /overview` | `analytics:read` | counts, first-response and resolution p50/p90, CSAT, by channel, by inbox, by agent (opaque `agent_key`, no names) |
| `GET /timeseries?metric=` | `analytics:read` | zero-filled points for `rooms_opened`, `messages_in`, `messages_out`, `first_response_p50`, `resolution_p50`, `backlog` |
| `GET /schema` | `analytics:read` | the JSON Schemas and `schema_version` |
| `GET /export/rooms` | `analytics:export` | NDJSON, one room per line |
| `GET /export/messages-meta` | `analytics:export` | NDJSON, one message per line, **no content**; each line also carries `ticket_id` (additive, null before tickets existed) |
| `GET /support` | `analytics:read` | tickets, AI agents, departments and calls (below) |
| `GET /export/tickets` | `analytics:export` | NDJSON, one ticket per line (below) |
| `GET /export/calls` | `analytics:export` | NDJSON, one call per line (below) |
| `GET /identity-pepper` | session with `analytics_identity:manage` + `analytics:export`, **or** an API key with the scopes `analytics:export` + `analytics_identity:manage` | `{pepper, version, algorithm: "HMAC-SHA256", fingerprint, rotatedAt}` |
| `PUT /identity-pepper` | session with `analytics_identity:manage` + `analytics:export` (never an API key) | import a pepper chosen elsewhere; same response; see [Sharing the pepper between apps](#sharing-the-pepper-between-apps) |
| `POST /identity-pepper/rotate` | session, as `PUT` | replace it with a new random one; same response |

Query parameters: `from`, `to` (ISO date or datetime, default the last 30 days, at most 366 days: `RANGE_TOO_LARGE`), `tz` (IANA, bucketing only), `interval` (`hour|day|week|month`). Exports take `limit` (default 1,000, **at most 5,000**, above that is `400 VALIDATION_ERROR`; the contract's 1,000 is the minimum every app must accept) and `cursor`, are **keyset paginated** on a stable `(ts, id)` order (no OFFSET), return `X-Next-Cursor`, and can be gzipped. Errors are `{"error": {"code", "message"}}` and match `error.schema.json`. Full request/response reference: [API.md](API.md).

```bash
curl -s -H "Authorization: Bearer $KEY" "http://localhost:3000/api/v1/analytics/overview?from=2026-03-01&to=2026-03-31&tz=Europe/Berlin"
curl -s -H "Authorization: Bearer $KEY" "http://localhost:3000/api/v1/analytics/export/rooms?limit=1000" -D - -o rooms.ndjson   # follow X-Next-Cursor
```

## Support analytics: tickets, AI agents, departments, calls

Additive within API v1 (new endpoints and one new optional field; `schema_version` stays 1, consumers ignore what they do not know). The dashboard shows the same numbers under Analytics > Support (`GET /api/analytics/support`, `analytics:read`).

`GET /api/v1/analytics/support?from&to` returns:

| Field | Meaning |
| --- | --- |
| `tickets.opened`, `resolved`, `by_resolution` | tickets opened in the range; tickets resolved in it; opened tickets by how they ended (`bot_resolved`, `human_resolved`, `abandoned`, `auto_closed`, `merged`) |
| `tickets.containment_rate` | of the tickets an AI agent worked on (it has at least one turn), the share it resolved without a person; `null` when none |
| `tickets.handoff_rate`, `handoff_reasons` | share of opened tickets handed to a person, and the reasons with counts (`customer_requested_human`, `no_answer`, `sensitive_topic`, ...) |
| `tickets.wait_for_human_p50_s` | median seconds from the hand-off to the first reply of a person (nearest rank, over up to 5000 tickets) |
| `tickets.sla_first_response_breaches`, `sla_resolution_breaches` | tickets of the range that breached their department's service levels |
| `tickets.csat` | average rating and count, for AI-resolved and for person-resolved tickets |
| `tickets.queue_length_now` | tickets waiting for a person right now (not range-bound) |
| `by_department` | per department: tickets, hand-offs, resolved, average rating, tickets with a breach |
| `ai_agents` | per AI agent (`agent_key`, a keyed hash): turns and their outcomes, helpful and not-helpful votes of visitors and team |
| `calls` | totals, answered (ended), missed, declined, failed, total and average duration of answered calls, by transport (`webrtc`, `phone`) and kind |

`GET /export/tickets` lines: `id, number, room_id, created_at, closed_at, status, handler_type (bot|human|null), handler_key, department_id, priority, resolution, handoff_reason, channel, contact_key, first_response_s, wait_for_human_s, resolution_s, csat, sla_first_response_breached, sla_resolution_breached, bot_turns, calls, hour_of_day_created, dow_created`. **Never** the subject, the summary, notes, message text, names, emails or phone numbers: a person is `contact_key` (the same pepper hash as the room export, so records join), a seat or an AI agent is `handler_key` (keyed hash). `GET /export/calls` lines: `id, room_id, ticket_id, ts, transport, kind, state, duration_s, ended_by, end_reason, agent_key`; no phone numbers (a call row keeps the last four digits internally, the export has none). Both exports are keyset paged by `(created_at, id)`, resumable with `X-Next-Cursor`, gzip-able, limited to 5000 lines a page and two concurrent exports per key like the others.

## API keys

Created in the app or with `POST /api/v1/api-keys` (permission `api_keys:manage`): a name, scopes (`analytics:read`, `analytics:export`, `analytics_identity:manage`), an optional expiry, and an optional **CIDR allow-list**. The plaintext (`ca_live_<random>`) appears **once**, in the creation response; only its SHA-256 is stored. A key cannot carry a scope its creator's role does not hold (`PRIVILEGE_ESCALATION`). Every authentication failure (unknown, revoked, expired, wrong IP) is the same `401`, so nothing reveals which. Last-used time is recorded, keys are revocable, creation and revocation are audited.

Limits (per key, plus a per-workspace ceiling that follows the plan): reads 60 per minute, exports 10 per minute (all export routes of a key share them) and at most 2 concurrent exports per key; the workspace ceiling (120 per minute on the free plan) is shared by every key; `429` with `Retry-After` (seconds until one more request is allowed) and `RateLimit` `t` (seconds until the quota is full again). See [RATE-LIMITING.md](RATE-LIMITING.md#analytics-api-reading-the-limits).

## Privacy: no raw PII in exports

Exports never contain email, phone, names or message text. A person is `contact_key = hex(HMAC-SHA256(pepper, lower(trim(email))))`, the phone `phone_key` the same way over the E.164 number (an **extra** field that the contract only mentions in prose; `null` without a phone number), and `agent_key` a keyed hash of the member id (never the id or the name). The **pepper** is a per-workspace secret: the workspace admin (`analytics_identity:manage`) can read, set and rotate it, so two products owned by the same customer derive the *same* key and can be joined. The algorithm is exactly the contract's and is covered by a test that recomputes it independently.

Time fields in room exports: `hour_of_day_created` and `dow_created` are computed in the request's `tz` (UTC by default). **`dow_created` follows JavaScript's `getDay()`: Sunday = 0, Monday = 1, ... Saturday = 6.** (Consumers that count Monday as 0 must convert.)

## Sharing the pepper between apps

Each workspace starts with its own random pepper, so two apps of one customer produce different keys for the same e-mail address until both use the same value. To join them:

1. Pick one value: `openssl rand -hex 32` (or copy the pepper of the other app with `GET /api/v1/analytics/identity-pepper`).
2. Set it here: `curl -X PUT -H "Authorization: Bearer $SESSION_TOKEN" -H "Content-Type: application/json" -d '{"pepper":"<value>","confirm":"<value>"}' .../api/v1/analytics/identity-pepper`. `confirm` is optional; when sent it must repeat the pepper exactly (`400 PEPPER_CONFIRM_MISMATCH`).
3. Compare the `fingerprint` in both apps (first 8 hex characters of SHA-256 over the pepper): equal fingerprints mean equal peppers, and the fingerprint reveals nothing usable.

Rules (`INVALID_PEPPER` otherwise): 32 to 256 printable ASCII characters without spaces; a hex pepper needs 64 characters and a base64 pepper 43 (32 bytes); at least 12 distinct characters, about 128 bits of entropy by a Shannon estimate, and no repeated pattern or sequence. The value is used exactly as typed (nothing is trimmed), so both apps must receive the same string. Setting the value that is already stored changes nothing; a different value adds 1 to `version`, sets `rotatedAt` and writes an `analytics.pepper_set` audit entry holding the fingerprint (never the pepper). Rotate writes `analytics.pepper_rotated`. After a change every `contact_key` in later exports differs, so consumers must re-key (the intelligence service does it from the pepper it is given).

An API key with both scopes can **read** the pepper, which lets a leaked integration key recompute contact keys from e-mail addresses: give the scope only to the service that needs it. Changing the pepper needs a person's session.

The settings page does not yet have a form for this; the API above is the supported way (UI follow-up).

### How it is stored

`analytics_pepper.pepper_enc` holds `enc2.<keyId>.<ciphertext>`: AES-256-GCM under a key derived from `DATA_ENCRYPTION_KEY` (32 random bytes, 64 hex characters or base64), bound to the workspace id. It is independent of `JWT_SECRET`, so rotating the signing secret no longer breaks the pepper endpoint and the exports (it used to: `500` with `Unsupported state or unable to authenticate data`).

* Production: `DATA_ENCRYPTION_KEY` is required once analytics is used; without it the pepper routes, the exports and `overview` answer `503 DATA_ENCRYPTION_KEY_REQUIRED`. Development and tests derive a key from `JWT_SECRET` and warn at start-up.
* Existing rows (encrypted under `JWT_SECRET` by earlier versions) are read with the old key and **re-encrypted under the new key on their first read**; the value, `version` and `rotatedAt` do not change. Keep `JWT_SECRET` unchanged until each workspace has been read once.
* Rotating the data key: put the old value in `DATA_ENCRYPTION_KEY_PREVIOUS`; rows are re-encrypted on read ([RUNBOOK.md](RUNBOOK.md#rotating-secrets)).
* A pepper that cannot be decrypted (key lost or changed without the previous key) is `409 PEPPER_UNREADABLE` with an explanation, never a `500`; `PUT` (or `POST .../rotate`) replaces it and recovers.

Old session-only paths `GET|PUT /api/analytics/identity-pepper` and `POST /api/analytics/identity-pepper/rotate` remain as aliases with the same behaviour.

## Schemas and contract tests

`npm run docs:analytics-schemas` (in `server/`) writes the JSON Schemas (draft 2020-12) to `docs/analytics-api/`; `docs:check` fails when they are stale. Within v1 fields are only **added**; consumers must ignore unknown ones, so `additionalProperties` stays true. `server/tests/analytics.test.ts` validates real responses and every NDJSON line against the schemas with Ajv, and tests metric definitions (business hours, snooze exclusion, reopen), cross-workspace isolation, key scopes/expiry/CIDR, pagination and resumability, PII absence, and the pepper algorithm. `server/tests/pepper.test.ts` covers importing, validation, fingerprints, key scopes on the pepper routes, the data key, migration from `JWT_SECRET` and recovery.

## Not done

No push webhook (`analytics.daily_rollup_ready`) from the contract's optional section; no per-contact timeline export; percentiles on SQLite use a count plus an offset per percentile (fine for the default single-node size; PostgreSQL uses `percentile_disc`).
