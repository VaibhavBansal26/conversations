# 0017. Tailwind CSS v4 with owned components on headless primitives

Status: accepted (2026-10-20).

## Context

The web app had about 2,400 lines of handwritten CSS in four files, hand-rolled dialogs, menus and popovers, and no shared component vocabulary. Settings, the operator console and the inbox each looked different, dark mode was a block of duplicated variables, and every new screen meant new CSS. Accessibility of overlays (focus trap, focus return, roving focus, `aria-*`) was implemented by hand and tested one component at a time. The product wants a polished, consistent look from 360 px to 1920 px in light and dark, and the legacy UI (see [PROVENANCE.md](../PROVENANCE.md)) used a heavyweight third-party component kit and in-house UIKit that we do not want to depend on.

## Decision

- **Tailwind CSS v4, CSS-first.** Tokens live in `web/src/styles/index.css` (`@theme`). Colours are semantic (`background`, `surface`, `foreground`, `primary`, `danger`, ...) and are defined **once** with `light-dark()`, so the same variable resolves per theme. The OS preference applies by default; `<html data-theme="light|dark">` (the manual toggle, stored in `localStorage`) only pins `color-scheme`. No `dark:` utilities are needed.
- **Radix primitives (the `radix-ui` package) for behaviour, components we own for looks.** `web/src/ui/` wraps Dialog, Popover, Dropdown menu, Select, Tabs, Tooltip, Toast, Switch, Accordion, ScrollArea and Avatar in shadcn-style components (variants via `class-variance-authority`, merging via `tailwind-merge`). `cmdk` backs the command palette; `lucide-react` provides icons. Components are source in this repo, not a runtime dependency on a kit.
- **Compatibility surface.** The previous prop-based components (`Dialog`, `Menu`, `Popover`, `Field`, `Switch`, `Avatar`, `ErrorNotice`, `EmptyState`) kept their call signatures so that behaviour and tests carried over; the Radix building blocks are exported next to them for new code.
- **Virtualisation stays hand-written.** The room list renders a window of fixed-height rows (`lib/virtual.ts`, unit-tested); the browser test scrolls 3,000 rooms and checks the DOM stays small.
- **Bundle discipline.** Everything behind sign-in (app shell, inbox, settings shell, socket client) is lazy; `cmdk` and the toaster load on demand. The budget in `web/scripts/check-bundle.mjs` stays at 170 KB gzip for the initial payload (currently about 157 KB).

## Alternatives considered

- **Keep handwritten CSS and add more components.** Cheapest now, but every dialog and menu stays our accessibility liability and dark mode keeps drifting.
- **A full component kit (MUI, Chakra, Mantine).** Fast to start, hard to restyle, large runtime, and the exact kind of dependency the legacy UI suffered from.
- **Base UI instead of Radix.** Comparable; Radix has the larger ecosystem (cmdk, shadcn recipes) and is already tree-shakeable per primitive.
- **Class-based dark mode (`.dark` + `dark:`).** Works, but duplicates every colour decision per component. `light-dark()` keeps one token table.

## Consequences

- One place (`index.css`) decides colours, radii, shadows and motion; `web/src/ui` decides component anatomy. New pages are composed, not styled from scratch.
- `light-dark()` needs Chrome/Edge 123+, Firefox 120+, Safari 17.5+. Older browsers fall back to the light tokens being invalid, i.e. unstyled colours; the app's supported browsers are the evergreen ones.
- A nested scope cannot switch theme by setting `color-scheme` alone when the stylesheet is compiled by Lightning CSS (it resolves the token at `:root`); the operator console therefore restates its dark values in `admin.css`.
- jsdom lacks `ResizeObserver` and pointer-capture APIs that Radix uses; `web/src/test/setup.ts` stubs them.
- Visual regressions are caught by the Playwright suite (`e2e/`), including axe contrast checks, not by unit tests.
