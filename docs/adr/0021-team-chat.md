# 0021. Team chat is its own set of tables and its own realtime path

Status: accepted (2026-10-21).

## Context

Workspaces asked for "internal communication among a team". The product only had internal notes and @mentions inside customer threads. The legacy product had an unfinished internal chat (generation B) that reused the customer conversation collections; that coupling was one reason it was dropped ([MIGRATION-NOTES.md](../MIGRATION-NOTES.md)).

## Decision

- **Separate tables**: `team_channels` (channel, dm, group; public or private), `team_channel_members` (role, read cursor, mute), `team_messages` (per-channel `seq`, `client_msg_id`, thread root, pin, soft delete), `team_reactions`, `team_mentions`. Customer rooms, their scope rules and their partitioned `messages` table are untouched.
- **Membership is the access rule.** Public channels can be read by every member of the workspace (to preview before joining) but written only by members; private channels, DMs and group messages return `404` to non-members everywhere. One function (`accessChannel`) is used by every REST route and every socket event.
- **Unread from cursors, ordering from `seq`**, as for customer threads: no stored counters, contiguous per-channel `seq`, keyset pagination.
- **Realtime per member.** Events are emitted to each channel member's own `member:<id>` channel, computed from the database at emit time, instead of adding Socket.IO rooms per channel. There is no membership state to keep in sync across nodes, removal stops delivery immediately, and a shared-conversation card can be rendered per viewer. The cost is one emit per member, acceptable for team-sized channels (hundreds, not hundreds of thousands).
- **Permissions**: `team_chat:use` (Owner, Manager, Agent, Viewer), `team_chat:manage_channels` and `team_chat:moderate` (Owner, Manager). Moderation deletes use their own route so the permission is checked before the handler.
- **Shared customer conversations** are a message kind whose card is computed per viewer with the customer-room visibility rule: a viewer who may not open the conversation gets `available: false` and no content; sharing requires being able to open the conversation yourself.
- **Notifications reuse the existing feed** (`notifications.channel_id` added) and the offline-email rule (not online, not in do-not-disturb, email preference on).

## Alternatives considered

- **Store team chat as special customer rooms** (the legacy design): couples visibility, one-room-per-contact, metrics and partitioning to something they do not apply to.
- **Socket.IO rooms per channel**: fewer emits for huge channels, but membership has to be mirrored into live sockets across nodes and kept correct on every change; per-viewer cards would still need per-member emits.
- **A third-party chat service**: another vendor and data processor for something the product can do with its own primitives.

## Consequences

- Very large public channels (thousands of members) would need a different fan-out; the design target is teams. Group messages are capped at 8 people.
- Search is a substring scan constrained by workspace and visibility; at large volumes it needs a full-text index (PostgreSQL `tsvector`) like customer search would.
- Existing custom roles received `team_chat:use` by a data migration; new custom roles must pick it explicitly.
