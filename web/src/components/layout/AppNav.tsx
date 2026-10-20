import { BarChart3, Inbox, MessageCircle, Settings, type LucideIcon } from "lucide-react";
import { NavLink, useMatch } from "react-router";
import { useCounts } from "../../api/hooks";
import { formatBadge } from "../../lib/unread";
import { cn, ThemeToggle, Tooltip } from "../../ui";
import { NotificationsMenu } from "./NotificationsMenu";
import { UserMenu } from "./UserMenu";

interface Item {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

function useItems(): Item[] {
  const unread = useCounts().data?.unread_rooms ?? 0;
  return [
    { to: "/inbox", label: "Inbox", icon: Inbox, badge: unread },
    { to: "/analytics", label: "Analytics", icon: BarChart3 },
    { to: "/settings", label: "Settings", icon: Settings },
  ];
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground" aria-label={`${n} unread`}>
      {formatBadge(n)}
    </span>
  );
}

/** Slim icon rail (md and up). */
export function NavRail({ onHelp }: { onHelp: () => void }) {
  const items = useItems();
  return (
    <nav aria-label="Main" className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3 md:flex">
      <div className="mb-3 grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm" aria-hidden="true">
        <MessageCircle className="size-5" />
      </div>
      {items.map((i) => (
        <Tooltip key={i.to} content={i.label} side="right">
          <NavLink
            to={i.to}
            aria-label={i.label}
            className={({ isActive }) => cn("relative grid size-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground", isActive && "bg-primary-soft text-primary-text hover:bg-primary-soft hover:text-primary-text")}
          >
            <i.icon className="size-5" aria-hidden="true" />
            {i.badge !== undefined && <Badge n={i.badge} />}
          </NavLink>
        </Tooltip>
      ))}
      <div className="mt-auto flex flex-col items-center gap-1">
        <NotificationsMenu />
        <ThemeToggle className="grid size-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground" />
        <UserMenu onHelp={onHelp} className="mt-1" />
      </div>
    </nav>
  );
}

/** Bottom navigation (below md). Hidden while a conversation is open so the composer owns the bottom edge. */
export function BottomNav({ onHelp }: { onHelp: () => void }) {
  const items = useItems();
  const inRoom = !!useMatch("/inbox/:roomId");
  if (inRoom) return null;
  return (
    <nav aria-label="Main" className="pb-safe flex shrink-0 items-stretch justify-around border-t border-border bg-surface md:hidden">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          className={({ isActive }) => cn("relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground", isActive && "text-primary-text")}
        >
          <span className="relative">
            <i.icon className="size-5" aria-hidden="true" />
            {i.badge !== undefined && <Badge n={i.badge} />}
          </span>
          {i.label}
        </NavLink>
      ))}
      <div className="flex min-h-14 flex-1 items-center justify-center">
        <UserMenu onHelp={onHelp} side="top" />
      </div>
    </nav>
  );
}
