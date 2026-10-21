# Design system

The web app (`web/`) uses one stylesheet, [`web/src/styles/index.css`](../../web/src/styles/index.css), Tailwind CSS v4 utilities, and the components in [`web/src/ui`](../../web/src/ui). Why: [ADR 0017](../adr/0017-tailwind-and-headless-primitives.md). Where the interaction ideas came from: [PROVENANCE.md](../PROVENANCE.md).

## Tokens

Semantic colours are CSS variables defined once with `light-dark()`; Tailwind reads them through `@theme inline`, so `bg-surface`, `text-muted-foreground`, `border-border` work in both themes without `dark:` variants.

| Token (utility suffix) | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#f5f5f8` | `#0b0b0f` | page |
| `surface`, `surface-2`, `surface-3` | `#fff`, `#f0f0f5`, `#e6e6ee` | `#14141a`, `#1b1b23`, `#24242e` | cards and panels, hover and inset areas, skeletons |
| `border`, `border-strong` | `#e2e2ea`, `#c9c9d6` | `#2a2a36`, `#3d3d4d` | dividers, input borders |
| `foreground`, `muted-foreground`, `subtle` | `#14141b`, `#4d4d5c`, `#666676` | `#ededf3`, `#aaaabb`, `#8e8ea0` | body, secondary and tertiary text (all >= 4.5:1 on their surface) |
| `primary`, `primary-hover`, `primary-soft`, `primary-text` | `#4f46e5`, `#4338ca`, `#eceeff`, `#4338ca` | `#5558e8`, `#6366f1`, `#1f2047`, `#aab4ff` | actions, selection, links; `primary-text` is the AA-safe text/icon colour on `surface` |
| `danger`, `danger-soft`, `danger-text` | `#b91c1c`, `#fdecec`, `#b91c1c` | `#dc2626`, `#2c1518`, `#fca5a5` | destructive actions, errors, failed sends |
| `success-soft`/`-text`, `warning-soft`/`-text`/`-border`, `info-soft`/`-text` | tinted pairs | tinted pairs | badges, notes (warning tones), banners |
| `bubble-in`, `bubble-out` | `#fff`, `#4f46e5` | `#1d1d26`, `#4a4dd6` | message bubbles (outgoing text is white) |
| `ring` | `#4f46e5` | `#8b92ff` | focus ring (2 px outline, 2 px offset on `:focus-visible`) |

Other tokens: radii `sm 6 / md 8 / lg 12 / xl 16 px`, shadows `xs`..`lg` (colour from `--shadow-color`), font stack `Inter, system-ui…`, animations `fade-in`, `pop-in`, `slide-*`, `toast-in`, `shimmer`, `flash`. A global `prefers-reduced-motion: reduce` rule collapses every animation and transition to ~0 ms.

### Dark mode

`<html data-theme>` is absent by default, so the OS preference (`color-scheme: light dark`) decides. The theme menu (`ThemeToggle`, also in the command palette) sets `data-theme="light|dark"`, stored in `localStorage` under `conv.theme`; an inline script in `index.html` applies it before first paint. The operator console always uses its dark tokens (`admin/admin.css`).

## Components (`web/src/ui`)

Behaviour comes from Radix primitives (focus trap and return, roving focus, type-ahead, dismissal, `aria-*`); looks come from Tailwind classes with `class-variance-authority` variants and `tailwind-merge`.

| Component | Notes |
| --- | --- |
| `Button` | variants `primary, secondary, outline, ghost, danger, danger-ghost, link`; sizes `sm, md, lg, icon, icon-sm`; `loading` shows a spinner and sets `aria-busy` |
| `Input`, `Textarea`, `Field`, `NativeSelect`, `Select` | `Field` wires label, hint and error (`aria-describedby`, `aria-invalid`, `role="alert"`); `Select` is the Radix listbox |
| `Tabs`, `SegmentedList` | underline tabs; pill segmented control (room status, composer channels, preview switches) |
| `Dialog`, `ConfirmDialog`, `Sheet` | centred modal (Escape, backdrop and close button; `data-autofocus` picks the first focus); sheet = drawer from the left, right or bottom |
| `Popover`, `Menu` / `DropdownMenu*`, `Tooltip` | tooltips are supplementary (every icon button keeps an `aria-label`) and show the keyboard shortcut |
| `CommandPalette` (`ui/command`) | cmdk; loaded lazily with the app shell |
| `Toaster`, `toast()` | Radix Toast; `toast({ title, tone })` works from anywhere |
| `Badge`, `Avatar`, `Card`, `Table`, `Skeleton`, `EmptyState`, `ErrorNotice`, `Spinner`, `Switch`, `ScrollArea`, `Accordion`, `Kbd` | `Avatar` hashes the name to a hue and can show a presence dot (`online`); `ErrorNotice` shows the server message verbatim, AI outages calmly |

## Layout and responsiveness

| Width | Inbox | Navigation |
| --- | --- | --- |
| >= 1280 px | views sidebar, list (320 / 368 px), thread, contact panel (open by default from 1536 px) | icon rail on the left |
| 768-1279 px | list and thread; sidebar and contact panel are sheets | icon rail |
| < 768 px | list **or** thread (the URL decides), sheets for filters and contact | bottom navigation on the list screen, hidden inside a thread |

The thread header uses container queries (`@container`), so secondary actions (priority, favorite, snooze, summary, search, payment) fold into the "More actions" menu when the pane is narrow. Settings use a grouped sidebar from 768 px and a list-then-detail flow below it. The room list is virtualised (fixed 84 px rows, window plus overscan; `web/src/lib/virtual.ts`).

## Keyboard shortcuts

Letter shortcuts are ignored while typing in a field or while a dialog or menu is open. `?` opens the help dialog.

| Keys | Action |
| --- | --- |
| Cmd/Ctrl + K | command palette: jump to a conversation, open a page, run an action on the open conversation, switch theme |
| `j` / `k` | next / previous conversation |
| `/` | focus the conversation search |
| `n` | new conversation |
| `e` | close or reopen |
| `a` | open the assign menu |
| `s` | open the snooze popover |
| `p` / `f` | toggle priority / favorite |
| `i` | show or hide the contact panel |
| `c` | focus the composer |
| `Enter` / `Shift+Enter` | send / new line |
| `/` at the start of a reply, `@` in a note | template picker, mention picker |
| `?`, `Esc` | help, close |

## Accessibility

- Contrast is checked with axe (WCAG 2 A/AA, including colour contrast) on the sign-in, inbox, conversation, overlays, settings, analytics and operator pages in light and dark (`e2e/tests/06-a11y.spec.ts`); serious and critical findings fail the build.
- Every icon-only control has an accessible name; state is never colour-only (ticks have `role="img"` labels, unread badges have text, priority and favorite are labelled).
- The message log is a `role="log"` region with a polite live announcement for new customer messages; opening a conversation moves focus to its heading.
- All overlays trap and restore focus; Escape closes the topmost one.
- `prefers-reduced-motion` and `prefers-color-scheme` are honoured; text is never smaller than 11 px (timestamps, counters) and body text is 13-15 px.

## Screenshots

Taken by `npm run shots` (Playwright, the built app, seeded demo data) at 1440x900, 1024x768 and 390x844 in light and dark. File names are `<screen>-<viewport>-<scheme>.jpg`.

| Screen | Files |
| --- | --- |
| Sign-in | `login-*` |
| Inbox (list, empty thread) | `inbox-*` |
| A conversation (images, voice note, ticks) | `conversation-*` |
| Contact panel | `contact-panel-*` |
| Composer (note, email) | `composer-note-*`, `composer-email-*` |
| Command palette, shortcuts help | `command-palette-*`, `shortcuts-help-*` |
| Settings, members | `settings-*`, `members-*` |
| Widget customiser | `widget-customiser-*` |
| The embedded widget on a host page | `widget-1024x768-*`, `widget-390x844-*` |
| Analytics | `analytics-*` |
| Operator console | `admin-login-*`, `admin-*`, `admin-workspace-*` |
| Team chat: conversation list, a channel, a thread | `team-list-*`, `team-channel-*`, `team-thread-*` |
| Settings > SMS & email (test mode banners, Connect Twilio / SendGrid) | `settings-channels-*` |
| Settings > Chat widget > Install | `widget-install-*` |
| Inbox with the Getting started card | `inbox-getting-started-*` |
| A message stored in test mode, with the composer banner | `conversation-test-mode-*` |
| AI call: voice with the photo face and captions, video with the photo face, video with the drawn face | `ai-call-voice-*`, `ai-call-video-photo-*`, `ai-call-video-drawn-face-*` |
| Call link: the join page for the AI and for the team, the one message for an unusable link, the card in the chat | `call-link-page-ai-*`, `call-link-page-team-*`, `call-link-page-unavailable-*`, `call-link-card-widget-*` |
| Teammate call: the call buttons in a direct message, the incoming screen, calling, in progress | `team-call-dm-header-*`, `team-call-incoming-*`, `team-call-calling-*`, `team-call-active-*` |
| Settings > Calls (teammates, AI, links) and the agent editor with presets and picture | `calls-settings-full-*`, `calls-settings-links-*`, `ai-agent-presets-*`, `ai-agent-picture-*` |
| Tickets page and the ticket menu | `tickets-*`, `ticket-menu-*` |
| Departments and the department editor; Settings > Visitor details | `departments-*`, `department-editor-*`, `visitor-info-*` |
| AI agents: list, sandbox, review, unanswered; a conversation answered by the AI; support analytics | `ai-agents-*`, `ai-agent-sandbox-*`, `ai-review-*`, `ai-unanswered-*`, `conversation-ai-*`, `analytics-support-*` |
| The widget with the AI agent and a form card | `widget-ai-*`, `widget-form-*` |
| Browser calls with a visitor: Settings > Calls, the agent's call panel, the widget ringing and in a call | `calls-settings-*`, `agent-call-panel-*`, `widget-call-ringing-*`, `widget-call-active-*` |
| Group calls: the people picker, the incoming screen, a call in progress, a screen share, the settings | `group-call-picker-*`, `group-call-incoming-*`, `group-call-active-*`, `group-call-screen-share-*`, `group-call-settings-*` |
| Settings > Notifications > Push notifications | `push-settings-*` |
| Settings > Calls > Photoreal avatar (not connected, connected) and an AI video call that fell back to the built-in face | `photoreal-settings-not-connected-*`, `photoreal-settings-connected-*`, `photoreal-call-fallback-*` |
| Settings > AI agents > SMS and email answers, and an AI reply to a text in the inbox | `ai-channels-settings-*`, `ai-channels-sms-reply-*` |
| Settings > Tickets > Copies by email, and "Email me a copy" in the widget | `transcripts-settings-*`, `transcripts-widget-*` |
| Pre-chat custom fields: the settings, a department's overrides, the widget form, the hosted chat form | `prechat-settings-*`, `prechat-department-*`, `prechat-widget-*`, `prechat-hosted-*` |

### What the screenshot review changed (2026-10-20)

Reviewing the first set at all three sizes in both schemes led to these fixes: touch screens showed every message's hover toolbar at once and covered the thread (now a tap reveals it); the contact drawer drew two close buttons; analytics axis text grew with the card width (charts now draw at 1 SVG unit per CSS pixel); the widget customiser was squeezed into a 175 px form column at 1024 px (the layout now follows the width of the content area, not of the window); the members table was clipped at 1024 px; the palette's `esc` key cap wrapped onto two lines; the email From field was cut off. Axe also found a dangling `aria-controls` on every tab switcher, name-versus-visible-text mismatches on the navigation badge and the account button, and one 4.41:1 label in the widget preview; all fixed (see `e2e/tests/06-a11y.spec.ts`).

### What the second review changed (2026-10-21)

The team chat, channel connection, widget install and getting started screens were reviewed at 1440, 1024 and 390 px in both schemes (`e2e/tests/shots-team.spec.ts`). Fixes: on a phone the action bar of every team message was visible at once and the bars overlapped (now a tap reveals it, as in the customer thread); at 1024 px the thread panel left the conversation about 320 px wide, so the composer hint wrapped and the header was cramped (the panel now sits beside the conversation from 1280 px and opens as a drawer below that, and the composer hint hides when its own container is narrow); the two "not connected" banners touched the first settings card; the "Send with an API key instead" link ran past the edge of the card on a phone; the embed snippet scrolled sideways instead of wrapping; the Install page content was centred while its tabs were left-aligned; search results for a direct message read "Demo Owner in Demo Owner"; the settings entry for numbers and senders now says "SMS & email". A real bug showed up in the browser run, not in unit tests: the bottom navigation evaluated its second route match only when the first did not match, which changed the hook count and blanked the page when opening a conversation (React error 300); it is covered by `AppNav.test.tsx` and the team end-to-end spec.

### The call screens (2026-10-21)

The screens of AI calls, call links, teammate calls and the related settings were captured at 1440, 1024 and 390 px in both schemes (`e2e/tests/shots-calls.spec.ts`; every picture is a generated placeholder, and the bundled portraits are swapped for placeholders in the browser before they are drawn). Fixes from the review: the AI call's video stage let the "cannot see you" note touch the ring (the stage has more room now); the call-link card in the chat had no border because the system-message rule won (it has its own rule); and the photo avatar did not show on a development server because only https addresses were accepted (a local http address of this app is accepted too). Left as they are: the call panel covers the composer on a phone while a call runs, and the direct message's header truncates the member's name next to the call buttons at 390 px.

### Group calls, push, photoreal, AI on SMS and email, transcripts, pre-chat fields (2026-10-21)

These screens were captured at 1440, 1024 and 390 px in light and dark (`e2e/tests/shots-group.spec.ts`, `shots-push.spec.ts`, `shots-photoreal.spec.ts`, `shots-ai-channels.spec.ts`, `shots-transcripts.spec.ts`, `shots-prechat.spec.ts`) and reviewed. Fixes from the review: a group call that had ended left an empty bordered box in the channel (the live card is now shown only while the call runs); the privacy-policy link in the widget's pre-chat form was below contrast in dark mode (it has its own link colour now); and the screenshot helper scrolled the whole window instead of the settings pane, so some sections were captured half off-screen (`e2e/support/scroll.ts` scrolls the pane to the top first). The photoreal screens use the fake provider; no real D-ID video is shown. The push screen shows the settings only: an operating-system notification cannot be captured by the browser.
