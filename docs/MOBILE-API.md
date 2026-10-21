# Mobile: using the public API directly

For a native app that wants its own chat screen instead of the [hosted chat web view](MOBILE-BRIDGE.md): the public REST API and the Socket.IO protocol that the website widget and the hosted chat use. Machine-readable description: [openapi-public.json](openapi-public.json) (generated, checked by `docs:check`). Socket events: [REALTIME.md](REALTIME.md). Native wrappers for the web view: [MOBILE-SDKS.md](MOBILE-SDKS.md).

Verification status of the examples, stated plainly: the curl flow below is run against an in-process server by `server/tests/mobile.docs.test.ts`; the TypeScript and Swift (URLSession) examples are type-checked there (TypeScript against the real `socket.io-client` types, Swift with `swiftc -typecheck` where it exists); the Swift socket part (`socket.io-client-swift`) and all Kotlin code were **not compiled** (no package network access in tests, no Kotlin toolchain on the machine that wrote this).

## Tokens and origin

Every call carries the embed token in `x-api-key`. The token is public by design (the same one sits in every website's HTML), so it is not a secret and must not be treated as one.

The server checks `Origin` against the token's domain, which a native HTTP client does not have. Two ways, both safe because the check only exists to stop *other websites* from using the token in a visitor's browser:

1. Preferred: turn on **Hosted chat for this token** (Settings > Chat widget > Install) and send `x-hosted-chat: 1` with no `Origin` header. The server accepts a missing `Origin` only with that marker and only for a token that opted in.
2. Alternatively send `Origin: https://<the token's domain>` yourself.

The rules, the flag, and the identity options are in [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md#origin-and-identity-model). Never put the identity secret in an app ([identity verification](MOBILE-BRIDGE.md#identity-verification)): get `external_id`, `email` and `identity_hash` from your own backend after sign-in.

## Headers

| Header | When | Value |
| --- | --- | --- |
| `x-api-key` | always | the embed token `cvt_...` |
| `x-hosted-chat` | native clients | `1` |
| `x-device-id` | every call except `GET /public/widget/config` | a stable id per install: 8-64 characters of `A-Z a-z 0-9 _ -`. Generate once, keep in the keychain or encrypted preferences |
| `x-support-session` | every call after the session is created | the `session_token` (`ses_...`), a secret: keep it in the keychain / Keystore, never log it |
| `content-type` | JSON bodies | `application/json` |

A session works from the same device id **or** the same IP; a stolen session used from another device and network is refused (`SESSION_DEVICE_MISMATCH`). Sessions expire after 30 days (`SESSION_EXPIRED`); create a new one with the same device id and the same identity and the visitor continues the same conversation.

## The flow (curl)

```bash
BASE=https://YOUR-APP.example.com
KEY=cvt_YOUR_TOKEN
DEV=ios-install-0001
H=(-H "x-api-key: $KEY" -H "x-hosted-chat: 1" -H "x-device-id: $DEV")

# 1. workspace settings (title, colours, office hours, whether details are required)
curl -s "$BASE/public/widget/config" -H "x-api-key: $KEY" -H "x-hosted-chat: 1"

# 2. a visitor session. Anonymous, or identified: add "external_id", "email" and "identity_hash" (HMAC from YOUR backend)
curl -s "$BASE/public/sessions" "${H[@]}" -H 'content-type: application/json' \
  -d '{"name":"Ana"}'
# -> {"session_id","session_token":"ses_...","workspace_id","verified":false,"expires_at","contact":{"id","name"},"requires_verification":false}
SES=ses_FROM_THE_RESPONSE

# 3. start (or resume) the conversation: one per contact
curl -s "$BASE/public/rooms" -X POST "${H[@]}" -H "x-support-session: $SES" -H 'content-type: application/json' -d '{}'
# -> {"room":{"id","status","unread_count","last_message",...},"created":true}
ROOM=room_FROM_THE_RESPONSE

# 4. send a message. The same client_msg_id sent twice stores ONE message (safe to retry after a timeout)
curl -s "$BASE/public/rooms/$ROOM/messages" -X POST "${H[@]}" -H "x-support-session: $SES" -H 'content-type: application/json' \
  -d '{"content":"Hello, my order is late","client_msg_id":"7b3f0c9e-4f0a-4f6e-9a55-2f8f0f3a7c11"}'

# 5. history, newest 30 first; older with ?before=<the before_cursor of the previous page>
curl -s "$BASE/public/rooms/$ROOM/messages?limit=30" "${H[@]}" -H "x-support-session: $SES"
```

## Reference of what you need

| Task | Call | Notes |
| --- | --- | --- |
| settings | `GET /public/widget/config` | `widget.title`, `intro`, `primary_color`, `required_info`, `chat_type`, `office_hours`; `office_open`, `agents_available`. May be cached by an edge for 30 s |
| session | `POST /public/sessions` body `{name?, email?, phone?, external_id?, identity_hash?}` | `422 REQUIRED_INFO_MISSING` when the workspace requires details you did not send; `requires_verification: true` means a known contact on a new device must verify with a code (below) |
| current session | `GET /public/session` | `{session_id, workspace_id, verified, expires_at, contact}` |
| log out | `DELETE /public/session` | `204`; the secret stops working at once |
| rooms and unread counts | `GET /public/rooms` | each room has `unread_count` (team messages after your last read), `status`, `closed_marker`, `last_message` |
| start conversation | `POST /public/rooms` body `{inbox_id?}` | `201` created, `200` resumed; a welcome message is posted on creation. `409 VERIFICATION_REQUIRED` when the contact already has a conversation that this session may not see yet |
| messages | `GET /public/rooms/:id/messages?limit=1..50&before=<id>` | `{data[], pagination: {has_more_before, has_more_after, before_cursor, after_cursor}, room: {id, status, closed_marker}}`; no internal notes, only customer-facing system lines |
| send | `POST /public/rooms/:id/messages` body `{content?, attachment_ids?[<=4], client_msg_id?}` | text up to 4000 characters, or attachments, or both; `201` stored, `200` for a repeated `client_msg_id` (same message returned) |
| attachments | `POST /public/attachments` multipart field `file` | PNG, JPEG, GIF, WebP, PDF only (the content is sniffed and the extension must match); up to `UPLOAD_MAX_BYTES` (10 MB by default); returns `{id, file_name, content_type, size, url}`; pass `id` in `attachment_ids`. Download: the `url` of a message's attachment is signed and time-limited |
| read receipt | `POST /public/rooms/:id/read` body `{message_id}` | marks team messages up to that id as read; clears `unread_count` |
| rating | `POST /public/rooms/:id/csat` body `{score: 1..5, comment?}` | only after the team closed the conversation (`409 CSAT_NOT_AVAILABLE` otherwise or when already rated) |
| host attributes | `POST /public/session/attributes` body `{attributes: {plan: "pro"}}` | up to 20 keys per call, stored under the contact's `attrs.app`; untrusted |
| code | `POST /public/otp/send`, `POST /public/otp/verify` body `{code}` | for `requires_verification`; 5-digit code, 2 minutes, 5 attempts, 30 s resend cooldown |

`room.status` is `open` or `closed` (snoozing is internal and shown as open); a visitor message reopens a closed conversation. Message objects carry `id, seq, client_msg_id, sender {type: contact|agent|bot|system, name}, kind (text|image|attachment|...), content_text, attachments[], read, created_at`; `meta.card` carries payment requests.

## Real time (Socket.IO)

```
io("<BASE>/ws/<workspace_id>", { auth: { session: "<session_token>", deviceId: "<device id>" }, transports: ["websocket"] })
```

The Socket.IO client libraries: JavaScript (`socket.io-client`), Swift (`socket.io-client-swift`), Kotlin/Java (`io.socket:socket.io-client`), Dart (`socket_io_client`). A native client has no `Origin`, which the server accepts for visitor sockets.

| Direction | Event | Payload |
| --- | --- | --- |
| to server | `message:send` (ack) | `{room_id, kind: "text", source: "dm", content, client_msg_id}`; ack `{ok: true, message}` or `{ok: false, error, retry_after_ms?}` |
| to server | `message:read` (ack) | `{room_id, message_id}` |
| to server | `typing` | `{room_id, typing: true}`, at most one every 2 seconds |
| from server | `message:new` | `{message, room}`: a customer-facing message (yours echoed, or the team's) |
| from server | `message:updated`, `message:deleted` | edits and removals |
| from server | `message:receipt` | `{reader: {type: "agent"}, up_to_seq}`: the team read your messages |
| from server | `room:updated` | `{room: {id, status, closed_marker}}`: closed or reopened; `closed_marker` is what shows the rating prompt |
| from server | `typing` | `{who: {type: "agent", name}, typing}` |
| from server | `session:verified` | OTP verification succeeded; reload history |
| from server | `server:resync` | you may have missed events: `GET` the newest page of messages and merge by `id` |
| from server | `server:draining` | `{reconnect_in_ms}`: the node is shutting down; wait that long plus a random 0-1 s before reconnecting |

Presence of the team is `agents_available` and `office_open` from the config call; a visitor does not subscribe to agent presence.

### Reconnect and background behaviour

- **Back-off with jitter.** Reconnect after 1 s, doubling to 30 s, each wait multiplied by a random 0.5 to 1.5 (Socket.IO's `randomizationFactor` does this). After `io server disconnect` wait 0.5 to 5 s at random: a whole fleet must not return in the same second. On `429`, honour `Retry-After`.
- **Resync after every reconnect.** Fetch the newest page and merge by `id`; do not assume the socket replayed anything.
- **Sends are idempotent.** Keep unsent messages in a local queue with their `client_msg_id`; resend on reconnect. A resend never duplicates. If the socket ack does not arrive within about 8 s, resend over REST with the same `client_msg_id`.
- **Background.** iOS suspends sockets shortly after the app leaves the foreground and Android restricts background networking (Doze). Expect no events while backgrounded: when the app returns, reconnect and resync. To tell the user about new messages while the app is closed you need push ([design note](#push-notifications-design-note)).

## Limits and errors

Error body: `{"error": {"code", "message", "details?"}}`. Rate-limit headers `RateLimit-Policy`, `RateLimit`, `X-RateLimit-*` and `Retry-After` are on every response; a `429` has `error.code: "RATE_LIMITED"`, `retry_after_s` and the `policy`.

| Policy (see [RATE-LIMITING.md](RATE-LIMITING.md)) | Limit |
| --- | --- |
| `public.config` | 60 per minute per IP (also `GET /chat`) |
| `public.session` | 20 per minute per IP, origin and token; escalating penalty on abuse; fails closed |
| `public.query` | 10 per second, burst 40, per session |
| `public.room` | 10 per 50 s per session |
| `public.send` | 30 per 30 s per session, plus 300 per minute per room and the workspace's hourly plan quota |
| `public.read` | 60 per 30 s per session |
| `public.upload` | 10 per minute per session |
| `public.otp.*` | 5 sends per 10 minutes per session, 10 per day per contact, 30 per hour per IP; 10 attempts per 5 minutes |

| Code | HTTP | Meaning and what to do |
| --- | --- | --- |
| `INVALID_API_KEY` | 401 | unknown or revoked token: update the app's configuration |
| `ORIGIN_NOT_ALLOWED` | 403 | see [Tokens and origin](#tokens-and-origin) |
| `WORKSPACE_SUSPENDED` | 403 | the workspace is suspended; show a generic error |
| `DEVICE_ID_REQUIRED` | 400 | missing or malformed `x-device-id` |
| `INVALID_SESSION`, `SESSION_EXPIRED`, `SESSION_DEVICE_MISMATCH` | 401 | create a new session (same device id, same signed identity) |
| `VERIFICATION_REQUIRED` | 409 | send and verify a code, or identify with a signed identity |
| `IDENTITY_HASH_INVALID`, `IDENTITY_NOT_CONFIGURED`, `IDENTITY_REQUIRED`, `IDENTITY_CONFLICT` | 401, 422, 422, 409 | see the [identity matrix](MOBILE-BRIDGE.md#identity-verification) |
| `REQUIRED_INFO_MISSING` | 422 | the workspace requires `details.missing` fields |
| `EMPTY_MESSAGE`, `CONTENT_TOO_LONG`, `UNKNOWN_ATTACHMENT` | 422 | fix the message |
| `FILE_TOO_LARGE`, `UNSUPPORTED_FILE_TYPE`, `FILE_TYPE_MISMATCH` | 413, 415, 415 | pictures and PDFs only, within the size limit |
| `CSAT_NOT_AVAILABLE` | 409 | the conversation is not closed or is already rated |
| `OTP_COOLDOWN`, `OTP_INVALID`, `OTP_EXPIRED`, `OTP_ATTEMPTS_EXCEEDED`, `NO_ACTIVE_OTP`, `OTP_CHANNEL_UNAVAILABLE`, `OTP_DELIVERY_FAILED` | 429, 422, 422, 429, 422, 422, 502 | one-time-code flow |
| `RATE_LIMITED` | 429 | wait `Retry-After` seconds |

Versioning: these routes are the public surface, listed in [openapi-public.json](openapi-public.json); additions are backwards compatible, a breaking change is announced in [CHANGELOG.md](../CHANGELOG.md) and gets a new path. Send no fields the schema does not list.

## Security do and do not

- Do keep `session_token` in the Keychain / Android Keystore-backed storage; do not log it, put it in URLs, crash reports or analytics.
- Do get `identity_hash` from your backend per sign-in; do not embed the identity secret in the app, a build config, or a remote config the client can read.
- Do treat the embed token as public; do not rely on it to keep anyone out. Use identity verification and enforcement to protect known customers' history.
- Do validate any URL a team member sends you before opening it (`https`, `mailto`, `tel`), and open links in the system browser, not inside your own authenticated web view.
- Do not render message HTML: `content_text` is plain text; `content` is sanitised HTML meant for the web.
- Attachment URLs are signed and expire (`SIGNED_URL_TTL_SECONDS`): fetch them promptly and re-read the message for a fresh URL.

## TypeScript example

```ts mobile-api
import { io, type Socket } from "socket.io-client";

const BASE = "https://YOUR-APP.example.com";
const KEY = "cvt_YOUR_TOKEN";
const DEVICE = "ts-install-0001";

interface Session { session_token: string; workspace_id: string; verified: boolean; requires_verification: boolean }
interface Message { id: string; client_msg_id: string | null; content_text: string; sender: { type: string; name: string } }

async function call<T>(method: string, path: string, session?: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-api-key": KEY, "x-hosted-chat": "1", "x-device-id": DEVICE, ...(session ? { "x-support-session": session } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) throw Object.assign(new Error("rate limited"), { retryAfter: Number(res.headers.get("retry-after") ?? 1) });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error?.message), { code: json.error?.code });
  return json as T;
}

export async function chat(onMessage: (m: Message) => void): Promise<{ send: (text: string) => Promise<void>; socket: Socket }> {
  const s = await call<Session>("POST", "/public/sessions", undefined, { name: "Ana" });
  const { room } = await call<{ room: { id: string } }>("POST", "/public/rooms", s.session_token, {});
  const history = await call<{ data: Message[] }>("GET", `/public/rooms/${room.id}/messages?limit=30`, s.session_token);
  history.data.forEach(onMessage);

  const socket = io(`${BASE}/ws/${s.workspace_id}`, { auth: { session: s.session_token, deviceId: DEVICE }, transports: ["websocket"], reconnectionDelayMax: 30000, randomizationFactor: 0.5 });
  socket.on("message:new", (p: { message: Message }) => onMessage(p.message));
  socket.on("server:resync", async () => (await call<{ data: Message[] }>("GET", `/public/rooms/${room.id}/messages?limit=30`, s.session_token)).data.forEach(onMessage));

  const send = async (text: string) => {
    const client_msg_id = crypto.randomUUID();
    // REST is the reliable path; the socket echoes the stored message back as message:new
    await call("POST", `/public/rooms/${room.id}/messages`, s.session_token, { content: text, client_msg_id });
  };
  return { send, socket };
}
```

## Swift example (URLSession)

```swift mobile-api
import Foundation

struct Session: Decodable {
    let session_token: String
    let workspace_id: String
    let verified: Bool
}

struct ApiError: Error { let code: String; let message: String }

final class ChatClient {
    let base: URL
    let key: String
    let device: String          // generate once, keep in the Keychain
    private(set) var session: Session?

    init(base: URL, key: String, device: String) { self.base = base; self.key = key; self.device = device }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: URL(string: path, relativeTo: base)!)
        req.httpMethod = method
        req.setValue(key, forHTTPHeaderField: "x-api-key")
        req.setValue("1", forHTTPHeaderField: "x-hosted-chat")
        req.setValue(device, forHTTPHeaderField: "x-device-id")
        if let s = session { req.setValue(s.session_token, forHTTPHeaderField: "x-support-session") }
        if let body { req.setValue("application/json", forHTTPHeaderField: "content-type"); req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw ApiError(code: "NETWORK", message: "no response") }
        if http.statusCode >= 400 {
            let e = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any]
            throw ApiError(code: e?["code"] as? String ?? "HTTP_\(http.statusCode)", message: e?["message"] as? String ?? "")
        }
        return data
    }

    func start(name: String) async throws {
        session = try JSONDecoder().decode(Session.self, from: try await request("POST", "/public/sessions", body: ["name": name]))
    }

    func send(roomId: String, text: String) async throws {
        // the same client_msg_id sent twice stores one message: retry freely
        _ = try await request("POST", "/public/rooms/\(roomId)/messages", body: ["content": text, "client_msg_id": UUID().uuidString.lowercased()])
    }
}
```

For the socket with `socket.io-client-swift` (not compiled here):

```swift
// Package: https://github.com/socketio/socket.io-client-swift
let manager = SocketManager(socketURL: base, config: [.compress, .reconnects(true), .reconnectWaitMax(30), .randomizationFactor(0.5), .forceWebsockets(true)])
let socket = manager.socket(forNamespace: "/ws/\(session.workspace_id)")
socket.connect(withPayload: ["session": session.session_token, "deviceId": device])
socket.on("message:new") { data, _ in /* data[0] is ["message": [...], "room": [...]] */ }
socket.on("server:resync") { _, _ in /* reload the newest page */ }
```

## Kotlin example (OkHttp, not compiled here)

```kotlin
// implementation("com.squareup.okhttp3:okhttp:4.12.0")
// implementation("io.socket:socket.io-client:2.1.0")
val client = OkHttpClient()
fun post(path: String, session: String?, json: String): String {
    val req = Request.Builder().url(BASE + path)
        .header("x-api-key", KEY).header("x-hosted-chat", "1").header("x-device-id", DEVICE)
        .apply { if (session != null) header("x-support-session", session) }
        .post(json.toRequestBody("application/json".toMediaType())).build()
    client.newCall(req).execute().use { res ->
        val body = res.body!!.string()
        check(res.isSuccessful) { "HTTP ${res.code}: $body" }
        return body
    }
}

// real time
val opts = IO.Options().apply {
    auth = mapOf("session" to sessionToken, "deviceId" to DEVICE)
    transports = arrayOf("websocket")
    reconnectionDelayMax = 30_000
    randomizationFactor = 0.5
}
val socket = IO.socket(URI.create("$BASE/ws/$workspaceId"), opts)
socket.on("message:new") { args -> val payload = args[0] as JSONObject /* payload.getJSONObject("message") */ }
socket.on("server:resync") { /* reload the newest page */ }
socket.connect()
```

## Push notifications: design note

Status: a proposal. **Nothing here is implemented**, no device tokens are stored, and no push is sent. It is written so the work can be estimated and reviewed.

Why: a web view and a socket do not receive anything while the app is suspended; a customer who left the app must be told that the team answered.

Proposed design:

- **Registration.** `POST /public/devices` (visitor session) and `POST /api/devices` (team member, permission `conversations:read`) with `{platform: "ios"|"android", token, app_id, locale}`. One row per device in a `push_devices` table (workspace id, owner kind and id, platform, token hash for lookups, the token encrypted with `DATA_ENCRYPTION_KEY`, last seen, created). `DELETE` on log-out; the server also deletes tokens that APNs or FCM report as invalid (`Unregistered`, `BadDeviceToken`, `NOT_FOUND`).
- **Delivery.** A job on the existing queue ([ADR 0006](adr/0006-transactional-outbox-event-bus.md) outbox): when a customer-facing team message is stored and the visitor has no live socket for a grace period (the presence service already knows), enqueue one push per device, coalesced per conversation (collapse key / `apns-collapse-id` = room id) so ten replies are one banner. Agents get pushes under the same rules as the offline email in [notifications](TEAM-CHAT.md) (assigned, mentioned, direct messages).
- **Providers.** APNs token-based auth (a `.p8` key per workspace or per platform, stored encrypted) and FCM HTTP v1 (a service-account JSON, encrypted). A workspace connects its own app credentials the way it connects Twilio ([ADR 0019](adr/0019-per-workspace-channel-connections.md)); without credentials no push is attempted (test mode semantics, like [ADR 0018](adr/0018-test-mode-delivery.md)).
- **Payload shape and privacy.** Visible text is configurable per workspace: `generic` (default: "New message from Acme") or `preview` (first 80 characters of the reply). The data payload carries only `{v: 1, kind: "message", room_id, message_id}` (no names, no message text, no session or token) and the app fetches the content over the API after unlocking. Lock-screen previews are therefore opt-in. Payloads stay under 4 KB (APNs) and are never retried after the message was read.
- **Abuse and cost.** Registration is rate limited per session; a push per conversation per minute at most; per-workspace daily cap by plan; no push for internal notes or system lines (same allow-list as the visitor view).
- **Open questions.** Android 13 notification permission flow lives in the app; Live Activities; whether the visitor push needs the verified identity (recommended: only for verified or anonymous-with-device sessions, never for unverified sessions that claimed an email).

Estimate: about 4 days server (table, routes, job, two providers behind interfaces, tests with fake providers), 1 day per platform SDK for token registration.
