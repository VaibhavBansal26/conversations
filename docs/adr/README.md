# Architecture decision records

Short records of decisions that shaped the system. Add one when you make a decision that is expensive to reverse.

* [0001](./0001-sqlite-default-postgres-for-scale.md) SQLite by default, PostgreSQL + Redis to scale out
* [0002](./0002-database-is-the-arbiter.md) The database arbitrates invariants, not process memory
* [0003](./0003-server-side-idempotency.md) Message idempotency on (room_id, client_msg_id) in the server
* [0004](./0004-hash-partition-messages-by-room.md) Partition messages by HASH(room_id), then monthly by created_at
* [0005](./0005-computed-room-audiences.md) Fan out room events to computed audiences, not per-room channels
* [0006](./0006-transactional-outbox-event-bus.md) Transactional outbox and an EventBus interface
* [0007](./0007-rate-limit-algorithms-and-leases.md) GCRA, sliding windows, leases and a never-over-admit local tier
* [0008](./0008-message-refs-locator.md) A locator table for lookups that do not know the room
* [0009](./0009-permessage-deflate-off.md) WebSocket compression off by default
* [0010](./0010-worker-threads-only-where-measured.md) Worker threads only for large HTML bodies
* [0011](./0011-resync-over-rest.md) Clients repair gaps over REST, not with replayed streams
* [0012](./0012-stripe-behind-an-interface.md) Stripe behind an interface, with an event journal and idempotent ledger
* [0013](./0013-platform-operators-are-separate.md) Platform operators are separate from workspace members
* [0014](./0014-permissions-deny-by-default.md) Permission-based access control, declared in one table, deny by default
* [0015](./0015-soft-delete-and-append-only-audit.md) Soft delete for messages and append-only audit
* [0016](./0016-analytics-pseudonymous-keys.md) Analytics exports are pseudonymous: HMAC keys from a per-workspace pepper
* [0017](./0017-tailwind-and-headless-primitives.md) Tailwind CSS v4 with owned components on headless primitives
* [0018](./0018-test-mode-delivery.md) Messages stored while a channel is not connected are `not_sent_test_mode`
* [0019](./0019-per-workspace-channel-connections.md) Per-workspace Twilio and SendGrid connections, verified per workspace
* [0020](./0020-widget-preview-flag.md) The in-app widget preview uses a signed flag, not a relaxed origin check
* [0021](./0021-team-chat.md) Team chat is its own set of tables and its own realtime path
* [0022](./0022-optional-sentry-allow-list-scrubber.md) Optional Sentry monitoring that rebuilds events from an allow-list
* [0023](./0023-sqlite-migrations-defensive-mode.md) SQLite migrations work in defensive mode; table rebuilds run with foreign keys off
* [0024](./0024-hosted-chat-origin-model.md) The hosted chat uses a per-token flag and the app's own origin
* [0025](./0025-signed-visitor-identity.md) Signed visitor identity (HMAC over external id and email)
* [0026](./0026-bridge-protocol-v1.md) The page-to-host bridge: one envelope, versioned, command and event sets
* [0027](./0027-tickets-inside-rooms.md) Tickets are episodes inside a room, opened by the message path
* [0028](./0028-departments-are-inboxes.md) Departments are inboxes, and routing decisions hold one workspace lock
* [0029](./0029-ai-agent-pipeline.md) The AI agent is a read-only decision followed by a write, with a rules agent underneath
* [0030](./0030-forms-in-the-thread.md) Details are collected with form cards in the thread, and never merge contacts
* [0031](./0031-calls-signalling-over-sockets.md) Calls: signalling over the existing sockets, a pure state machine, and the database as arbiter
* [0032](./0032-phone-calls-through-the-workspaces-twilio.md) Phone calls: the workspace's own Twilio, agent first, consent before the first ring
* [0033](./0033-ai-calls-browser-speech.md) Calls with the AI agent: the visitor's browser does the speech, the server only sees text
* [0034](./0034-agent-portraits-and-the-talking-face.md) Agent portraits, bundled presets and a face that does not pretend
* [0035](./0035-optional-realtime-voice-engine.md) An optional realtime voice engine behind the same call, with a monitor instead of a guard
* [0036](./0036-teammate-calls.md) Calls between teammates: the direct message is the permission, one call each
* [0037](./0037-call-links.md) Call links: an unguessable address that lets one person join one call, and nothing else
* [0038](./0038-group-calls-mesh.md) Group calls are a WebRTC mesh capped at four
* [0039](./0039-optional-photoreal-avatar.md) The photoreal avatar is optional, connected per workspace, and never the default
