# 0038. Group calls are a WebRTC mesh capped at four

Status: accepted

## Context

Teammates asked for calls with more than one other person. Options: a selective forwarding unit (SFU, for example a LiveKit or mediasoup server), a mixing server, or a peer-to-peer mesh.

## Decision

A mesh, capped at four people including the host (`calls.internal.group_max`, 2 to 4). Each pair of browsers is its own WebRTC link; signalling goes over the existing sockets (`gcall:*`), the server keeps membership and relays. The cap is enforced by the server under a row lock on the call.

## Consequences

- No media server to run, secure, scale or pay for, and nothing is recorded or stored; media privacy is the same as 1:1 calls.
- Each browser uploads one stream per other person: three at four people. On weak uplinks or old laptops quality drops; this is the reason for the cap.
- Larger calls need an SFU; the signalling and membership model (participants, cards, permissions) would stay, the links would be replaced by one link to the SFU.
- ICE restarts are per link; the newer joiner is the offerer of a link.
- Visitor calls remain 1:1; screen share is one person at a time.
