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
