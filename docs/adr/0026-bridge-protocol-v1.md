# 0026. The page-to-host bridge: one envelope, versioned, command and event sets

Status: accepted (2026-10-21).

## Context

Four native channels exist (`WKScriptMessageHandler`, `@JavascriptInterface`, `ReactNativeWebView`, a Flutter `JavaScriptChannel`) plus `postMessage` for iframes. Each can pass text, so the protocol must be the same text on all of them, small enough to implement in a native wrapper in an afternoon, and safe against a page or host that sends garbage.

## Decision

- One JSON envelope `{v, id, type, payload, reply_to?}` in both directions; `ack` answers commands and `link_clicked`. Strict payloads (unknown fields rejected), 16 KiB limit, 30 commands per 10 s, unknown `v` ignored silently so versions can differ, unknown command answered with `UNKNOWN_COMMAND`.
- Native hosts always receive JSON **text**; iOS gets text too (not a dictionary) so the native decoder is the same everywhere. Host to page goes through one function, `ConversationsBridge.receive(text)`, and `postMessage` for iframes with `event.source` and `event.origin` checks.
- The page never exposes tokens or session ids; the `device_id` it exposes is not a credential. Links leave the page only through `link_clicked` (https, mailto, tel), and the host acks `handled`.
- The schema lives twice on purpose, as JSON Schema files in `docs/bridge/` (for integrators and codegen) and as validators in `bridge.js` (for the page); a contract test checks both agree on ~100 cases.

## Alternatives considered

- **One channel per command** (many `@JavascriptInterface` methods): fewer parsing steps, but each platform grows a different API surface and versioning becomes per method.
- **Custom URL scheme navigation** (`conversations://...`): works everywhere but cannot carry acks cleanly and breaks with navigation policies.
- **Ship the page as a native module per platform:** the point of the web view is one page to maintain.

## Consequences

- Adding a command or event inside v1 must be ignorable by old hosts; anything else is v2, and the page can speak both during a transition because `v` is read first.
- Hosts must implement the ack for `link_clicked` to keep links out of the web view; without it the page falls back to `window.open`.
