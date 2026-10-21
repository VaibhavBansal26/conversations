# Team chat

Internal chat for the people of one workspace: **channels** (public to the workspace, or private and invite-only), **direct messages** (1:1, or with yourself), **group messages** (3 to 8 people), threads, @mentions, emoji reactions, pinned messages, attachments, search, typing indicators, unread counts and live delivery. It is separate from customer conversations (which stay in the Inbox) and from internal notes inside a customer thread. Decision record: [ADR 0021](adr/0021-team-chat.md); realtime events: [REALTIME.md](REALTIME.md#team-chat); permissions: [RBAC.md](RBAC.md); REST: [API.md](API.md) (tag "Team chat").

## Using it

Open **Team** in the navigation (the badge counts unread messages, or mentions when you have any). The left column lists channels and direct messages with unread counts and presence dots; `+` starts a message, creates a channel (managers) or browses public channels you have not joined.

| You want to | Do |
| --- | --- |
| message someone | `+` > New message, pick one person (or up to seven for a group). The same people always open the same conversation |
| start a channel | `+` > Create a channel (needs `team_chat:manage_channels`: Owner and Manager). Public: everyone can find and join it; private: only people you add |
| reply in a thread | hover a message > Reply in thread. Threads are one level deep; the channel shows "N replies" |
| mention | type `@` and pick a person, or `@channel` / `@here` for everyone in the channel. A mention notifies even in a muted channel (by name) |
| react | hover a message > the smiley; click an existing reaction to toggle yours |
| edit, delete | your own messages (More actions, or ArrowUp in an empty box to edit your last one). Moderators (`team_chat:moderate`) can delete anyone's |
| pin | hover > pin. Pinned messages are listed under the pin button of the header |
| attach files | the paperclip, paste, or drop. Same type checks and size limit as customer attachments (`UPLOAD_MAX_BYTES`) |
| search | the magnifier: messages in your channels and in public channels, newest first |
| share a customer conversation | in the Inbox: More actions > Share with the team. The card opens the conversation for teammates who may see it; everyone else sees "You do not have access to it" and nothing else (no name, no text) |
| quiet a channel | Details > Mute. You still hear about @mentions of your name |

Keyboard: `Alt+Up` / `Alt+Down` previous / next conversation, `Alt+Shift+Up` / `Down` next one with unread, `Enter` sends, `Shift+Enter` new line, `Esc` closes the thread or panel.

## Rules worth knowing

- **Privacy.** A private channel, a direct message and a group message exist only for their members: every other member gets `404` on REST and sockets, search never returns them, and removing someone from a private channel stops live delivery to them at once. Managers do not get access to private channels they are not in.
- **#general** is created for every workspace; everyone is in it and it cannot be renamed, archived or left (mute it instead).
- **Unread** is computed from your read cursor in each channel (never stored as a counter): messages from other people after it, excluding deleted ones. Writing moves your cursor to your own message; opening a channel moves it to the newest message; it never moves backwards. Thread replies count in the channel they belong to.
- **Notifications** use the same bell as customer notifications. A direct or group message notifies the other members (preference `team_messages`); a channel message notifies only people mentioned (preference `mentions`). A muted channel is quiet except for @mentions by name. Offline members who have email notifications on and are not in do-not-disturb get an email whose link opens the chat, like the existing rule for customer conversations.
- **Sending is idempotent** on `client_msg_id` (per channel); the server rate limits sends per member, per channel and per workspace (`team.send`, `team.channel`, `team.workspace`) and searches per member.
- **Retention.** Messages are soft-deleted; deleted ones are removed for good after 30 days. The workspace setting `team_retention_days` (0 = keep forever) deletes older messages, except pinned ones, in the daily housekeeping.
- **Roles.** Owner, Manager, Agent and Viewer hold `team_chat:use`; custom roles that could read conversations received it when this shipped. Support (impersonation) sessions are read-only.

## Limits and known gaps

No end-to-end encryption (messages are stored like all other data, see [SECURITY.md](SECURITY.md)); no edit history; no message forwarding between channels; no voice or video; file previews are images only; reactions limited to 20 kinds per message; group messages cannot gain members (start a new group); searching uses a plain substring match (no ranking, no stemming), as customer message search does. The message list is virtualised in the web app; a channel with hundreds of thousands of messages pages by `seq` cursors on the server, but this has not been load tested beyond the query-plan checks in `team-chat.plans.test.ts` (60 channels, 18,000 messages on SQLite and PostgreSQL).
