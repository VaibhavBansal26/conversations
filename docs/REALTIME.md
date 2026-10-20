# Realtime protocol (Socket.IO)

One Socket.IO namespace per workspace: `/ws/<workspaceId>` (workspace ids are validated before anything else happens). Transports: `polling,websocket` by default (`WS_TRANSPORTS`). The widget and the agent app use the same server; what a connection may do depends on who it is.

## Connecting

```js
import { io } from "socket.io-client";
// team member
const s = io("https://HOST/ws/ws_xxxxxxxxxxxxxxxxxxxxxxxx", { auth: { token: ACCESS_TOKEN } });
// widget visitor
const v = io("https://HOST/ws/ws_xxxxxxxxxxxxxxxxxxxxxxxx", { auth: { session: SESSION_SECRET, deviceId: DEVICE_ID } });
```

* A **team** socket authenticates with the access token (the seat, role and workspace suspension are re-read on every event, so a demotion, removal or suspension takes effect immediately; when the token itself expires the server emits `auth:expired` and the client renews and reconnects).
* A **visitor** socket authenticates with its session secret and device id (same-device-or-same-IP rule); the embed token's domain is checked against `Origin`.
* A socket opened with a read-only **support token** receives updates but every event it emits is refused (`IMPERSONATION_READ_ONLY`).
* Admission control: connections can be refused with a connect error carrying `data.code` (`OVERLOADED` with a jittered retry hint, `RATE_LIMITED`, `UNKNOWN_WORKSPACE`, `UNAUTHORIZED`, `WORKSPACE_SUSPENDED`, connection caps). Clients must back off with jitter (the widget does).

## Who receives what (computed audiences)

Sockets do **not** join one channel per room. The server computes the audience of each event from visibility rules and publishes to a small fixed set of channels per workspace (`managers`, `inbox:<id>`, `member:<id>`, plus the visitor of the room), so an agent with thousands of conversations holds a handful of subscriptions, not thousands ([ADR 0005](adr/0005-computed-room-audiences.md)). Notes never reach visitors. Per room, events are emitted in order.

## Client to server

Every event is acknowledged: `{ok: true, ...}` or `{ok: false, error: {code, message}}`. The access rule is the same table that guards REST (`EVENT_ACCESS`); `Cost` weights the per-socket event budget (`SOCKET_RATE_PER_SEC`, `SOCKET_RATE_BURST`): a `typing` ping costs a quarter of a `message:send`. A socket that keeps exceeding its budget is disconnected after `WS_STRIKE_LIMIT` strikes. The table is generated from the registry (`npm run docs:realtime`) and checked by `docs:check`.

<!-- BEGIN:client-events -->
| Event | Who | Needs | Cost | Payload (`*` = required) |
| --- | --- | --- | --- | --- |
| `message:send` | team, visitor | `conversations:reply` | 2 | `kind`, `source`, `content`, `format`, `subject`, `from`, `ref_message_id`, `attachment_ids`, `client_msg_id`, `room_id*` |
| `message:read` | team, visitor | `conversations:read` | 1 | `message_id*`, `room_id*` |
| `room:create` | team, visitor | `conversations:reply` | 5 | `contact_id`, `contact`, `inbox_id`, `subject` |
| `room:update` | team | `conversations:reply` | 2 | `status`, `priority`, `subject`, `snooze_until`, `room_id*` |
| `room:assign` | team | `conversations:reply` | 2 | `member_ids`, `inbox_id`, `auto`, `room_id*` |
| `typing` | team, visitor | `conversations:reply` | 0.25 | `room_id*`, `typing*`, `internal` |
| `otp:verify` | visitor | visitor session | 5 | `code*` |
| `presence:list` | team | `members:read` | 1 | none |
<!-- END:client-events -->

`message:send` is idempotent on `client_msg_id`; the ack carries the stored message and whether it was newly created.

## Server to client

| Event | To | Payload | Meaning |
| --- | --- | --- | --- |
| `message:new` | room audience (visitor gets a trimmed copy) | `{message, room}` | a message was stored |
| `message:updated` | same | `{message, room}` | edit, delivery status change, payment card status, AI annotation |
| `message:deleted` | same | `{message_id, room_id}` | soft delete |
| `message:receipt` | same | `{room_id, reader, up_to_seq, up_to_message_id, at}` | read receipt (agent read, visitor read, email open) |
| `room:new` | members who can now see it | `{room}` | conversation created or became visible |
| `room:updated` | room audience | `{room, reason?}` | status, assignment, snooze, priority, subject, unread |
| `room:deleted` | members who lost it | `{room_id}` | archived or no longer visible |
| `room:unread` | the member | `{room_id, unread_count}` | unread count changed |
| `typing` | room audience | `{room_id, typing, who}` | typing indicator (coalesced) |
| `presence:update` | workspace | `{member_id, online}` | team presence |
| `visitor:presence` | room audience | `{room_id, contact_id, online}` | visitor presence |
| `member:updated`, `member:removed` | workspace | member record / `{member_id}` | team changes |
| `inbox:new`, `inbox:updated` | workspace | inbox record | inbox changes |
| `contact:updated` | workspace | contact record | contact edit |
| `notification:new`, `notification:read` | the member | `{notification, unread_count}` / `{id, unread_count}` | in-app notifications (including billing and payment alerts) |
| `session:verified` | visitor | `{verified}` | OTP verification succeeded |
| `rate:limited` | the socket | `{reason: "too_many_violations", retry_after_ms}` | the socket exceeded its event budget repeatedly and is being disconnected |
| `server:draining` | every socket of the node | `{reconnect_in_ms}` | the node is shutting down: reconnect after the staggered delay |
| `server:resync` | every socket of the node | `{}` | the node lost and regained Redis (or missed events): refetch state over REST |
| `server:overflow` | the socket | `{}` | the socket was too slow and is being disconnected |
| `auth:expired` | the socket or workspace | `{}` | the token ended, or the workspace was suspended: renew or sign in again |

Delivery is at-most-once over the socket by design; correctness comes from REST: clients refetch on `server:resync` and after reconnecting, and message ids/sequence numbers (`seq`, contiguous per room) let them detect gaps ([ADR 0011](adr/0011-resync-over-rest.md)). Load tests count gaps, duplicates and reordering ([PERFORMANCE.md](PERFORMANCE.md)).
