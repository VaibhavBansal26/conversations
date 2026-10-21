# What has been verified against real services and what has not

Short and plain. "Tested" below means automated tests in this repository (SQLite and embedded PostgreSQL for the server, jsdom for the web app, a built server driven by Playwright in Chrome for end to end). None of that is the same as running against the real provider, network or device. The test counts and how to run them are in [TESTING.md](TESTING.md).

## Never run against the real thing

| Area | What the tests use instead | What is therefore unknown |
| --- | --- | --- |
| SMS (Twilio) | fake provider; signed webhook requests built in the tests | real delivery, carrier filtering, segment billing and concatenation, real status callback order |
| Email (SendGrid) | fake provider; signed Event Webhook and Inbound Parse posts built in the tests | real delivery and spam placement, how mail clients render messages and transcript copies, real out-of-office and bounce formats |
| Phone calls (Twilio Voice) | mocked Twilio requests, TwiML and callbacks | real dialling, callback ordering, caller ID behaviour |
| AI language model (Anthropic) | scripted providers and the offline rules agent | answer quality, latency, token use, refusals |
| OpenAI realtime voice | a fake realtime provider | the real service, voice quality, cost per minute |
| Web Push services (FCM for Chrome, Mozilla autopush, Apple Web Push) | a local fake push service; Chrome's DevTools `deliverPushMessage` in end-to-end tests | whether real push services accept our VAPID JWT and payload, real delivery delays, iOS home-screen apps |
| Photoreal avatar (D-ID) | a fake of the documented D-ID endpoints | everything about the real service: see below |
| Stripe (plans, credits, Connect payments) | a fake Stripe and signed webhook events built in the tests | real checkout, Connect onboarding, disputes |
| WebRTC calls | two or three Chrome contexts on one machine with synthetic media | real NATs and firewalls, a live TURN relay, Safari, Firefox, mobile browsers, real cameras and microphones, group calls across machines |
| Native mobile (iOS package, Android library, React Native, Flutter) | contract tests of the bridge envelope | builds and runs on real devices (see [MOBILE-SDKS.md](MOBILE-SDKS.md)) |
| Scale | a load-test kit run on one machine | 1,000,000 connections; see [SCALING.md](SCALING.md) for measured versus extrapolated |

## Checked against published specifications

| Item | How |
| --- | --- |
| Web Push payload encryption (RFC 8291, `aes128gcm`) | `server/tests/push.test.ts` encrypts the worked example of RFC 8291 section 5 with its keys and salt and compares the bytes with the RFC's output |
| VAPID (RFC 8292) | the JWT is verified with the public key (ES256, audience, at most 12 hours) in `push.test.ts`; not presented to a real push service |
| D-ID request shapes | written from D-ID's published API reference, read on 2026-10-21; see below |
| Twilio and SendGrid webhook signatures | built in the tests with the documented algorithms |

## Photoreal avatar (D-ID)

Nothing was sent to D-ID. The adapter (`server/src/avatar/did.ts`) carries the same list in its header comment.

**Confirmed from D-ID's documentation**

- Authentication is HTTP Basic with the key exactly as D-ID Studio shows it (`username:password`); the server builds the header, the browser never sees the key.
- `GET /credits` returns `credits`, `remaining` and `total`. "Test connection" and "Save key" call only this.
- `POST /agents` with a presenter (`talk` with `source_url` and `thumbnail`, or `clip` with `presenter_id`) and an optional voice.
- `POST /agents/{id}/streams` returns an SDP offer, ICE servers and a session id; 409 means the agent is not ready yet.
- `/sdp` (answer), `/ice` (candidates), `POST .../streams/{streamId}` with a text script, and `DELETE` to end the stream.

**Assumed**

- The raw key works in the Basic header. If D-ID answers 401 to a valid key, set `DID_AUTH_ENCODE=base64`.
- Reading `/credits` spends no credits. The documentation does not say either way. If it does cost something, "Test connection" is the only thing that spends it, and only when someone presses it or saves a key.
- A newly created D-ID agent can stream at once. If it answers 409, that call falls back to the built-in face.
- A text script makes the avatar speak the text on the open stream.
- `thumbnail` may be the same address as `source_url`.

**Unknown**: idle timeouts and the longest stream, how credits are counted per second of stream, D-ID's rate limits. The daily minute budget and concurrency cap in Settings are this product's own limits, not D-ID's.

## Built and tested, with the real parts listed above still open

Group calls, Web Push, the photoreal avatar, AI agents on SMS and email, transcripts by email and pre-chat custom fields were all added together. Each has server tests on SQLite and PostgreSQL, web tests and an end-to-end test against the built server, and screenshots at 390, 1024 and 1440 px in light and dark ([design/DESIGN.md](design/DESIGN.md)). For each one, the real-service gap is the row above for its provider: push services, D-ID, Twilio and SendGrid, and real devices and networks for calls.

## Not built

Native mobile push (APNs and FCM): designed in [NOTIFICATIONS.md](NOTIFICATIONS.md), no code. The full list is in [FEATURES.md](FEATURES.md#not-built).
