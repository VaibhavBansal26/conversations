# AI support agents, tickets, departments, visitor details and calls

This document describes the support-automation layer that sits on top of the inbox: **tickets** (an episode of support inside a conversation), **AI agents** that answer first and hand over to people, **departments** and routing, **visitor details** collected in the widget, and **voice and video calls** between an agent and a visitor. It is written feature by feature as each one lands; the section "Status" at the end says what exists, what is only scaffolded and what was never run against a real service.

Vocabulary: a *room* (the UI says *conversation*) is the one thread per contact; a *ticket* is one issue inside it. See [GLOSSARY.md](GLOSSARY.md) and [ADR 0027](adr/0027-tickets-inside-rooms.md).

## 1. Tickets

### What a ticket is

A room stays one per contact (unchanged rule). A ticket opens with the first message of an issue and ends when it is resolved. Closing a ticket never closes the room; closing the room resolves its live ticket. At most one ticket per room is *live* (not `closed`), enforced by the partial unique index `ux_tickets_room_live`, so two simultaneous first messages converge on one ticket (tested on SQLite and PostgreSQL).

| Field | Meaning |
| --- | --- |
| `number` | human-friendly, per workspace, starts at 1, allocated by one `INSERT ... ON CONFLICT ... RETURNING` on `ticket_counters` (rolls back with the transaction, never repeats) |
| `subject` | the first line of the customer's first message until someone edits it (`subject_set_by` becomes `agent`) |
| `status` | `new`, `bot_handling`, `waiting_for_human`, `open`, `pending_customer`, `resolved`, `closed` |
| `handler` | `bot:<agent id>`, `human:<member id>` or null |
| `department_id` | the room's inbox when the ticket opened (departments: section 2 once built) |
| `priority` | 0 low, 1 normal, 2 high, 3 urgent (a priority conversation opens a high ticket; AI triage with urgency 0.8 or more raises it) |
| `resolution` | `bot_resolved`, `human_resolved`, `abandoned`, `auto_closed`, `merged` |
| timestamps | `opened_at`, `first_response_at` (anyone, bots included), `first_human_response_at`, `handoff_at`, `resolved_at`, `closed_at` |
| `csat`, `csat_comment` | the customer's rating of this ticket |
| `tags`, `summary`, `handoff_reason`, `merged_into_id`, `channel` | as named |

Every message carries `ticket_id` (`messages.ticket_id`). Messages written before the feature existed keep `NULL`, and so do lines written before a conversation's first issue (the "Conversation started" line, an away message). There is no backfill: a room opens its first ticket with its next message (verified by an upgrade test on a populated database, [TESTING.md](TESTING.md)).

### Lifecycle

```mermaid
stateDiagram-v2
  [*] --> new: first customer message (or a person writes first: open)
  new --> bot_handling: AI agent takes it
  new --> waiting_for_human: handoff
  new --> open: a person replies
  bot_handling --> waiting_for_human: handoff
  bot_handling --> open: a person replies (implicit takeover)
  waiting_for_human --> open: a person replies
  open --> pending_customer: agent marks it
  pending_customer --> open: customer replies
  open --> resolved
  bot_handling --> resolved: confirmed, or idle (abandoned)
  pending_customer --> resolved: idle (abandoned)
  resolved --> open: customer replies inside tickets.reopen_hours
  resolved --> closed: after tickets.close_resolved_hours, or a later reply opens a new ticket
  closed --> [*]
```

* **Opens**: the first contact message when no ticket is live (any channel: chat, SMS, email); an agent's first message in a room with no live ticket opens a human ticket (`open`, counted as answered).
* **Answers**: a human reply moves `new`, `bot_handling` and `waiting_for_human` to `open` and makes that person the handler; replying to a bot ticket is an implicit takeover and is recorded as `taken_over`. Bot messages only record `first_response_at`. Notes and system lines attach to the live ticket but never open, answer or reopen one.
* **Resolves**: an agent (`POST /api/tickets/:id/resolve`), the room being closed by a person, or the idle sweep. The customer sees the closing message with a 1 to 5 rating card (`tickets.closing_message`, `tickets.csat_prompt`); the card is a visitor-visible system line (`meta.sub_type = "ticket_resolved"`, `meta.card = {type: "csat", ticket_id}`).
* **Reopens**: a customer message on a `resolved` ticket within `tickets.reopen_hours` (default 72) reopens the same ticket (same number); later it closes that ticket (keeping the resolution it earned) and opens a new one. A person replying to a resolved ticket reopens it too.
* **Closes**: `POST /api/tickets/:id/close`, or the sweep after `tickets.close_resolved_hours` (default 72). A ticket nobody answered closes as `auto_closed`, one only the bot answered as `abandoned`, otherwise it keeps its resolution.
* **Idle sweep** (scheduler, every minute, bounded to 200 per pass): `bot_handling` tickets quiet for `tickets.bot_idle_minutes` (default 30, 0 = off, minimum 5) and `pending_customer` tickets quiet for `tickets.pending_idle_hours` (default 72, 0 = off) are resolved as `abandoned` with the closing message. Tickets a person is handling (`open`) are never auto-resolved.
* **Merge** (`tickets:merge`): a duplicate is merged into another ticket **of the same conversation** (a conversation has one live ticket, so duplicates arise from the reopen window): its messages move over, it closes as `merged`, the earlier opening and first response survive. Merged tickets cannot be reopened or rated.

Rating: `POST /public/rooms/:id/ticket-csat` rates the latest ended ticket (or the one named) once; `GET /public/rooms` carries `ticket: {id, number, status, resolved, csat_pending}` for the widget. The visitor never sees handler, department or tags.

### API, permissions, realtime

Routes are under `/api/tickets` (list with filters and keyset paging, counts, detail with event timeline, edit, resolve, close, reopen, merge, bulk) plus `/api/rooms/:id/tickets` and `/api/contacts/:id/tickets` ([API.md](API.md), tag "Tickets"). A ticket follows the visibility of its conversation: an agent sees the tickets of the rooms they can see, anything else is `404` (and so is another workspace). Permissions: `tickets:read`, `tickets:write` (edit, reopen), `tickets:close` (resolve, close, bulk) and `tickets:merge`; the Agent role has the first three, the Viewer role `tickets:read`; custom roles that could read or reply keep that ability ([RBAC.md](RBAC.md)). The room list, `GET /api/rooms/:id` and every room event carry the live ticket (`room.ticket`), the room list filters on it (`ticket_status`, `ticket_handler`, `department_id`), and `ticket:updated` ([REALTIME.md](REALTIME.md)) tells the team the full ticket and the visitor the minimal one.

### In the app

Thread header: the ticket chip (`#12 Open`) is a menu (resolve, close, reopen, waiting for the customer, priority). Contact panel: a Tickets section with the history. **Tickets** page (`/tickets`, `tickets:read`): counts by status, filters (status, handler, department, number or subject; the URL keeps them), a table or cards on phones, multi-select and bulk resolve or close. Settings > Tickets: the numbers above, the closing message and the rating prompt.

### Data

Migration 027 (`tickets`, `ticket_events`, `ticket_counters`, `messages.ticket_id`) and 028 (permissions) are additive: no table is rebuilt and nothing touches the SQLite schema tables ([ADR 0023](adr/0023-sqlite-migrations-defensive-mode.md)). Retention (`retention_days`) and workspace erasure delete tickets and their events together with the messages; the archive keeps `ticket_id` on restored messages.

## 2. Departments, routing and handoff

Departments are inboxes with routing configuration; the engine that gives a ticket to a person (modes, capacity, hours and holidays, overflow, the queue, service levels, transfer, routing rules) is described in [DEPARTMENTS.md](DEPARTMENTS.md) and [ADR 0028](adr/0028-departments-are-inboxes.md). This is what the AI agent calls when it hands a conversation to a person, and what an agent's "transfer" button calls. Handoff reasons are recorded on the ticket (`handoff_reason`, the `handoff` event): `customer_requested_human`, `low_confidence`, `no_answer`, `repeated_rephrase`, `negative_sentiment`, `high_urgency`, `sensitive_topic`, `tool_failure`, `vip_contact`, `outside_hours`, `max_turns`, `transfer`, `agent_unavailable`, `agent_removed`, `sla_escalation`, `queue_drain`. A handoff leaves the person an internal note (reason, department, who got it, what the caller wants them to know) and tells the visitor what happens next: connecting you with a team and the typical wait, the place in the queue, or when the department reopens.

## 3. AI support agents

An AI agent answers the visitor's first messages of a ticket from the workspace's knowledge base, asks for details when it cannot, and hands the ticket to a person when it should. It exists for the chat widget and the hosted chat; SMS and email replies by an agent are not built (they would go through the delivery pipeline and its credits). Up to five agents per workspace, each with a name, a persona, a tone, languages, a greeting, departments it works for (none selected: all), hours, knowledge collections, an autonomy level, thresholds, the actions it may take, its hand-off triggers and a disclosure label. Decision record: [ADR 0029](adr/0029-ai-agent-pipeline.md).

### What happens on a visitor message

`handleCustomerMessage` runs in the background after the message is stored (the visitor's request never waits for a model). The agent that serves the conversation is the first enabled one whose departments include the ticket's (or that has none); one that is outside its hours still takes the message and hands over at once (`outside_hours`). The turn is two functions so that the sandbox runs exactly production code: `decideTurn` only reads, `applyDecision` writes.

1. **Classify** (deterministic, no model): intent words, urgency, sentiment, whether the visitor asks for a person (en, es, fr, de, ja, pt), the department the message is about.
2. **Hand-off triggers**, each switchable per agent: asks for a person; a sensitive topic (the list is the agent's setting; the default holds refunds, legal, fraud, account takeover, cancellation and similar words in five languages and is the whole list: clearing it clears it); VIP-tagged contact; upset; urgent; the same question rephrased three times; the turn limit; low confidence after `max_attempts`; the agent's hours. An injection attempt ("ignore all previous instructions", hidden-prompt requests, forged delimiters) is answered with a polite refusal once and hands over the second time (`suspicious_input`); the model never sees it.
3. **Retrieve** from the knowledge base (BM25 over question and answer, limited to the agent's collections). If nothing covers the question well enough (`coverage_threshold`) the agent asks for more detail once or twice and then hands over (`no_answer`).
4. **Ask the model** for a structured answer (`answer`, `confidence`, `intent`, `handoff`, `cited_ids`, `actions`), validated with zod. The prompt puts the product's safety rules first, then the workspace's persona, then the retrieved entries and the conversation, both delimited and declared to be data written by third parties. With no model configured, or when the model fails, times out or returns something unusable, the **rules agent** answers from the best entry instead (offline, deterministic); only when that cannot answer either does the ticket go to a person. A workspace whose daily AI budget is used up degrades the same way.
5. **Guard the answer**: banned claims (guarantees, promises, "100% secure", legal advice, asking for passwords or card numbers, claiming to be human), money or schedule commitments the knowledge base does not contain, and links that are not the knowledge-base entry's own address are removed or the answer is replaced by a hand-over (`unsafe_answer`). Confidence below `confidence_threshold` asks for details or hands over.
6. **Apply**: the bot message (sender `bot`, `meta.ai = true`, the agent's name and label, the sources as links, a quick-reply card "Did this solve it?" with Yes / No / Talk to a person), the actions, the turn record (`ai_turns`: outcome, reason, confidence, sources, tokens, latency, redacted visitor words), and the typing indicator while it works.

Autonomy: **suggest only** writes nothing to the visitor and leaves the team a private note with the drafted reply; **answer on its own** answers and hands over; **answer and resolve** also resolves the ticket when the visitor confirms ("thanks, that solved it", the Yes card) or when the model asks to and the agent may. Every resolution by an agent shows the closing message and the rating card of Settings > Tickets.

### Tools (a closed list)

`search_kb` (the agent's own retrieval, up to two calls per turn), `set_department`, `resolve_ticket`, `handoff_to_human`, and the registered-later `collect_contact_info`, `schedule_callback`, `offer_call`. The model names a tool, the server validates the arguments with zod, checks the agent's allowed actions and departments, runs it scoped to the workspace, writes an `ai_agent.tool` audit entry and shows the team a line in the conversation ("Aria (AI agent): set the department to Billing"; visitors never see these lines). There is no plugin and no free-form HTTP tool in v1; a new tool is a case in `agents/tools.ts` with its schema and its permission.

### Visitor controls and disclosure

Visitors are always told: the answer carries the agent's name and label ("AI assistant" by default), `GET /public/widget/config` returns `ai: {name, label, avatar_url}`. **Talk to a person** is always available (`POST /public/rooms/:id/request-human`), whether or not an agent is switched on: it stores the request as the visitor's message and hands the ticket off; asking again while a person has it changes nothing. Quick replies are `POST /public/rooms/:id/quick-reply`; a tap is stored as the visitor's own message, the card closes (a double tap answers once, the second gets `409 ALREADY_ANSWERED`), and the option resolves the ticket, asks the agent to try again or hands over. Thumbs up or down on an answer: `POST /public/rooms/:id/messages/:messageId/feedback`.

### Taking over and handing back

A person takes a ticket the agent is handling with the same `claim` as any queued ticket (`POST /api/tickets/:id/claim`, `tickets:write`); the agent stops at that moment and the visitor sees that a person joined. `POST /api/tickets/:id/hand-back` gives it back to the agent that serves the department (the person who has it, or a manager); the agent answers the visitor's next message. Notes and agent messages never start an agent turn.

### Sandbox and review

Settings > AI agents (`agents:manage`: owner and manager). **Try an agent**: `POST /api/agents/:id/sandbox` runs one message through exactly the production decision and reports the reply, the sources, the confidence, the hand-off and the routing it would lead to (department, mode, person), with the steps in plain words. Nothing is stored (no room, ticket, message, turn or audit entry); a model call counts against the workspace's AI budget and the per-user AI limits. **Review** lists every turn (`GET /api/agents/turns`, filters: agent, outcome, rated up or down; keyset paging) with the visitor's words, the answer, the sources and the votes of visitors and team members; team members rate answers from the conversation view (`POST /api/messages/:id/feedback`). **Unanswered** (`GET /api/agents/unanswered`) groups the questions the knowledge base could not answer (a question joins the first group it shares at least half its words with), biggest first, with a button that starts a knowledge-base entry from the question. Knowledge-base entries have an optional `collection` and `url`.

### Settings and data

Migration 031 (`ai_agents`, `ai_turns`, `ai_feedback`, `kb_entries.collection` and `url`) and 032 (permission) are additive. Turns are deleted with their ticket; feedback is kept per message and rater. With *redact personal data* on (Settings > AI assistant) emails and phone numbers are masked before text reaches a model and in the stored turn words, and the visitor's name, email and phone are not sent to the model at all.

## 4. Visitor details in the chat

The workspace chooses which details the chat collects and when (Settings > Visitor details; a department can override the three fields and the moments under Departments & routing). Each of name, email and phone is `off`, `optional` (asked, the visitor may skip), `required` or `ask_when_needed`; up to five custom fields (text or a choice) have the same modes and are stored on the contact under `attrs`. Defaults: everything off, so nothing changes until someone configures it.

- **Before the chat starts**: fields set to `required` (and the older `required_info` list) are asked in the pre-chat form, and the session refuses to start without them (`422 REQUIRED_INFO_MISSING`).
- **In the thread**: at the moments `handoff` (a ticket goes to a person), `no_agent` (nobody can take it: department closed or all busy), `callback` (a callback or call is requested) and `after` (the ticket was resolved: an email to follow up; off by default) the server puts a **form card** in the conversation with the fields that are on and that the contact lacks. A moment asks at most once per ticket, nothing is asked that is already known, and the AI agent can ask for details itself (`collect_contact_info`, limited to fields that are not `off`) or for a callback number (`schedule_callback`, phone required). The card is a structured message (`meta.card.type = "contact_form"`), never free text read out of the chat.
- **Answering**: `POST /public/rooms/:id/forms/:messageId` with `{values, consent, country, website}`. Validated on the server (and in the widget first): email syntax (lower-cased), phone parsed with libphonenumber to E.164 with the country the visitor picked (default: the browser's region, else the workspace's `default_region`), name charset and length, choice fields against their options, custom text without control characters or angle brackets, unknown keys refused; `422 INVALID_FORM` with `details.errors` per field. When the workspace asks for consent, a checkbox (with an optional privacy-policy link) is required before an email or phone is saved; its text and time are kept on the contact. `website` is a honeypot: a filled one stores nothing and reports success. `POST .../skip` closes an optional card. A card is answered once (`409 ALREADY_ANSWERED`), also under two submits at once.
- **Contacts**: the details go to the visitor's own contact. If an email or phone already belongs to **another** contact, it is not linked: it is kept as `attrs.unverified_email` / `unverified_phone` for the team, the response is the same as for a new address (nothing reveals that it exists) and no history is shared. Linking to an existing contact stays with the signed identity and the OTP checks of the session. The visitor's message shows what was shared (names of fields, not values), the team gets a line in the conversation, `info_requested`, `info_submitted` and `callback_requested` events on the ticket, and an audit entry with the field names.
- **Privacy**: values reach a language model only when the workspace does not redact personal data (the existing `ai_redact_pii` setting), and never appear in logs.
- **In the apps**: the widget and the hosted chat render the card (labels, errors with `role=alert`, a country picker next to the phone field, consent, skip; a half-filled card survives incoming messages). The hosted chat is translated into en, es, fr, de and ja and tells the host app with the bridge events `form_requested`, `contact_info_submitted` (field names only), `handoff_started` and `agent_joined` ([MOBILE-BRIDGE.md](MOBILE-BRIDGE.md)).

Not built: sending a transcript by email (the `after` moment asks for an address to follow up, it does not send anything), custom fields in the pre-chat form, and per-department consent text.

## Status

| Part | State |
| --- | --- |
| Tickets (section 1) | built and tested on SQLite and PostgreSQL; the widget and the hosted chat render the rating card |
| Departments and the handoff engine (section 2) | built and tested on SQLite and PostgreSQL including parallel handoffs; nothing here talks to a real mail or SMS provider beyond the existing offline email job |
| AI agents (section 3) | built and tested on SQLite and PostgreSQL with scripted models and the offline rules agent: pipeline, guards, hand-off triggers, tools, quick replies, take over and hand back, sandbox, review, unanswered questions, widget and hosted chat UI, settings UI. **Not verified against a real LLM**: the prompt and the JSON contract are exercised only with scripted providers, so answer quality, latency and token use with a real model are unmeasured. SMS and email agent replies and streaming of answers are not built |
| Visitor details (section 4) | built and tested on SQLite and PostgreSQL (settings, moments, validation, contact conflicts, honeypot, races) and in the widget under jsdom; the hosted chat form is covered by the browser tests only; the native iOS and Android SDK decoders were not updated for the four new bridge events (they are additive, old hosts ignore them) |
