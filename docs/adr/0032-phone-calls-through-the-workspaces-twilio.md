# 0032. Phone calls: the workspace's own Twilio, agent first, consent before the first ring

Status: accepted (2026-10-21).

## Context

Some conversations need a phone call. A call costs money, can reach a person at the wrong hour, and must not be possible to place against someone who never agreed. The product already lets each workspace connect its own Twilio account for SMS; webhooks per workspace are authenticated with that account's token.

## Decision

- **The workspace's own Twilio account only.** No fallback to a platform account, so spend and abuse stay with whoever configured it; an unverified or missing connection refuses the call (`NO_TWILIO`).
- **Call the agent first, then bridge the visitor** (`answerOnBridge` dial from the agent's answered leg). It needs no browser audio, nothing for the visitor to install, and the agent controls the moment of connection. The visitor's number comes from their contact and is frozen on the call row; it is never taken from a request.
- **Consent is a precondition, recorded with the number it was given for.** The callback form card (a required checkbox next to the number) writes `call_consent {at, phone, text}`; a changed number invalidates it. STOP and unsubscribed contacts are never called.
- **Spend guards fail closed:** a country allow-list that starts empty, premium-rate and similar number types blocked by libphonenumber type, a per-agent hourly limit on the limiter (closed when its store is down), a per-workspace daily limit enforced by writing the call row first and counting rows (concurrent requests can over-refuse, never over-spend), a dial time limit, and ring and bridge time-outs swept on every node with the provider asked to hang up.
- **Quiet hours** are judged in the visitor's time zone (their browser's, sent with the consent form), falling back to the workspace's office-hours zone.
- **Webhooks reuse the connection-scoped scheme** of SMS: signature over the exact URL with that workspace's auth token, the call id in the signed query string, one refusal for every kind of bad proof, idempotent on `CallSid|CallStatus|SequenceNumber`, and every transition a compare-and-set so late or repeated callbacks cannot corrupt a call.
- **The same call row and state machine** as browser calls (`transport = 'phone'`), with two extra events for the contact's phone ringing out (`no_answer`) or being busy (`busy`).

## Alternatives considered

- **Browser-based Twilio Voice SDK for the agent**: one fewer phone, but needs access tokens, TwiML apps and browser audio permissions; kept as an optional later step.
- **Call the visitor first**: the visitor waits on an empty line when no agent picks up, which is the worse failure.
- **Consent as a general contact flag**: cannot tell which number it covers.
- **Counting spend with a read-then-write check**: two parallel requests could both pass at the limit.

## Consequences

- A visitor who never opened the chat cannot be called: consent has to come from the chat first. This is deliberate.
- Quiet hours cannot be judged for visitors who never sent a time zone (the workspace zone is used instead).
- Nothing here has run against real Twilio.
