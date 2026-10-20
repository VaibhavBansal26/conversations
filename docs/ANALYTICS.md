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
| `GET /export/messages-meta` | `analytics:export` | NDJSON, one message per line, **no content** |
| `GET /identity-pepper` | `analytics:export` | the workspace's identity pepper (also needs `analytics_identity:manage` for the in-app view) |

Query parameters: `from`, `to` (ISO date or datetime, default the last 30 days, at most 366 days: `RANGE_TOO_LARGE`), `tz` (IANA, bucketing only), `interval` (`hour|day|week|month`). Exports take `limit` (1 to 5,000) and `cursor`, are **keyset paginated** on a stable `(ts, id)` order (no OFFSET), return `X-Next-Cursor`, and can be gzipped. Errors are `{"error": {"code", "message"}}` and match `error.schema.json`. Full request/response reference: [API.md](API.md).

```bash
curl -s -H "Authorization: Bearer $KEY" "http://localhost:3000/api/v1/analytics/overview?from=2026-03-01&to=2026-03-31&tz=Europe/Berlin"
curl -s -H "Authorization: Bearer $KEY" "http://localhost:3000/api/v1/analytics/export/rooms?limit=1000" -D - -o rooms.ndjson   # follow X-Next-Cursor
```

## API keys

Created in the app or with `POST /api/v1/api-keys` (permission `api_keys:manage`): a name, scopes (`analytics:read`, `analytics:export`, `analytics_identity:manage`), an optional expiry, and an optional **CIDR allow-list**. The plaintext (`ca_live_<random>`) appears **once**, in the creation response; only its SHA-256 is stored. A key cannot carry a scope its creator's role does not hold (`PRIVILEGE_ESCALATION`). Every authentication failure (unknown, revoked, expired, wrong IP) is the same `401`, so nothing reveals which. Last-used time is recorded, keys are revocable, creation and revocation are audited.

Limits (per key, plus a per-workspace ceiling that follows the plan): reads 60 per minute, exports 10 per minute and at most 2 concurrent exports per key; `429` with `Retry-After`. See [RATE-LIMITING.md](RATE-LIMITING.md).

## Privacy: no raw PII in exports

Exports never contain email, phone, names or message text. A person is `contact_key = hex(HMAC-SHA256(pepper, lower(trim(email))))`, the phone `phone_key` the same way over the E.164 number, and `agent_key` a keyed hash of the member id (never the id or the name). The **pepper** is a per-workspace secret: the workspace admin (`analytics_identity:manage`) can read it and give it to the intelligence service, so two products owned by the same customer derive the *same* key and can be joined; rotating it (`POST /api/analytics/identity-pepper/rotate`) changes every key (version number returned) and is audited. The algorithm is exactly the contract's and is covered by a test that recomputes it independently.

## Schemas and contract tests

`npm run docs:analytics-schemas` (in `server/`) writes the JSON Schemas (draft 2020-12) to `docs/analytics-api/`; `docs:check` fails when they are stale. Within v1 fields are only **added**; consumers must ignore unknown ones, so `additionalProperties` stays true. `server/tests/analytics.test.ts` validates real responses and every NDJSON line against the schemas with Ajv, and tests metric definitions (business hours, snooze exclusion, reopen), cross-workspace isolation, key scopes/expiry/CIDR, pagination and resumability, PII absence, and the pepper algorithm.

## Not done

No push webhook (`analytics.daily_rollup_ready`) from the contract's optional section; no per-contact timeline export; percentiles on SQLite use a count plus an offset per percentile (fine for the default single-node size; PostgreSQL uses `percentile_disc`).
