# 0035. An optional realtime voice engine behind the same call, with a monitor instead of a guard

Status: accepted (2026-10-21). Amends [ADR 0033](0033-ai-calls-browser-speech.md).

## Context

The browser-speech engine of AI calls is free and keeps every answer inside the text pipeline, but it sounds like a speech synthesizer and recognition is only as good as the visitor's browser. The owner wants a live, natural conversation and suggested OpenAI's realtime voice models. A realtime model hears and speaks audio itself: its words reach the visitor before this server can read them, so the guards of the text pipeline (banned claims, ungrounded promises, link stripping) cannot run in front of it.

## Decision

1. **A second engine, off by default.** `calls.ai_engine` is `browser` (default) or `realtime`. The realtime engine needs `OPENAI_API_KEY` and `OPENAI_REALTIME_MODEL` on the server (there is no built-in model name); `OPENAI_BASE_URL`, `OPENAI_REALTIME_VOICE`, `OPENAI_REALTIME_TRANSCRIBE_MODEL` and the secret lifetime are configurable. `AI_REALTIME_ENABLED=false` is an instance-wide kill switch. The engine sits behind a `RealtimeProvider` interface (mint a one-call secret, say where the browser connects); `FakeRealtime` style tests replace the HTTP endpoint. The key is only on the server (environment); per-workspace keys are not built.
2. **The server mints, the browser connects.** For one call the server calls `POST {base}/realtime/client_secrets` with the key, the instructions and the tool list and hands the browser only the returned short-lived secret (default 60 seconds, enough to connect). The browser sends its SDP offer to `{base}/realtime/calls` with that secret and talks over a data channel `oai-events`. The visitor's microphone is the only media sent; the camera is never used, in video mode too (the face is drawn locally). The API key, the secret and the provider's response bodies never appear in logs, errors, audit entries, events or tables (a test scans all of them).
3. **Instructions are built here.** Persona, tone, the product's safety rules, a grounding rule (facts only from the `search_kb` tool in this call), hand-over rules, the disclosure sentence the model must say first (also stored by the server as a bot message), and the departments. The visitor's name, email and phone are never included, whatever the redaction setting.
4. **The model can only act through tools our server runs.** `search_kb`, `handoff_to_human`, `resolve_ticket`, `set_department`, `collect_contact_info`, `schedule_callback` (and `share_call_link` when that exists), each only if the agent's allowed actions switch it on, with the same schemas, department scope, autonomy checks, audit (`ai_agent.tool`, `source: realtime`) and visible lines as the text pipeline. The browser forwards function calls over `aicall:tool`; the server's answer goes back to the model. Knowledge-base results carry no links.
5. **A monitor replaces the guard.** The browser forwards finalized transcripts (`aicall:transcript`), which are stored as ordinary visitor and bot messages tagged with the call (redaction honoured). The server reads each one: an injection attempt, a sensitive topic (when the agent's trigger is on) or a request for a person in the visitor's words, a banned claim or an ungrounded commitment in the assistant's words, ends the call at once, hands the ticket to a person with the matching reason, leaves the usual call request and audits `call.ai_monitor_cut` with the trigger, never the words. The browser closes the connection on the answer. This limits damage after one sentence; it cannot prevent that sentence.
6. **Budgets and the kill switch.** A hard maximum duration, a per-workspace daily budget of realtime minutes, a realtime concurrency cap (besides the AI-call caps and `ai.concurrency`), and the kill switch: choosing the browser engine again or switching the instance flag ends running realtime calls at their next sign of life or in the sweep. Analytics counts calls and minutes per engine and shows a cost estimate only when the operator sets `AI_REALTIME_COST_PER_MINUTE_USD`.
7. **Fallback is the rule.** No key, no model, kill switch, no WebRTC in the browser, budget or concurrency used up, the provider failing at minting (HTTP error, rubbish, timeout) or the browser failing to connect (`aicall:fallback`): the call continues with the browser engine and says so. Realtime events are refused on a browser-engine call and the reverse.
8. **The same face.** Both engines drive the same face component; with realtime its mouth, ring and bars follow an analyser on the real audio of the assistant's voice.

## Alternatives considered

- **The model's raw output through our guards before speech** (a text model plus a TTS service): the guarantees of the text pipeline, a second paid service and more latency; the browser engine already is that, with free speech.
- **Server-side relay of the audio** (the server holds the provider connection): lets the server read every word before the visitor hears it only if it also delays it, adds a media path to operate, and puts audio through this server; refused.
- **A long-lived key in the browser**: never.
- **A per-workspace key store now**: more surface (encryption, UI, rotation) than this change; the instance key and the workspace switches are enough to start.

## Consequences

- The text pipeline's guarantee ("nothing unsafe is spoken") becomes "nothing unsafe is spoken twice": the realtime engine is a weaker guarantee, and the settings page and the docs say so.
- The provider session may keep billing until the browser disconnects: secrets cannot be revoked by this server, only expire; the browser closes on every end.
- **Not verified**: nothing here has run against the real service. The request and connection shapes follow OpenAI's documentation as fetched on 2026-10-21; event names for input transcription were not confirmed from the documentation pages read and are handled defensively. Voice quality, latency, cost, how the model follows the instructions and how often the monitor cuts are unmeasured.
