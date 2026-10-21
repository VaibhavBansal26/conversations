# 0031. Calls: signalling over the existing sockets, a pure state machine, and the database as arbiter

Status: accepted (2026-10-21).

## Context

Agents and visitors need voice and video calls inside the chat. The app already has authenticated, rate-limited, per-workspace Socket.IO connections for both kinds of user. Media must not pass through the server, a call must survive a network change, the signalling must not leak between conversations, and several things can happen to one call at the same moment (accept, cancel, timeout, two hang-ups, a reconnect).

## Decision

- **Signalling rides the existing sockets** as `call:*` events, each with a permission entry, a rate-limit cost and a payload schema in the same tables as every other event. Offers, answers and candidates go to **one socket**, the other party's, which the call row records; state changes go to the room audience without any signalling data.
- **The call row is the truth.** A pure state machine (`calls/machine.ts`) lists the legal transitions; the service applies each with a compare-and-set on the stored state and a partial unique index allows one live call per conversation. Two racing events end in one outcome; the other gets a plain error. Time-based transitions (missed, connect timeout, a side gone for 20 s) are a sweep that is safe to run on every node.
- **Authorisation is by participant and by socket.** Only the seat that placed the call and the visitor of that conversation may act on it, from the socket bound to the call; anyone else gets `404` or `403`. Bound sockets are re-bound by `call:resume`, which also returns fresh ICE credentials.
- **No media through the server, no recording.** TURN credentials are minted per call (coturn REST scheme, or Twilio Network Traversal with the workspace's own account) so no long-lived secret reaches a browser.
- **Perfect negotiation** in both browsers (agent impolite, visitor polite) so screen sharing and ICE restarts can start from either side.

## Alternatives considered

- **A separate signalling service or a third-party SDK**: more moving parts, a second authentication path and a new place for cross-tenant mistakes.
- **Broadcasting signalling to the room and letting clients filter**: leaks SDPs (which contain addresses) to every seat that can see the room.
- **An in-memory call registry**: breaks with more than one node and loses calls on restart; the row survives both.
- **A heartbeat per call**: more traffic than needed; socket disconnects plus a 20 s grace and ICE state cover it.

## Consequences

- A call needs the visitor's socket to be connected when it rings; a visitor who closed the page gets `VISITOR_OFFLINE` instead of a ring that nobody sees.
- Missed-call timing has a resolution of the sweep interval (5 s).
- Real-world connectivity depends on TURN being configured; the product says so in Settings and in the call panel instead of failing silently.
- Phone calls (Twilio Voice) reuse the call row with `transport = 'phone'` and are described separately.
