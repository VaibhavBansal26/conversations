# Copies of a conversation by email (transcripts)

A visitor can get a copy of their conversation by email; a team member can send one from the conversation; the AI agent can send one when asked; and a workspace can send one automatically when a ticket is resolved. **Off by default** (Settings > Tickets > *Copies by email*, `settings.transcripts`). Code: `server/src/services/transcripts.ts`.

## Who gets it

**Only the email address of the contact of this conversation, and only when that address is confirmed for the visitor.** Confirmed means one of:

- the visitor's session is verified: they entered the code we sent to that address or phone (the existing OTP check), or the site signed their identity ([ADR 0025](adr/0025-signed-visitor-identity.md));
- they gave the address in this conversation through the details form, **with consent** (the consent text of Settings > Visitor details is recorded on the contact).

An address typed in the pre-chat form is not trusted by itself (anyone can type anyone's address): the visitor is asked for a code first (`409 VERIFY_EMAIL_FIRST`, the chat opens the code screen and sends the copy after a correct code). A visitor with no address gets the details form in the chat (`409 EMAIL_REQUIRED`). An address that already belongs to **another** contact is never linked (the existing rule of the details form keeps it as `unverified_email`), so a copy never goes to it. A team member sends to the contact's own address on file (`conversations:reply`). The AI tool follows the visitor rules.

## What it contains

What the visitor saw in the conversation (up to 500 messages): their messages, the team's and the AI's answers (the AI marked "(AI)"), the customer-facing system lines, attachments by file name. **Never**: internal notes, internal system lines (assignments, AI actions, "the AI did not answer" lines, previous copies), anything about how the AI decided (turn records, confidence, sources are not messages). With *Hide personal data in copies* on, or the AI setting *Redact personal data* on, email addresses, phone and card numbers are masked.

The email comes from the workspace's default verified sender (else the server's `SYSTEM_EMAIL_FROM`) through the workspace's own SendGrid connection (else the platform default), subject "Your conversation with <workspace> (#<ticket>)", with a footer:

- asked for: "You receive this copy because it was asked for in this conversation with <workspace>. It is a one-time copy, not a subscription."
- automatic: "You receive this copy because <workspace> sends one after a conversation is resolved. To stop these copies: <link>". The link (`GET /public/transcripts/unsubscribe/:token`, HMAC-signed per contact, the same page for any link) marks the contact as unsubscribed; automatic copies stop, copies they ask for still work.

Copies carry `Auto-Submitted` (RFC 3834), so auto-responders do not answer them.

## Limits, audit, test mode

- 3 copies per contact per hour, whoever asks (`transcript.contact`); 20 per team member per hour (`transcript.member`).
- One automatic copy per ticket (a unique index), only to a confirmed address of a contact who did not unsubscribe; sent in the background after the resolution, or as soon as the visitor gives an address in the `after` details form.
- Every send: a row in `transcript_sends` (who asked, an address hint "a…@example.com", the result, the number of messages; migration 044), an audit entry `transcript.sent` (hint only, never the full address) and an internal line in the conversation for the team.
- **Test mode is honest**: without a connected email provider the copy is recorded as `not_sent_test_mode`, the visitor sees "Test mode: the copy was not sent." and the team "Not sent: test mode".

## Where it appears

| Place | What |
| --- | --- |
| Widget and hosted chat | "Email me a copy" under the conversation once the visitor wrote something (translated in the hosted chat's five languages), the result in a status line |
| Inbox | conversation menu > "Email a copy to the contact" (when the contact has an email), and the internal line in the thread |
| AI agent | the allowed action `send_transcript` (off for agents created before it existed: add it in the agent's actions) |
| Settings > Tickets > Copies by email | *Visitors can ask for a copy*, *Also send a copy when a ticket is resolved*, *Hide personal data in copies* |

| Route | Who | Effect |
| --- | --- | --- |
| `POST /public/rooms/:id/transcript` | the visitor of that conversation | `{status: sent \| not_sent_test_mode, to, messages}`, or `EMAIL_REQUIRED`, `VERIFY_EMAIL_FIRST`, `TRANSCRIPTS_DISABLED`, `429` |
| `POST /api/rooms/:id/transcript` | `conversations:reply` | the same, to the contact's address on file (`CONTACT_EMAIL_REQUIRED` without one) |
| `GET /api/rooms/:id/transcripts` | `conversations:read` | the copies sent from this conversation |
| `GET /public/transcripts/unsubscribe/:token` | anyone with the link | stop automatic copies |

**Verified**: `server/tests/transcripts.test.ts` (SQLite and PostgreSQL): off by default, the form when there is no address, a code for a typed address, never another contact's address, contents (no notes, no internal lines, no AI reasoning, masking), the per-contact limit, test mode, the team's send (permission, other workspace, no address, audit hint), the automatic copy once per ticket, unconfirmed addresses, the option off, the unsubscribe link and a forged one, the AI tool; migration 044 upgrade tests; jsdom tests of the widget and the settings; `e2e/tests/19-transcripts.spec.ts` in Chrome against the built server (test mode). **Not verified**: delivery through a real SendGrid account, how the email looks in real mail clients, spam filtering.
