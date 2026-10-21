# Notifications

How team members hear about things: the in-app feed and sounds, emails about missed notifications, and **Web Push** to their browsers and installed web apps (built). Mobile push through APNs and FCM for the native SDKs is a design only ([below](#mobile-push-apns-and-fcm-design-not-built)).

## In-app and email

Unchanged from before: the bell in the app lists notifications (a message in a conversation you are assigned to, your inbox, unassigned ones for owners and managers, mentions, snoozes ending, tickets assigned, service levels missed), each member chooses the kinds in Settings > Notifications, and an email goes out for the ones that arrive while you have no app open and are not on do-not-disturb. See `server/src/services/notifications.ts` and [TEAM-CHAT.md](TEAM-CHAT.md) for team chat.

## Web Push (built)

**What a member does**: Settings > Notifications > Push notifications > *Turn on for this device* (an optional name such as "Work laptop"). The browser asks for permission, registers the app's service worker (`/sw.js`) and subscribes with the server's public VAPID key; the subscription goes to `POST /api/push/subscriptions`. Every device is listed with its browser, its push service, when it last received something, and three switches:

| Event | When it is sent | Click opens |
| --- | --- | --- |
| `missed_call` | a teammate's 1:1 call or a group call rang out without you answering; sent even if the app is open in another tab | the team chat conversation |
| `assigned` | a ticket or conversation was assigned to you, **only while the app is closed** (no live connection) | the conversation |
| `message` | a customer wrote in a conversation assigned to you, **only while the app is closed** | the conversation |

*Send a test* sends one notification to that device (5 in 10 minutes). *Turn off* deletes the subscription (and unsubscribes the browser when it is this one).

**Rules**

- **Do-not-disturb and "inactive"** stop every push (the test button excepted: you asked for it).
- **Privacy**: the payload carries a title, a short body, a path in this app and a tag. By default the body is generic ("A customer wrote in a conversation assigned to you."): **no customer name and no message text**. A workspace owner or manager can switch on *Show message text in notifications* (`push_message_previews`, off by default); then the first 120 characters are included. Payloads are end-to-end encrypted to the browser (RFC 8291): the push service (Google, Mozilla, Apple, Microsoft) cannot read them. The endpoint address is a capability and is never shown in full by the API (only its host), never logged and never in the audit log.
- **The click** opens only a page of this app: the service worker ignores any other origin.
- **Rate limits**: at most 30 pushes per member in 10 minutes (`push.member`); a burst of messages does not become a burst of notifications. One push per message or assignment (de-duplicated). A notification for the same conversation replaces the previous one on the device (`Topic`/`tag`).
- **Expired subscriptions**: a `404` or `410` from the push service deletes the subscription at once; other errors are counted and five in a row stop the device ("Stopped after errors" in the list; turning it on again resets it). `429`, `5xx` and network errors are retried by the job queue with backoff.
- **Tenant isolation**: a subscription belongs to one member in one workspace; every route acts on the caller's own devices (another member or workspace gets `404`). Removing a member deletes their devices on the next send.
- **SSRF guard**: the server POSTs only to known push services (`PUSH_ALLOWED_HOSTS`, default Google FCM, Mozilla, Apple, Microsoft); plain `http` only for `127.0.0.1`/`localhost` and only if listed (the tests' fake push service). An endpoint at any other address is refused with `PUSH_ENDPOINT_NOT_ALLOWED`.
- At most 10 devices per member.

**Server setup**: three environment variables ([CONFIGURATION.md](CONFIGURATION.md)):

```bash
npm run vapid --prefix server
# VAPID_PUBLIC_KEY=B...   (put all three in the server's environment; the same values on every node)
# VAPID_PRIVATE_KEY=...    (secret)
# VAPID_SUBJECT=mailto:you@example.com
```

Without them (or with a pair that does not match) push is **off**: `GET /api/push/config` answers `{enabled: false, reason: "not_configured" | "invalid_keys"}` and the settings screen says "Push notifications are not set up on this server". Changing the key pair invalidates every existing subscription (people turn notifications on again). iPhone and iPad receive Web Push only for a web app added to the home screen (Safari 16.4 or later).

**How it is built**: `server/src/push/webpush.ts` implements the protocol with `node:crypto` and `jose` (already dependencies: no new package, no change to the Docker image): RFC 8291 encryption (ECDH P-256, HKDF-SHA-256, AES-128-GCM, `aes128gcm` content coding, one 4096-byte record) and RFC 8292 VAPID (an ES256 JWT for the push service's origin, valid 12 hours). `server/src/push/service.ts` holds subscriptions, the rules above and the `push_send` job; the hooks are in `services/notifications.ts` (messages, assignments), `calls/teamCall.ts` and `calls/groupCall.ts` (missed calls). Table `push_subscriptions` (migration 042). Metric `conv_push_sends_total{outcome}`.

| Route | Who | Effect |
| --- | --- | --- |
| `GET /api/push/config` | any member | enabled, the VAPID public key, or why not |
| `GET /api/push/subscriptions` | any member | your devices (host of the push service only), and the workspace's preview setting |
| `POST /api/push/subscriptions` `{subscription: {endpoint, keys: {p256dh, auth}}, label?, events?}` | any member | register or refresh this browser |
| `PATCH /api/push/subscriptions/:id` `{events?, label?}`, `DELETE ...` | the owner of the device | change, turn off |
| `POST /api/push/subscriptions/:id/test` | the owner of the device | one test notification: `sent`, `gone`, `failed`, `retry` |

**What is verified**: `server/tests/push.test.ts` (SQLite and PostgreSQL): the encryption equals the worked example of RFC 8291 section 5 byte for byte and the browser side of that example decrypts it; the VAPID JWT verifies with the public key, has the right audience and lifetime; a **fake push service** (a real HTTP server on loopback) decrypts every message the server sends with the subscriber's private key; 404/410 cleanup, failure counting and disabling, retries after 503; app open versus closed, do-not-disturb, chosen events, previews on and off (the text never leaves without the switch), the per-member rate limit, the test-button limit, endpoint allow-list (metadata address, other hosts, plain http, credentials in the URL), bad keys, tenant isolation, a removed member. `web/src/pages/settings/PushSettings.test.tsx` (jsdom). `e2e/tests/16-push.spec.ts` in real Chrome: the settings screen sends a test through the fake push service; the **real service worker** receives a push delivered through Chrome's DevTools protocol and shows the notification with the page to open; a teammate call that rings out reaches the callee's device as a missed call.

**NOT verified**: delivery through a **real push service** (FCM, Mozilla autopush, Apple Web Push, Windows WNS) has never been run; subscribing through the browser's `PushManager` (it talks to those services) was not exercised in the automated tests; nothing was tested on real phones, on Safari (macOS or iOS home-screen apps), Firefox or Edge; the visible look of notifications on each operating system and the click behaviour from an OS notification centre were not checked. Try it on your own browsers with your own VAPID keys before relying on it.

## Visitors

Visitors get no push from this server. A visitor on the website hears about replies while the widget is open (sound, unread badge, title flash) and, when they left an email address with consent, by the email follow-up of the conversation. A native app embedding the chat can use the bridge events (`unread_changed`, `message_received`, [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md)) while it runs; push to a closed native app is the design below.

## Mobile push (APNs and FCM): design, NOT built

Nothing in this section exists in code: no device tokens are stored and nothing is sent to Apple or Google. It extends the proposal in [MOBILE-API.md](MOBILE-API.md#push-notifications-design-note) with the interface the server would implement, so it can be reviewed and estimated.

```ts
// server/src/push/mobile.ts (proposed)
export interface MobilePushTarget {
  platform: "ios" | "android";
  /** the APNs device token or the FCM registration token, stored encrypted with DATA_ENCRYPTION_KEY */
  token: string;
  /** the app's bundle id (APNs topic) or Firebase project + package */
  appId: string;
}
export interface MobilePushMessage {
  title: string;
  body: string;            // generic unless the workspace allows previews, exactly as for Web Push
  data: { kind: "message" | "assigned" | "missed_call" | "visitor_reply"; room_id?: string; channel_id?: string };
  collapseKey: string;     // apns-collapse-id / FCM collapse_key: one banner per conversation
  ttlSeconds: number;
  priority: "high" | "normal";
}
export interface MobilePushProvider {
  readonly platform: "ios" | "android";
  /** "gone" = the token is invalid (APNs 410 Unregistered / BadDeviceToken, FCM NOT_FOUND / UNREGISTERED): delete it */
  send(t: MobilePushTarget, m: MobilePushMessage): Promise<"sent" | "gone" | "retry" | "failed">;
}
// ApnsProvider: HTTP/2 to api.push.apple.com with a token-based (.p8) JWT; FcmProvider: FCM HTTP v1 with a service-account OAuth token.
// Credentials per workspace, encrypted like the Twilio/SendGrid connections (ADR 0019); none = no push (test-mode semantics, ADR 0018).
```

Proposed routes: `POST/DELETE /api/devices` (team members) and `POST/DELETE /public/devices` (a visitor session, only for verified identities or anonymous device sessions), the same events, rules (do-not-disturb, app open, rate limits, previews off by default) and job as Web Push, and SDK hooks (`Conversations.registerPushToken(token)` in the iOS/Android wrappers, a `push_token` bridge command). Open questions: Android 13 permission flow in the host app, notification channels, Live Activities, and who owns the APNs key when one app serves many workspaces.
