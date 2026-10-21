# 0033. Calls with the AI agent: the visitor's browser does the speech, the server only sees text

Status: accepted (2026-10-21).

## Context

Visitors should be able to talk to the AI support agent, with voice and with something that looks like a video call. The agent already exists as a server pipeline (knowledge base, safety guards, hand-off triggers, AI budget and rate limits, injection defences, audit, turn records, redaction). A real-time speech stack (streaming speech-to-text, a voice model, text-to-speech, a media server) would add a paid service, API keys, a media path through the server and a recording question, none of which the product has.

## Decision

1. **The default engine is the visitor's browser.** `SpeechRecognition` (Web Speech API) turns speech into text and `speechSynthesis` speaks the reply. The server receives and returns text only, through socket events (`aicall:start`, `aicall:say`, `aicall:end`, `aicall:handoff`). No audio reaches this server; nothing is recorded. The browser vendor's own recognizer may process the audio (Chrome uses a Google service, Safari uses Apple's); the docs and the call screen say so.
2. **The reply text still comes from the existing pipeline.** `aicall:say` stores what was said as an ordinary visitor message (tagged `call_id`, `call_utterance`), runs `handleAgentTurn` (the same code as a typed message) and returns the stored bot message; the pipeline reports what it did through a `TurnCapture` instead of the call re-implementing any decision. So the guards, hand-off reasons, the budget degradation (daily AI quota used up: the rules agent answers), redaction and the audit apply unchanged.
3. **A `SpeechProvider` interface is the seam for server-side speech** (a hosted realtime speech API later). Only `browser` ships, plus `FakeSpeechProvider` for tests. The engine name is stored on the call (`calls.engine`).
4. **Video with the AI is an avatar, not a camera feed.** The visitor's camera is never sent anywhere for the AI (no vision, no upload); the "video call" mode shows the agent's animated avatar driven by voice activity, with captions. The visitor may turn their own camera on for a local self-view; it is off by default. The UI and the thread card say "AI video call (avatar)"; nothing claims the AI can see.
5. **An AI call is a call.** `calls` gets transport `ai` and kinds `ai_voice` / `ai_video` (migration 036: a table rebuild on SQLite per [ADR 0023](0023-sqlite-migrations-defensive-mode.md), CHECK replacement on PostgreSQL) and the columns `ai_agent_id`, `engine`, `handoff_reason`. It is created `active` (nothing rings), shows as a card in the thread, appears in the ticket timeline and in the analytics (count, duration, end reason, hand-off reason), and shares the one-live-call-per-conversation index with human calls.
6. **Guards.** The workspace setting `calls.ai` is off by default; the agent needs the new allowed action `ai_call` (older agents do not have it, so nothing changes until a manager allows it) and must not be suggest-only; a hard maximum duration (default 10 minutes), an idle timeout, a per-workspace daily limit (written first, counted up to it, so parallel starts can only over-refuse), a concurrency cap (the setting, and the `ai.concurrency` lease), a per-visitor start limit (6 an hour) and speaking rate (20 a minute), and the existing `ai.workspace` daily budget. The AI is disclosed in the greeting (spoken and stored), in the call screen and in the thread card.
7. **Hand-over without dropping the visitor.** "Talk to a person" (button or spoken request, or any hand-off trigger) ends the AI call with a reason, hands the ticket off through the routing engine, and leaves the usual call request for the team when browser calls are on; the call screen stays open waiting, and the existing incoming-call screen takes over when a person rings.
8. **Unsupported browsers fall back to text.** Firefox has no `SpeechRecognition`: the widget says so and opens the same AI in the text chat, which already exists.

## Alternatives considered

- **A server-side speech pipeline now** (audio over WebSocket or WebRTC to an STT/TTS/realtime API): better recognition, one behaviour on every browser, but a new paid dependency with keys, audio leaving the product, consent and retention questions, and a media path to operate. The interface keeps the option open.
- **A speech-to-speech model** deciding the answer itself: bypasses the knowledge-base grounding and the guards that make the agent safe.
- **Sending the camera to a vision model for "video calls"**: privacy cost with no support benefit; refused by design.
- **A new table for AI calls**: duplicates the card, the analytics and the one-live-call rule.

## Consequences

- Recognition quality, language coverage and voices are the visitor's browser and operating system, and differ between them; none of it is measured here.
- Firefox visitors get text; Safari's recognizer has quirks (see CALLS.md, not verified).
- A call costs one model turn per utterance, so the AI budget and rate limits are the cost control.
- A person who takes the conversation over ends the call at the visitor's next utterance, not instantly (a socket event could end it at once; the next utterance is the simplest correct moment).
