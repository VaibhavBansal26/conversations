# Provenance of the web UI

The 2026-10 web redesign (Tailwind CSS v4, headless primitives, see [adr/0017-tailwind-and-headless-primitives.md](adr/0017-tailwind-and-headless-primitives.md)) took ideas, interaction details and edge cases from the legacy conversations UI that this product replaces. The legacy product is proprietary; its owner confirmed to the maintainer that they may use and publish it. This file records what was taken so that it stays auditable.

## What "adapted" means here

- **No legacy source file was copied.** The legacy code is React + MUI-like in-house components + SCSS + Draft.js + wavesurfer + a pub/sub bus, and it is coupled to that platform (CASL permissions, STS uploads, its own socket protocol). Everything listed below was **re-implemented** against this repository's API, state layer (`web/src/state`, `web/src/api`) and design system (`web/src/ui`).
- What was carried over is the **information architecture, the interaction model and the edge cases**: which controls exist, where they sit, what happens on hover, which states a message can be in.
- Files that contain an adaptation start with the comment `Adapted from the legacy UI (see docs/PROVENANCE.md)`. `grep -rl "Adapted from the legacy UI" web/src` lists them.
- **Not carried over**: credentials, tokens, hostnames, bucket names, analytics identifiers, personal data, brand names, images. A scan for these runs over every diff before a release (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Adaptations

| New file | Legacy source (under `Pages/Conversations/`) | What was taken |
| --- | --- | --- |
| `components/chat/MessageBubble.tsx` | `ChatBoxBody/MessageBox.tsx`, `ChatBoxBody/hoverButton.tsx`, `Support/ChatBubble/*` | message card anatomy (sender line with channel tag, quote block, footer with time and delivery state), the hover action bar (quote/reply, edit, delete) and its inline edit mode, failed-send state with retry |
| `components/chat/VoiceNote.tsx` | `ChatBoxBody/MessageComponents/VoiceNoteDisplay.tsx` | voice note as play/pause + bars + duration. Re-done without a waveform library: the bars are a deterministic pattern per note (no audio decoding), clicking seeks, and a 1x/1.5x/2x speed switch was added |
| `components/chat/Lightbox.tsx`, gallery in `components/inbox/ContactPanel.tsx` | `ImageDialog/imageDialog.tsx`, `AllImagesPreview/allImagesPreview.tsx` | image viewer with previous/next across every image of the conversation, download, keyboard arrows; the "all images" gallery as a "Shared media" section of the contact card |
| `components/chat/RoomHeader.tsx` | `Support/ChatBoxHeader/chatBoxHeader.tsx`, `assignedPeople.tsx`, `ChatBoxBody/setReminder.tsx` | header controls: assignee picker (me / auto / teammate / unassign), status, priority, favorite, snooze presets plus custom date. Secondary actions collapse into an overflow menu when the header is narrow (container query) |
| `components/inbox/ContactPanel.tsx` | `Support/RightSideBar/contactCardAccordion.tsx`, `rightSideBar.js` | contact card as accordion sections: details, followers, notes, conversation history |
| `components/inbox/RoomListItem.tsx`, `RoomListPane.tsx` | `Support/RoomList/room.tsx`, `roomList.tsx`, `filterDropdown.tsx` | row anatomy (avatar, name, relative time, last-message preview with sender prefix, subject line, unread marker), Open/Snoozed/Closed tabs, sort options (newest, oldest, waiting longest, priority first) |
| `components/composer/ChannelBar.tsx`, `TemplatePicker.tsx` | `Support/ChatEditor/chatEditor.tsx` | channel switch (chat / SMS / email), From address and Subject fields for email, template insertion (here also as a searchable picker next to the existing `/` shortcut), voice-note recording, attachments with previews, emoji |
| `pages/settings/SettingsLayout.tsx` | `Pages/Setting/Apps/conversationSettings/*` | grouping of the settings pages. The legacy accordion list became grouped navigation with a list-then-detail flow on phones |
| `pages/settings/WidgetSettings.tsx`, `components/settings/WidgetPreview.tsx` | `conversationSettings` customise-messenger, welcome-message, required-information, chat-type and availability sections | grouped customiser with live preview, character counters, sound test, required information, chat type, office hours with timezone and "same hours for every open day". Added: AA contrast warning with a one-click fix, light/dark and desktop/phone preview, a "use my browser timezone" button |
| `pages/settings/MemberSettings.tsx` | `conversationSettings/liveChatTeamMembers.js` | team table with per-member access controls and a confirmation before removal |
| `pages/settings/RoleSettings.tsx` | `conversationSettings/editPermissions.js` | permissions edited in a slide-over panel as grouped toggles. The legacy scope radios (all / assigned inbox / assigned conversation) have no server model here, so only the layout idea transferred |
| `pages/settings/TokenSettings.tsx` | `conversationSettings/embedModal.js` | per-domain embed tokens with regenerate, delete and a copyable snippet |

## Legacy ideas deliberately not ported

- Forward message to another contact (the legacy dialog is an unfinished placeholder with fake data).
- Header-logo and custom launcher image uploads, chat wallpaper, reply-time expectation text, widget teams and per-widget permissions (no server support; see [APPROACH.md](APPROACH.md) for scope).
- Insert-site and insert-report pickers, inbound-lead cards (they belong to the legacy platform's other modules).
- Reactions and "message info" in the hover bar (no server model).
- The Draft.js rich-text editor: the composer stays plain text with mentions, as the server stores plain text plus sanitised HTML for email.

## Behaviour that stayed authoritative on the server

Nothing about permissions, routing, delivery state, unread counts or idempotency moved into the UI. The client still renders what the server says (see [ARCHITECTURE.md](ARCHITECTURE.md) and [REALTIME.md](REALTIME.md)).
