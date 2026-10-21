# SMS and email channels

How a workspace connects its own Twilio (SMS) and SendGrid (email) accounts, how inbound traffic is routed and verified per workspace, and what to expect from the providers. Decision record: [ADR 0018](adr/0018-test-mode-delivery.md) (test mode) and [ADR 0019](adr/0019-per-workspace-channel-connections.md) (connections).

> **Verification status.** Everything below that talks to Twilio or SendGrid was written against their public documentation and exercised with mocked `fetch` in the test suite. **No real Twilio or SendGrid call has been made from this repository.** Run `npm run smoke:channels --prefix server` with your own credentials (see [Smoke test](#smoke-test)) before relying on it. Items we could not confirm are marked **(unverified)**.

## 1. What you see in the app

| State | Where | Meaning |
| --- | --- | --- |
| "Test mode: not sent" badge, no ticks | on a message | the channel has no provider; the message is stored (`delivery = not_sent_test_mode`), nothing left the server, nothing was billed |
| Yellow banner "SMS is not connected. Messages are saved but not sent." | above the composer on the SMS/Email tab, top of Settings > Channels | same, for the whole channel |
| Red banner "... rejected the saved credentials" | same places | the workspace connected an account but it is unverified or Twilio/SendGrid refused the credentials; sends fail with that reason and do **not** fall back to another account |
| Normal ticks | on a message | a real provider accepted the message (sent), reported it delivered, or the contact opened the email |

A message stored in test mode can be sent later: once the channel is connected, "send it now" on the message (the normal `POST /api/messages/:id/retry`).

`GET /api/channels/status` returns, per channel, `mode` (`live`, `test`, `attention`), `connected`, `provider`, `source` (`workspace`, `platform`, `none`), counts, masked connection facts and the last provider error. It never contains credentials.

## 2. Where credentials come from

1. **The workspace's own connection** (Settings > Channels > Connect Twilio / Connect SendGrid). Stored in `channel_connections`, encrypted with `DATA_ENCRYPTION_KEY` (AES-256-GCM, additional authenticated data `channel:<workspace>:<channel>`). API responses show the last four characters only. Credentials are never logged; provider error texts are passed through a redactor before they are stored or shown.
2. **The platform default** from the environment (`SMS_PROVIDER=twilio` with `TWILIO_*`, `EMAIL_PROVIDER=sendgrid` with `SENDGRID_*`) for self-hosters who run one Twilio account for everybody. It is used only by workspaces that have no connection of their own.
3. Otherwise the **console** provider: test mode.

A workspace that has a connection never silently uses (2) or (3): a pending, rejected or undecryptable connection makes every send fail with a message that says what to fix ("fail closed"). The operator needs `DATA_ENCRYPTION_KEY` set (the Render blueprint generates one); without it the connect call answers `503 DATA_ENCRYPTION_KEY_REQUIRED`. Changing the key makes stored credentials unreadable (`CHANNEL_CREDENTIALS_UNREADABLE`): keep the old key in `DATA_ENCRYPTION_KEY_PREVIOUS` or paste the credentials again.

System email (invitations, password reset, notification and digest emails) has **no per-workspace provider**: it uses the platform mailer (`EMAIL_PROVIDER`). On a deployment without it those emails are only logged; `system_email` in the status response and the runbook say so.

## 3. Connect Twilio

1. In the [Twilio Console](https://console.twilio.com/) copy the **Account SID** (`AC...`) and **Auth Token** from Account Info. Optionally create an API key (`SK...` and its secret) to send with; the Auth Token is still required because it signs webhooks ([Twilio: webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security): the signature is HMAC-SHA1 with the account auth token as key).
2. Settings > Channels > **Connect Twilio**, paste, "Connect and verify". Verification is read-only: `GET /2010-04-01/Accounts/{sid}.json`. It must return `status: active`. A Trial account is accepted with a warning.
3. **Import numbers**: lists `IncomingPhoneNumbers` of the account; you pick the ones to add. Only numbers Twilio itself lists for the account can be added (also when you type one by hand): a workspace cannot claim a number it does not own. A number can belong to one workspace in the whole installation.
4. In Twilio: Phone Numbers > Manage > Active numbers > your number > Messaging > *A message comes in*: Webhook, HTTP POST, the **SMS webhook URL** shown in the app (`<PUBLIC_URL>/webhooks/c/<id>/twilio/sms`). Delivery receipts use a status callback that is attached to every outbound text automatically (`.../twilio/status`).
5. **Check webhook** shows the latest inbound events and their outcome (processed, duplicate, ignored, rejected). **Send test** sends one text to a number you enter (10 per workspace per hour).

### How inbound Twilio requests are verified

The URL contains an opaque connection id (`wh_...`). The server loads that connection, decrypts **that workspace's** Auth Token and checks `X-Twilio-Signature` over `PUBLIC_URL + path + sorted parameters`. A request signed with another workspace's token, the platform token, or no signature gets `401 INVALID_SIGNATURE`, as does an unknown id (ids cannot be probed). Even a correctly signed request can only deliver to the workspace's own numbers. Replays: Twilio signatures carry no timestamp, so a repeated request is stopped by the `MessageSid` idempotency record (acknowledged, stored once). Repeated failures count toward a per-IP block (`webhook.badsig`).

### Twilio caveats

- **Trial accounts** can only text numbers verified in the console (up to 5), only in the country of sign-up, and use Twilio-provided message templates ([trial guide](https://www.twilio.com/docs/messaging/guides/how-to-use-your-free-trial-account)). The app maps error 21608 to this explanation. The documented trial message prefix could not be confirmed from that page **(unverified)**.
- **US SMS needs registration.** Sending application traffic from a US 10DLC number requires A2P 10DLC registration (brand and campaign); unregistered traffic is filtered more and costs extra carrier fees; toll-free numbers and short codes are outside 10DLC but have their own verification ([A2P 10DLC overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)). The toll-free verification requirements and all registration fees were **not verified** here; check Twilio's current pricing and onboarding pages. Conversations does not register brands or campaigns for you.
- **Opt-out.** The app classifies inbound STOP/UNSUBSCRIBE/CANCEL/END/QUIT (and START/YES/UNSTOP) itself, marks the contact opted out and refuses further sends (`CONTACT_OPTED_OUT`). Twilio also blocks sends to a number that replied STOP (error 21610, mapped to "recipient opted out"). Carriers and local law (TCPA, CTIA guidelines, GDPR/ePrivacy elsewhere) require consent records and honouring opt-out; the app stores the opt-out flag but is not a compliance programme. We did not verify Twilio's current default keyword list **(unverified)**.
- **Costs.** Twilio bills the workspace's own account (per segment, plus number rental and carrier fees). Prices change and differ by country: see [Twilio SMS pricing](https://www.twilio.com/en-us/sms/pricing/us). The in-app credit counter (`CREDIT_COST_SMS`) is the *platform's* own metering and is not debited in test mode.
- Error codes mapped in `server/src/providers/errors.ts`: 20003 (bad credentials), 21608 (trial restriction), 21408 (geo permission), 21211/21614/21217 (bad recipient), 21212/21606/21612/21660 (bad sender), 21610 (opted out), 20429/429 (rate limit), HTTP 402 or a message mentioning balance/funds (insufficient funds; the exact Twilio code for an empty balance was not confirmed **(unverified)**), 5xx (retried).

## 4. Connect SendGrid

1. In SendGrid create an API key ([Settings > API Keys](https://app.sendgrid.com/settings/api_keys)) with **Mail Send**; add the Sender Authentication read permission to allow importing verified senders.
2. Settings > Channels > **Connect SendGrid**. Verification is read-only: `GET /v3/scopes` (must include `mail.send`), `GET /v3/verified_senders` and `GET /v3/whitelabel/domains` (a restricted key gets a note instead of an error; these two endpoints and their permissions were not exercised against the real API **(unverified)**).
3. **Import verified senders** adds the single senders SendGrid marks verified. You can still add senders by hand (the existing list).
4. **Sender identity is required by SendGrid**: verify a *Single Sender* (an address that can receive the verification email) or authenticate a **domain** (DNS records SendGrid generates for you: typically CNAME records for the mail and DKIM keys; the exact records are shown in SendGrid) ([sender verification](https://www.twilio.com/docs/sendgrid/ui/sending-email/sender-verification)). Single sender on a free mailbox domain can fail DMARC checks at large providers; authenticate your own domain for production. A 403 "from address does not match a verified Sender Identity" is mapped to a fix-it message.
5. **Inbound (replies)**: create an MX record for a hostname you dedicate to it (for example `parse.example.com`, priority `10`, target `mx.sendgrid.net`), then in SendGrid Settings > Inbound Parse > Add Host & URL paste the **Inbound Parse URL** from the app ([Inbound Parse setup](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook)). Add the address people write to (for example `help@parse.example.com`) under *Inbound addresses*. Do not put an MX record on a domain that already receives your normal mail.
6. **Delivery events**: Settings > Mail Settings > Event Webhook: paste the **Event Webhook URL**, enable Delivered, Bounced, Dropped, Opened and Signature Verification, and paste the **verification key** SendGrid shows into the app.

### How inbound SendGrid requests are verified

Inbound Parse cannot be signed (the documentation describes no authentication for it), so each connection's URL carries a random secret (`?secret=`): stored as a hash for checking and as ciphertext for display, compared in constant time, replaceable with "Generate a new secret" (the old URLs stop working at once). Treat the URL like a password. The Event Webhook is verified with **that workspace's** ECDSA verification key (header `X-Twilio-Email-Event-Webhook-Signature` over timestamp + raw body, timestamp tolerance `WEBHOOK_TOLERANCE_SECONDS`, replay stopped by remembering each signature); without a saved key the URL secret is the proof. Unknown ids, wrong secrets and bad signatures all answer `401`. Inbound mail is only accepted for addresses registered to that workspace, and events only update that workspace's messages.

### SendGrid caveats

- New SendGrid accounts and free plans have sending limits and may be reviewed before sending; plans, quotas and pricing are in SendGrid's own documentation **(not verified here)**. A 403 mentioning credits/limit is mapped to "no sending credits left".
- Open tracking is enabled on every message (existing behaviour); disable it in SendGrid if you do not want read receipts.

## 5. Guards

| Guard | Value |
| --- | --- |
| verify / import / list numbers | `channels.verify`, 6 per minute per user (each is a call to the provider) |
| test send | `channels.test`, 10 per workspace per hour, fail-closed |
| daily sends | the existing plan tiers `sms.workspace` / `email.workspace`, and per-number / per-sender pacing |
| inbound events | `webhook.connection` per connection id, 20/s with a burst of 100, plus `webhook.provider` per IP and the `webhook.badsig` block |
| provider time budget | `PROVIDER_TIMEOUT_MS` (15 s default) on every call; a timeout on a send is retried with backoff, on a verify it changes nothing |

Audit log entries (never containing credentials): `channel.connected`, `channel.verified`, `channel.test_sent` (masked recipient), `channel.numbers_imported`, `channel.senders_imported`, `channel.settings_changed`, `channel.secret_rotated`, `channel.disconnected`.

## Smoke test

```bash
# read-only: account, numbers, key scopes, verified senders, authenticated domains
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... SENDGRID_API_KEY=SG.... npm run smoke:channels --prefix server
# and send ONE real text and ONE real email (may cost money; trial accounts reach verified numbers only)
SMOKE_SEND=1 SMOKE_SMS_FROM=+1... SMOKE_SMS_TO=+1... SMOKE_EMAIL_FROM=you@yourdomain SMOKE_EMAIL_TO=you@example.com \
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... SENDGRID_API_KEY=... npm run smoke:channels --prefix server
```

Credentials are read from environment variables only, never from a file, and only masked hints are printed. Exit code 0 = every check passed.

## 7. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| "Test mode: not sent" on messages | no provider connected; Settings > Channels > connect |
| Verify says "rejected the Account SID / Auth Token" | wrong or rotated token; paste again (a rotated token also invalidates webhook signatures until you do) |
| Verify answers 502 "did not answer" | provider outage or network; nothing was changed, try again |
| Texts fail with "trial account" | recipient not verified in Twilio, or upgrade the account |
| Inbound texts never appear; Check webhook shows nothing | Twilio webhook URL not set or points elsewhere; the URL must be the one shown, over `https`, and `PUBLIC_URL` must be your public address (it is part of the signature) |
| Check webhook shows "rejected" | signature mismatch: wrong Auth Token saved, or `PUBLIC_URL` differs from the URL Twilio calls (proxy, http vs https, trailing path) |
| Check webhook shows "ignored" | the To number / inbound address is not registered in this workspace |
| Email fails with "verified Sender Identity" | verify the sender or authenticate the domain in SendGrid, then import senders |
| Replies by email do not arrive | MX record missing or not propagated; Inbound Parse host not added; secret rotated and URL not updated |
