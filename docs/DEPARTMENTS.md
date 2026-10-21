# Departments, routing and handoff

A **department** is an inbox with routing configuration: opening hours and holidays, how a ticket is given to a person, how many tickets a person may hold, service levels, an overflow department, the texts a visitor reads, and the skills and languages of its people. There is no separate table: every inbox is a department, and an inbox nobody configured behaves exactly as before ([ADR 0028](adr/0028-departments-are-inboxes.md)). The AI agent and the widget use the same engine; this page describes it. For tickets see [AI-AGENTS.md](AI-AGENTS.md).

## Configuration

Settings > **Departments & routing** (`departments:manage`, Owner and Manager), or `PATCH /api/departments/:id` ([API.md](API.md), tag "Departments"). Every change is audited (`department.updated`).

| Field | Meaning |
| --- | --- |
| `description` | shown to visitors who pick a department and used by the AI agent to place a question |
| `live_routing_visibility` | offered in the widget's department picker (the inbox flag that already existed) |
| `routing_mode` | `round_robin`, `least_busy`, `skills_based`, `manual_pick`; `null` follows the inbox's `algorithm` (`round_robin` stays round robin, `manual` reads as manual pick) |
| `capacity` | most open tickets per person at once (0 = unlimited); a member's own `capacity` overrides it |
| `hours` | `{enabled, timezone, days: [{day, start, end}], holidays: ["YYYY-MM-DD"]}`; disabled and no holidays = no restriction from the department |
| `sla_first_response_s`, `sla_resolution_s` | service levels (see below) |
| `overflow_inbox_id` | where a ticket goes when this department is closed or nobody here can take it; loops are refused (`OVERFLOW_LOOP`) |
| `auto_reply_closed`, `auto_reply_queued` | replace the default text a visitor reads |
| members | `skills` (free text, e.g. `billing`), `languages` (`en`, `pt-br`), `capacity` |

Opening hours are judged in the department's own time zone: the start minute is inside, the end minute is not, a holiday closes the whole local day (in that zone) whatever the weekly schedule says, and daylight saving follows the zone (tested around Berlin's switch on 2026-03-29 and across the date line for Tokyo).

## Who is available

A person can take a ticket now when all of these hold: a live seat, availability `active`, no do-not-disturb, not removed, and (workspace setting `routing.require_online`, default on) connected right now. The seat's open load is the number of live tickets it is the handler of in `waiting_for_human` or `open`; tickets waiting for the customer do not count. A person under their capacity (their own, else the department's) is a candidate.

## Routing a ticket

`routeTicket` picks the department (the ticket's, else the widget's default inbox, else the whole workspace as one pool), then walks the overflow chain with a visited set:

1. department closed (hours, holiday): overflow if configured, otherwise the ticket queues there and the visitor is told when it reopens;
2. mode `manual_pick`: nobody is assigned, the ticket waits and people **claim** it (the first claim wins, `409 TICKET_TAKEN`);
3. otherwise candidates are chosen by the mode: **round robin** continues after the person this department last gave a ticket to (even when that person is busy or away right now, so the rotation stays fair); **least busy** takes the lowest load, ties continue after the pointer; **skills based** wants every skill the ticket needs plus the visitor's language, falls back to the best partial match, and then to least busy (recorded as `skills_fallback` in the routing event);
4. nobody can take it: overflow if configured, otherwise the ticket queues in the last department of the chain.

The result is written in one transaction: ticket (`status = waiting_for_human`, `handler`, `department_id`, `handoff_at`), the room's inbox and its single assignee, the pointer, and a `routed` or `queued` ticket event with mode, path and reason. The person who gets it sees an in-app notification (and the usual offline email); while a ticket queues, the department and the managers are notified. Later a person's first reply accepts it (`open`).

### Race safety

Every routing decision runs inside a transaction that first takes a per-workspace lock (`SELECT ... FOR UPDATE` on the workspace's `ticket_counters` row on PostgreSQL; SQLite's single writer already serialises). Inside it the loads are read and the assignment written, so two handoffs at the same moment cannot push a person over capacity, a person who sits in two departments is counted across both, and a ticket is assigned once. Routing a ticket that already has a person (or is already queued the same way) changes nothing and says nothing: a repeated handoff, a queue pass and the SLA sweep are all idempotent. Tests: 20 parallel handoffs over 3 people with capacity 5 give exactly 15 assignments with every load at 5; 8 handoffs for a person in two departments never exceed capacity; 6 handoffs of one ticket give one assignment and one explanation; four claims racing give one winner (SQLite and PostgreSQL).

### The queue

A ticket nobody can take stays `waiting_for_human` with no handler. It is given out, oldest first, when a person becomes free: a ticket they were working ends (resolve, close, room close), a person becomes active or leaves do-not-disturb, a department's capacity, members or hours change, and every minute by the scheduler. The visitor is told once ("Everyone on our Support team is busy right now. You are number 3 in the queue. Typical wait: about 4 min.") and again when someone picks the ticket up. The typical wait is the median over the department's last 20 handed-off tickets that were answered in the last 7 days; with no data it says nothing about the wait.

### When a person goes away

Tickets assigned to a person who has not answered yet (`waiting_for_human`) go back through routing without them when they set themselves away or inactive, start do-not-disturb or lose their live seat. Tickets they accepted (`open`) stay with them. Removing a person hands over everything they had. Each reassignment is audited (`ticket.reassigned`).

### Service levels

A ticket is armed when it opens (resolution) and when it is handed off (first response); a transfer restarts the first-response clock of the new department. The scheduler escalates a ticket still waiting for its first human reply after `sla_first_response_s`: once, it raises the priority a step, offers the ticket to someone else (excluding the person who did not answer) or to the overflow department, records `sla_breached`, and notifies managers. A ticket past `sla_resolution_s` is recorded and reported, never moved.

### Transfer between departments

`POST /api/tickets/:id/transfer` (agents, `tickets:write`) and the AI agent's `set_department` action route the ticket into another department, move the room there, restart the first-response clock, leave an internal note ("Transferred from Support to Billing. <note>"), tell the visitor, and record `ticket.transferred` in the audit log. Ended tickets cannot be transferred.

## Choosing the department of a new conversation

In this order: **(a)** the department the visitor picked (`department_id` on `POST /public/rooms`; only departments marked visible in the widget), **(b)** the first matching **routing rule**, **(c)** the widget's default inbox. The AI agent can also classify and ask the visitor to confirm ([AI-AGENTS.md](AI-AGENTS.md)).

Routing rules (Settings > Departments & routing > Routing rules; `/api/routing-rules`) are an ordered list; all conditions of a rule must hold and the first enabled matching rule wins. Fields: `page_url`, `locale`, `channel`, `tag` (contact tag), `email_domain`, `attr` (a contact attribute, including the app attributes sent through `POST /public/session/attributes`); operators `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `exists`. Matching is plain case-insensitive text, with no regular expressions, so nothing a workspace types can make matching slow; at most 50 rules and 5 conditions per rule. A sandbox (`POST /api/routing-rules/test`, "Try the rules" in the UI) says which department a conversation like this would reach and which rules were looked at. The page address is stored without query string and fragment (they can carry tokens) as `rooms.meta.context` together with the browser language.

## API and permissions

`GET/PATCH /api/departments*`, `GET /api/department-status` (names and counts of every department, for the transfer menu), `/api/routing-rules*`, `POST /api/tickets/:id/claim|transfer`. `departments:manage` guards the configuration (Owner and Manager); `tickets:write` guards claim and transfer. See [RBAC.md](RBAC.md).

## Not built

* SMS to a department when nobody is available (the in-app notification and the existing offline email are built; members have no phone number to text).
* Per-department holidays imported from a calendar; holidays are typed dates.
* Weighted or percentage routing, and routing by customer value.
