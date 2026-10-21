# 0036. Calls between teammates: the direct message is the permission, one call each

Status: accepted (2026-10-21).

## Context

Team members already chat in the app ([ADR 0021](0021-team-chat.md)) and call visitors ([ADR 0031](0031-calls-signalling-over-sockets.md)). They also want to call each other, with the same quality and without leaving the product. The rules differ from visitor calls: both parties are members, there is no ticket, and the question "who may ring whom" has to be answered without a conversation to hang it on.

## Decision

1. **Separate table and events, shared machine.** `team_calls` (migration 038) and `tcall:*` socket events, with the pure state machine (`machine.ts`), the TURN credentials (`turn.ts`) and the signalling rules (bound sockets, size limits, relay to the other side only) of visitor calls. Visitor calls keep their schema and permission untouched.
2. **The direct message is the permission.** A call is placed from a direct message and rings its other member; `accessChannel` decides who can write there, so nobody can ring a person they cannot message, and another workspace's ids are 404. Group messages, channels and #general are refused: group calls would need a mesh of peer connections or a media server, a party-state table and a UI for who joined, and are not built.
3. **A new permission, `calls:internal`** (migration 039), held by the built-in owner, manager and agent roles. Custom roles do not get it automatically (as `calls:make` before). It is needed on both ends.
4. **Presence, do-not-disturb and busy are checked before anything rings**, on the server: online presence, `dnd_until` and the inactive status, one live call per member (as caller, as callee, or as the agent of a visitor call). The database enforces the same with three partial unique indexes, so two callers racing for one callee produce exactly one ringing call.
5. **Ring spam is limited** (20 calls an hour per member, 5 in 5 minutes per pair).
6. **Cards in the direct message** are system messages updated as the call moves; they do not count as unread. The callee's tabs all get the state; the first to accept binds the call.
7. **Off by default** (`calls.internal.enabled`), like the other kinds.

## Alternatives considered

- **Reusing `calls` and `call:*` with a "team" transport**: that table is keyed by room and contact, and its permission and event names would mean two things.
- **Group calls as a mesh of up to four**: each peer needs a connection to each other peer, negotiation per pair, a participant table, join and leave events, per-pair ICE restarts and a gallery UI; it was left out rather than half-built.
- **Ringing any member from the member list without a direct message**: would need its own visibility rule; the member list opens (or creates) the direct message and calls from there.

## Consequences

- A member list "Call" button creates a direct message if there was none (an empty one, which is how the call card gets a place to live).
- Away members can be rung; inactive and do-not-disturb members cannot, with a clear reason.
- Missed calls leave a card and a toast in the apps that are open; there is no push notification for a member whose app is closed.
