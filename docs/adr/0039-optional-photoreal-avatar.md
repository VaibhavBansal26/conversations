# 0039. The photoreal avatar is optional, connected per workspace, and never the default

Status: accepted

## Context

Workspaces asked for a realistic talking video of the AI assistant in AI video calls. Hosted services (D-ID, HeyGen) render one and stream it over WebRTC. They cost money per minute, need an API key, can fail, and a photo of a real person as the face of an AI raises consent and disclosure questions.

## Decision

- An `AvatarProvider` interface (`server/src/avatar/provider.ts`) with one adapter, D-ID's Agents Streams API (`did.ts`), and a fake. The default is not a provider: the built-in face of ADR 0034.
- The key is the workspace's own, connected in Settings > Calls > Photoreal avatar, encrypted with `DATA_ENCRYPTION_KEY` like the Twilio and SendGrid credentials (ADR 0019), write-only. `DID_API_KEY` is an instance fallback. Photoreal is used only when a key is present AND the workspace switch is on AND the agent has an avatar AND the call is a video call on the browser engine AND the budget, concurrency cap and kill switch allow it.
- The server makes every provider call. The browser receives only the stream's offer and ICE servers and sends its answer and candidates back through the server; its peer connection has no tracks, so no visitor media reaches the provider.
- Any failure falls back to the built-in face and the browser voice; the call continues.
- The AI label, the "not a person" badge and the spoken disclosure are unchanged; photoreal adds a "computer-generated video" notice. A photo needs an explicit, recorded consent confirmation.

## Consequences

- Nothing changes for workspaces that do not connect a key.
- The D-ID request shapes come from its published reference; the parts the reference does not state (auth encoding, whether reading credits is free, agent build time, stream limits) are assumptions listed in CALLS.md. None of it ran against the real service.
- Lip-sync and voice come from the provider; captions still come from our text pipeline, so the transcript is the same as with the built-in face.
- The realtime voice engine (ADR 0035) and photoreal are not combined.
