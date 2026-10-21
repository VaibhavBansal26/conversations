# Roles, permissions and sessions (RBAC)

Access is decided by **permissions** (`resource:action` strings). A **role** is a set of permissions; a member has exactly one role. The same `can(actor, permission)` check guards REST routes and Socket.IO events, and the role is always read from the database, never from the token, so a demotion or removal takes effect on the next request or socket event.

## Permission catalogue

Source of truth: `server/src/authz/permissions.ts` (a test checks that the built-in roles seeded in the database equal the definitions in code, and that every permission guards at least one route, event or API-key scope).

| Permission | Allows | Owner | Manager | Agent | Viewer |
| --- | --- | --- | --- | --- | --- |
| `conversations:read` | See conversations in scope | yes | yes | yes | yes |
| `conversations:reply` | Send messages and notes, change status, snooze, assign to self | yes | yes | yes |  |
| `conversations:assign` | Assign conversations to other seats and inboxes | yes | yes |  |  |
| `conversations:delete` | Delete conversations and other people's messages | yes | yes |  |  |
| `contacts:read` | See contacts | yes | yes | yes | yes |
| `contacts:write` | Create and edit contacts and notes | yes | yes | yes |  |
| `contacts:import` | Import contacts from CSV | yes | yes |  |  |
| `contacts:delete` | Delete contacts | yes | yes |  |  |
| `inboxes:manage` | Create and edit inboxes and their members | yes | yes |  |  |
| `members:read` | See the team | yes | yes | yes | yes |
| `members:manage` | Add, edit and remove team members | yes | yes |  |  |
| `roles:manage` | Create custom roles and change member roles | yes |  |  |  |
| `settings:read` | See workspace settings | yes | yes | yes | yes |
| `settings:write` | Change workspace settings | yes | yes |  |  |
| `channels:manage` | Manage SMS numbers, email senders, inbound addresses and the Twilio / SendGrid connections | yes | yes |  |  |
| `tokens:manage` | Manage widget embed tokens | yes | yes |  |  |
| `templates:manage` | Manage reply templates | yes | yes |  |  |
| `kb:manage` | Manage the knowledge base | yes | yes |  |  |
| `ai:use` | Use AI assistance | yes | yes | yes |  |
| `billing:manage` | See and change plan, credits and payment methods, connect a Stripe account | yes |  |  |  |
| `payments:request` | Send payment requests to customers in a conversation | yes | yes | yes |  |
| `analytics:read` | See analytics | yes | yes |  | yes |
| `analytics:export` | Export analytics data | yes | yes |  |  |
| `analytics_identity:manage` | View, set (import) or rotate the analytics identity pepper | yes |  |  |  |
| `api_keys:manage` | Create and revoke API keys | yes | yes |  |  |
| `audit:read` | Read the audit log | yes | yes |  |  |
| `team_chat:use` | Use team chat: read and write in channels you belong to and direct messages, join public channels, react, search | yes | yes | yes | yes |
| `team_chat:manage_channels` | Create, rename and archive team channels and manage who is in them | yes | yes |  |  |
| `team_chat:moderate` | Delete other people's team chat messages | yes | yes |  |  |
| `tickets:read` | See tickets (episodes of support) of the conversations in scope | yes | yes | yes | yes |
| `tickets:write` | Edit tickets (subject, priority, tags, status), reopen them and take them over from the AI agent | yes | yes | yes |  |
| `tickets:close` | Resolve and close tickets, one by one or in bulk | yes | yes | yes |  |
| `tickets:merge` | Merge duplicate tickets of one conversation | yes | yes |  |  |
| `departments:manage` | Configure departments: hours, routing mode, capacity, service levels, skills and the routing rules | yes | yes |  |  |
| `agents:manage` | Create and configure AI support agents, try them in the sandbox, review their transcripts and the questions they could not answer | yes | yes |  |  |
| `calls:make` | Place voice and video calls to visitors from a conversation and take call requests | yes | yes | yes |  |
| `calls:settings` | Switch calls on, choose the TURN provider and the phone-call limits | yes | yes |  |  |
| `calls:internal` | Place and take voice and video calls with teammates, from team chat and the member list | yes | yes | yes |  |

*Agent* additionally sees only the conversations assigned to them or their inboxes (`inbox_visibility`), whatever permissions they hold; *Manager*, *Owner* and *Viewer* see every conversation of the workspace.

## Roles

* Four **built-in roles** (Owner, Manager, Agent, Viewer) are immutable: the API refuses to edit or delete them (`403 ROLE_IMMUTABLE`) and database triggers reject `UPDATE`/`DELETE` of system rows even from a script.
* **Custom roles** (`POST /api/roles`) pick any permissions plus a `base_role` (`manager` = sees all conversations, `agent` = sees assigned ones). A role in use cannot be deleted (`409 ROLE_IN_USE`).
* **No privilege escalation**: nobody can create or edit a role, invite, or change a member's role to grant a permission they do not hold themselves (`403 PRIVILEGE_ESCALATION`). Only an owner can make or change an owner, and a workspace always keeps at least one owner (`LAST_OWNER`).
* Role changes, role creation/update/deletion, member removal, API key changes and every sign-in-related event are written to the **append-only audit log** (`GET /api/audit`, permission `audit:read`; triggers reject `UPDATE` and `DELETE`).

## Enforcement: deny by default

`server/src/authz/routePerms.ts` declares, for every REST route, one of: a permission, `authed` (any signed-in team member: own profile, notifications), `public` (visitors, provider webhooks, unauthenticated auth endpoints), `apikey` (analytics API) or `platform` (the [platform console](ADMIN.md), which has its own rules). A route without a declaration is refused with `403 NO_POLICY`, and tests fail the build when a registered route is missing from the table, when a declared route does not exist, and when the authorisation and rate-limit tables disagree. `EVENT_ACCESS` does the same for socket events. A role-by-route matrix test sends a request for every protected route as an owner, manager, agent and viewer and requires `403 PERMISSION_DENIED` exactly when the role lacks the permission. Visitor sockets are authorised by their session scope, not by roles.

## Sessions and tokens

| | |
| --- | --- |
| Access token | short-lived JWT (`ACCESS_TOKEN_TTL_SECONDS`, default 15 minutes) carrying the member id and the session id; the seat is re-read on every request |
| Refresh token | opaque, 30 days, **single use and rotated**: each refresh returns a new one. Presenting an already-used refresh token is treated as theft: the whole session is revoked (`REFRESH_REUSED`) and an audit row is written. Two concurrent refreshes with the same token cannot both succeed (conditional update) |
| Revocation | logout, password change, password reset and workspace suspension revoke sessions (a removed member stops working at once because the seat is re-read); a revoked session stops working immediately, not when the access token expires (`GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`) |
| Two-factor (TOTP) | optional per user: `POST /api/auth/mfa/setup` then `/enable` returns 10 single-use recovery codes. A code is accepted once per 30-second step. Sign-in becomes two steps (`mfa_required` + `POST /api/auth/mfa/verify`). Disabling needs password and code |
| Password reset | emailed single-use link, 60 minutes; the request never reveals whether the address exists; resetting revokes every session |
| Invitations | `POST /api/invitations` emails a link valid 7 days that joins with exactly the invited role; a wrong password on an existing account does not burn the invitation |
| Lockouts | failed logins: 5 per account in 15 minutes locks the account (escalating 1 min, 5 min, 30 min, 24 h), 20 per IP blocks the address; wrong second-factor codes: 5 per user in 15 minutes. Details in [RATE-LIMITING.md](RATE-LIMITING.md) |
| API keys | `ca_live_...`, only the SHA-256 is stored, scopes limited to the creator's own permissions, optional expiry and IP allow-list (see [ANALYTICS.md](ANALYTICS.md)) |

Passwords are hashed with scrypt; the login path takes the same time for unknown emails.

## Read-only support access

A platform operator can mint a 15-minute token for a workspace seat whose permission set is capped to read permissions and which refuses every non-GET request: see [ADMIN.md](ADMIN.md). Such tokens carry an `imp` claim.

## Tests

`server/tests/rbac.test.ts` (declaration coverage, role-by-route matrix, viewer/agent scoping, escalation, immutability, socket events), `accounts.test.ts` (sessions, rotation and reuse detection, MFA, reset, invitations, lockouts), `web/src/pages/LoginPage.test.tsx` and the settings pages for the UI.
