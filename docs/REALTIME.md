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

Sockets do **not** join one channel per room. The server computes the audience of each event from visibility rules and publishes to a small fixed set of channels per workspace (`managers`, `inbox:<id>`, `member:<id>`, plus the visitor of the room), so an agent with thousands of conversations holds a handful of subscriptions, not thousands ([ADR 0005](adr/0005-computed-room-audiences.md)). Notes never reach visitors, and neither do internal system lines: a visitor socket (and `GET /public/rooms/:id/messages`) only gets the system lines on an allow-list by `meta.sub_type` (`create` "Conversation started" and `payment`); assignment, status (close/reopen), snooze, SMS consent and any new kind of system line stay in the team views. The closed state the widget needs for its satisfaction rating is stated instead: the visitor copy of `room:updated` carries `room.closed_marker` (`{id, seq}` or `null`), as do `GET /public/rooms` and the `room` field of the visitor message page. Per room, events are emitted in order.

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
| `call:invite` | team | `calls:make` | 5 | `room_id*`, `kind*` |
| `call:request` | visitor | visitor session | 5 | `room_id*`, `kind*` |
| `aicall:start` | visitor | visitor session | 5 | `room_id*`, `kind*`, `locale`, `speech` |
| `aicall:say` | visitor | visitor session | 2 | `call_id*`, `text*`, `seq*`, `via` |
| `aicall:end` | visitor | visitor session | 2 | `call_id*`, `reason` |
| `aicall:handoff` | visitor | visitor session | 5 | `call_id*` |
| `aicall:tool` | visitor | visitor session | 2 | `call_id*`, `name*`, `arguments` |
| `aicall:transcript` | visitor | visitor session | 1 | `call_id*`, `role*`, `text*`, `item_id*`, `greeting`, `via` |
| `aicall:fallback` | visitor | visitor session | 2 | `call_id*`, `reason` |
| `call:accept` | visitor | visitor session | 2 | `call_id*` |
| `call:decline` | visitor | visitor session | 2 | `call_id*` |
| `call:end` | team, visitor | `calls:make` | 2 | `call_id*` |
| `call:connected` | team, visitor | `calls:make` | 1 | `call_id*` |
| `call:failed` | team, visitor | `calls:make` | 1 | `call_id*`, `reason` |
| `call:resume` | team, visitor | `calls:make` | 2 | `call_id*` |
| `call:offer` | team, visitor | `calls:make` | 2 | `call_id*`, `data*` |
| `call:answer` | team, visitor | `calls:make` | 2 | `call_id*`, `data*` |
| `call:ice` | team, visitor | `calls:make` | 0.25 | `call_id*`, `data*` |
| `tcall:invite` | team | `calls:internal` | 5 | `channel_id*`, `kind*` |
| `tcall:accept` | team | `calls:internal` | 2 | `call_id*` |
| `tcall:decline` | team | `calls:internal` | 2 | `call_id*` |
| `tcall:end` | team | `calls:internal` | 2 | `call_id*` |
| `tcall:connected` | team | `calls:internal` | 1 | `call_id*` |
| `tcall:failed` | team | `calls:internal` | 1 | `call_id*`, `reason` |
| `tcall:resume` | team | `calls:internal` | 2 | `call_id*` |
| `tcall:offer` | team | `calls:internal` | 2 | `call_id*`, `data*` |
| `tcall:answer` | team | `calls:internal` | 2 | `call_id*`, `data*` |
| `tcall:ice` | team | `calls:internal` | 0.25 | `call_id*`, `data*` |
| `gcall:start` | team | `calls:internal` | 5 | `channel_id*`, `kind*`, `invite_ids` |
| `gcall:join` | team | `calls:internal` | 2 | `call_id*` |
| `gcall:leave` | team | `calls:internal` | 2 | `call_id*` |
| `gcall:decline` | team | `calls:internal` | 2 | `call_id*` |
| `gcall:invite` | team | `calls:internal` | 3 | `call_id*`, `member_ids*` |
| `gcall:media` | team | `calls:internal` | 1 | `call_id*`, `muted`, `camera_off` |
| `gcall:share` | team | `calls:internal` | 2 | `call_id*`, `on*` |
| `gcall:resume` | team | `calls:internal` | 2 | `call_id*` |
| `gcall:offer` | team | `calls:internal` | 2 | `call_id*`, `to*`, `data*` |
| `gcall:answer` | team | `calls:internal` | 2 | `call_id*`, `to*`, `data*` |
| `gcall:ice` | team | `calls:internal` | 0.25 | `call_id*`, `to*`, `data*` |
| `team:message:send` | team | `team_chat:use` | 2 | `content`, `thread_root_id`, `attachment_ids`, `client_msg_id`, `share_room_id`, `channel_id*` |
| `team:typing` | team | `team_chat:use` | 0.25 | `channel_id*`, `typing*`, `thread_root_id` |
| `team:read` | team | `team_chat:use` | 1 | `message_id`, `channel_id*` |
| `team:reaction` | team | `team_chat:use` | 1 | `emoji*`, `message_id*` |
<!-- END:client-events -->

`message:send` is idempotent on `client_msg_id`; the ack carries the stored message and whether it was newly created.

## Team chat

Internal chat between workspace members uses the same namespace and the same authentication. Events go to each member of the channel through the member's own channel (`member:<id>`), computed from the database when the event is emitted: a private channel (and every direct or group message) does not exist for non-members, and removing someone stops delivery immediately. The `team:*` client events are authorised with `team_chat:use`, rate limited with the same per-socket budget plus `team.send`, `team.channel` and `team.workspace` for messages, and run the same service functions as REST, so membership is checked on every event. History, edits, deletes, pins, search and channel management are REST ([API.md](API.md), tag "Team chat"). Delivery is at-most-once; clients refetch the channel list and the open channel on `server:resync` and after reconnecting, and `seq` (contiguous per channel) exposes gaps.

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
| `ticket:updated` | room audience (visitor gets a minimal copy) | `{ticket}` / visitor `{room_id, ticket: {id, number, status, resolved, csat_pending}}` | a ticket opened, was answered, taken over, resolved, rated, reopened, merged or closed |
| `call:state` | room audience (the visitor gets `{call: {id, room_id, kind, state, duration_s, ended_by, end_reason, agent_name}}`) | `{call}` | a call rang, connected, ended, was missed, declined or failed ([CALLS.md](CALLS.md)); never carries signalling |
| `call:state` (AI call) | as above | `{call}` with `transport: "ai"`, `kind: ai_voice\|ai_video`, `ai_agent_id`, `handoff_reason` for the team; the visitor copy has `agent_name` (the AI agent's name) and `handoff_reason` | a call with the AI assistant started, ended, was handed to a person or timed out ([CALLS.md](CALLS.md#calls-with-the-ai-assistant)) |
| `call:offer`, `call:answer`, `call:ice` | one socket: the other party of the call | `{call_id, data}` | WebRTC signalling relayed to the other side's bound socket and to nobody else |
| `tcall:state` | the two members of a call between teammates (every tab of each) | `{call: {id, channel_id, kind, state, caller: {id, name}, callee: {id, name}, duration_s, ended_by, end_reason}}` | a call between teammates rang, was answered, ended, was missed, declined or failed ([CALLS.md](CALLS.md#calls-between-teammates)); nobody else in the workspace receives it |
| `tcall:offer`, `tcall:answer`, `tcall:ice` | one socket: the other party of the call | `{call_id, data}` | WebRTC signalling of a call between teammates, relayed to the other side's bound socket only |
| `tcall:peer` | one socket: the other party | `{call_id, event: lost\|resumed}` | the other side's connection dropped or came back (restart ICE on `resumed`) |
| `gcall:state` | everyone with a row in the group call (invited, joined, left; every tab of each) | `{call: {id, channel_id, kind, state: live\|ended\|missed, host_id, max_participants, sharing_id, duration_s, participants: [{member_id, name, status, joined_at, muted, camera_off}]}}` | someone was invited, joined, left, declined, missed, muted, shared their screen, or the call ended ([CALLS.md](CALLS.md#group-calls)) |
| `gcall:offer`, `gcall:answer`, `gcall:ice` | one socket: the addressed participant | `{call_id, from, data}` | one link of the mesh; relayed only to the bound socket of the person named in `to` |
| `gcall:peer` | one socket: another participant | `{call_id, member_id, event: lost\|resumed}` | a participant's connection dropped or came back (the offerer of that link restarts ICE on `resumed`) |
| `call:peer` | one socket: the other party | `{call_id, event: lost\|resumed}` | the other side's connection dropped or came back (restart ICE on `resumed`) |
| `room:unread` | the member | `{room_id, unread_count}` | unread count changed |
| `typing` | room audience | `{room_id, typing, who}` | typing indicator (coalesced) |
| `presence:update` | workspace | `{member_id, online}` | team presence |
| `visitor:presence` | room audience | `{room_id, contact_id, online}` | visitor presence |
| `member:updated`, `member:removed` | workspace | member record / `{member_id}` | team changes |
| `inbox:new`, `inbox:updated` | workspace | inbox record | inbox changes |
| `contact:updated` | workspace | contact record | contact edit |
| `notification:new`, `notification:read` | the member | `{notification, unread_count}` / `{id, unread_count}` | in-app notifications (including billing and payment alerts) |
| `team:message:new` | each member of the channel | `{channel_id, message}` | team chat message stored (a shared conversation card is rendered per viewer) |
| `team:message:updated` | same | `{channel_id, message}` | edit, pin change, mentions changed |
| `team:message:deleted` | same | `{channel_id, message_id, thread_root_id}` | soft delete |
| `team:reaction` | same | `{channel_id, message_id, reactions: [{emoji, count, member_ids}]}` | a reaction was toggled |
| `team:channel:created` | the members, and for a public channel everyone | `{channel}` | a channel, direct or group message exists for you (or you were added) |
| `team:channel:updated` | the members | `{channel}` / `{channel_id, muted}` | rename, topic, archive; your own mute |
| `team:channel:removed` | the member | `{channel_id}` | you left, were removed from, or lost access to the channel |
| `team:channel:members` | the members | `{channel_id, member_id(s), joined}` | someone joined or left |
| `team:typing` | the other members | `{channel_id, thread_root_id, typing, member_id, name}` | typing indicator (volatile) |
| `team:read` | you (channels) or all members (direct and group messages) | `{channel_id, member_id, seq}` | a read cursor moved |
| `session:verified` | visitor | `{verified}` | OTP verification succeeded |
| `rate:limited` | the socket | `{reason: "too_many_violations", retry_after_ms}` | the socket exceeded its event budget repeatedly and is being disconnected |
| `server:draining` | every socket of the node | `{reconnect_in_ms}` | the node is shutting down: reconnect after the staggered delay |
| `server:resync` | every socket of the node | `{}` | the node lost and regained Redis (or missed events): refetch state over REST |
| `server:overflow` | the socket | `{}` | the socket was too slow and is being disconnected |
| `auth:expired` | the socket or workspace | `{}` | the token ended, or the workspace was suspended: renew or sign in again |

Delivery is at-most-once over the socket by design; correctness comes from REST: clients refetch on `server:resync` and after reconnecting, and message ids/sequence numbers (`seq`, contiguous per room) let them detect gaps ([ADR 0011](adr/0011-resync-over-rest.md)). Load tests count gaps, duplicates and reordering ([PERFORMANCE.md](PERFORMANCE.md)).
