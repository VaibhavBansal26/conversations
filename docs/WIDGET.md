# The chat widget

How to put the live-chat widget on a website, how its domain rules work, how to try it without touching your site, and what to check when it does not appear. The widget is one framework-free script (`/widget.js`, Shadow DOM) that talks to the same server that serves it. Decisions: [ADR 0020](adr/0020-widget-preview-flag.md).

## Install (five minutes)

In the app: **Settings > Chat widget > Install**.

1. **Choose your website.** Enter the domain the widget will run on (for example `www.example.com`). This creates an *embed token*: the widget only works on the domain it was issued for.
2. **Add the code.** Copy the snippet (it already contains this deployment's `PUBLIC_URL` and your token) and paste it before `</body>` on every page, or use the instructions for WordPress, Shopify, Google Tag Manager and React / Next.js shown next to it:

   ```html
   <script src="https://YOUR-APP/widget.js" data-token="cvt_..." async></script>
   ```
3. **Check that it works.** The page shows "Waiting for the widget to load on ..." and turns green with the site and time when the widget's first configuration request arrives (`tokens.last_seen_at` and `last_seen_origin`; refused origins and the in-app preview never count). `GET /api/tokens` returns both fields.

### Try it now (no code on your site)

**Try it now** opens `/widget-preview`, a page of this app that runs your real widget with your real settings. Chat as a visitor there, open the Inbox in another tab and reply as an agent: the answer arrives in the first tab. Conversations started this way are real (a contact called "Visitor"): close or delete them afterwards. The old `/widget-demo.html` (which needed a token pasted by hand and could not work from its own address) now points here.

How it works without weakening the domain check ([ADR 0020](adr/0020-widget-preview-flag.md)): `POST /api/tokens/:id/preview` (needs `tokens:manage`, audited) returns a link with a signed flag that names one token of your workspace and expires after 10 minutes. The widget sends it as `x-preview` instead of `x-api-key`. The server accepts the flag only from the app's own origin (no `Origin` header on a same-origin GET, or exactly `PUBLIC_URL`'s origin), and sessions created that way are marked `preview`, last 12 hours, and are accepted from the app's own origin only. A site's domain allow-list is untouched: the real token still requires the exact Origin, and a preview session is refused from any customer site (tests: `widget-preview.test.ts`, the origin table in `visitors.test.ts`).

## Mobile apps and web views

The same chat also runs full page, for a native app's web view or an iframe: [MOBILE-BRIDGE.md](MOBILE-BRIDGE.md). It is off until you switch **Hosted chat** on for a token, and it does not change the domain rules below.

## Domain rules

The token only works on the domain you entered. The browser's `Origin` header is compared with it:

| Token domain | Matches | Does not match |
| --- | --- | --- |
| `example.com` | `https://example.com`, `http://example.com`, `https://EXAMPLE.com` | `www.example.com`, `example.com:8443`, `evilexample.com`, `example.com.evil.test` |
| `www.example.com` | `https://www.example.com` | `example.com` (add it as its own token) |
| `*.example.com` | any depth: `app.example.com`, `a.b.example.com` | `example.com` itself, `evilexample.com` |
| `localhost:3000` | `http://localhost:3000` | `http://localhost`, `localhost:3001` (a port in the pattern must match; without one only default ports match) |

Add `www` and non-www as two tokens, or use `*.example.com` plus `example.com`. A missing `Origin` (some privacy tools, `file://` pages) or `null` never matches. One active token per domain per workspace; rotate it to change the key, revoke it to switch the widget off on that site.

## What the widget needs from your site

| Directive | Allow |
| --- | --- |
| `script-src` | the app's address (for `/widget.js`; the Socket.IO client is loaded from the same address at `/socket.io/socket.io.js`) |
| `connect-src` | the app's address over `https:` and `wss:` (REST under `/public`, Socket.IO under `/ws/<workspace>`) |
| `frame-src`, `img-src`, `style-src`, `font-src` | nothing: the widget draws in a shadow root with its own styles and no frames. Logos set in the customiser are loaded with `img-src`, so allow that host if you use one |
| mixed content | an `https` site needs an `https` app address (`PUBLIC_URL`) |

If the page has no CSP, nothing is needed.

## Customise

Settings > Chat widget > Customise (title, intro, colours with an accessibility contrast check, launcher style and position, logo, welcome and away messages, required information, office hours, default inbox). The same settings drive the live preview. Embed attributes: `data-theme="light|dark"` forces a theme; `data-manual` stops the automatic start so you can call `ConversationsWidget.init({ token, apiBase })` yourself.

### What visitors see of your team's work

Only customer-facing lines: your replies, the welcome and away bot messages, "Conversation started" and payment confirmations. Internal notes and system lines such as assignment, closing, reopening, snoozing and SMS consent are never sent to the widget (REST or socket; [REALTIME.md](REALTIME.md)). The satisfaction prompt after a close comes from the server stating the closed state, not from a visible line.

### AI agent in the widget

When an AI agent answers, its messages carry the agent's name and label (default "AI assistant"), the knowledge-base page as a link, a "Yes, thanks / No, I need more help / Talk to a person" row under the latest answer, and thumbs up and down under the newest AI answer. A small "Talk to a person" link above the message box is always there unless a person already has the conversation; it hands the ticket to the team. When a ticket is resolved the visitor gets the closing line and a 1 to 5 rating (once). The state comes from `room.ticket` and the `ticket:updated` event; internal action lines ("set the department to ...") and notes are never sent. The widget is English only; the hosted chat has the same controls in English, Spanish, French, German and Japanese ([AI-AGENTS.md](AI-AGENTS.md)).

### Office hours and away behaviour

With office hours enabled, a visitor message outside the hours gets the away message once per cooldown, followed by "We'll be back ..." when the next opening is known. The conversation is still created and answered later. The config response carries `office_open` and `agents_available`.

### Identity checks (OTP)

If a visitor gives an email or phone that already belongs to a conversation started on another device, the widget asks for a 5-digit code (valid 2 minutes, 5 attempts, 30 second resend cooldown; sent by email, else SMS) before showing that history. The code is sent through the **workspace's own** SendGrid / Twilio connection ([CHANNELS.md](CHANNELS.md)) or the platform default; with neither connected it only goes to the server log (console provider), so test mode cannot verify a visitor.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Nothing appears, no errors | the script tag is missing on that page, a cache or optimiser removed it (WordPress minifiers, Cloudflare Rocket Loader: exclude `widget.js`), or the page loaded before you published. View source and search for `widget.js` |
| Console: `403 ORIGIN_NOT_ALLOWED` on `/public/widget/config` | the page's origin does not match the token's domain: check `www` vs non-www, port, `http` vs `https`, or use `*.example.com`. The Install page lists the domain the token expects |
| `401 INVALID_API_KEY` | the token was revoked or rotated; copy the new snippet |
| CORS error in the console | usually the 403 above (error responses carry CORS headers, so the browser message can be misleading); also check that `CORS_ORIGINS` is not blocking `/public` (it only applies to `/api`) |
| Blocked by Content-Security-Policy | allow the app's address in `script-src` and `connect-src` (https and wss), see the table above |
| Mixed content blocked | an https site cannot load an http app address: set `PUBLIC_URL` to the https address and copy the snippet again |
| Works for you, not for visitors | ad blockers and privacy extensions block scripts named `widget.js` or chat-like requests; test in a clean profile. Self-host the script behind a neutral path with your own proxy if this is common for your audience |
| Chat opens but the connection banner stays | WebSocket blocked by a proxy or firewall; the widget falls back to polling every 5 seconds, so messages still arrive, with a delay. Allow `wss://` to the app |
| "We couldn't start the chat" | the pre-chat form needs a required field, or the workspace is suspended or locked; the message under it says which |
| Visitor sees the away message at the wrong time | office hours are evaluated in the timezone set in the customiser |
| Install page never turns green | the widget has not made a configuration request from a matching origin: publish the change, hard-reload a page of the site, check the console for the errors above |
| Preview says the link expired | links last 10 minutes; press Try it now again |
| Code is never delivered | channel is in test mode (nothing is sent), see [CHANNELS.md](CHANNELS.md) |
