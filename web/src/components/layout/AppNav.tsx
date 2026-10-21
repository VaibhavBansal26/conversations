import { BarChart3, Inbox, MessageCircle, MessagesSquare, Settings, Ticket, type LucideIcon } from "lucide-react";
import { Link, useMatch } from "react-router";
import { useCounts } from "../../api/hooks";
import { useTicketCounts } from "../../api/ticketHooks";
import { useCan } from "../../auth/AuthContext";
import { totalUnread } from "../../team/cache";
import { useTeamChannels } from "../../team/hooks";
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
  const canTeam = useCan("team_chat:use");
  const canTickets = useCan("tickets:read");
  const waiting = useTicketCounts(canTickets).data?.waiting_for_human ?? 0;
  // the channel list is only fetched for people who may use team chat; a mention counts more than plain unread
  const team = totalUnread(useTeamChannels({ enabled: canTeam }).data);
  return [
    { to: "/inbox", label: "Inbox", icon: Inbox, badge: unread },
    ...(canTickets ? [{ to: "/tickets", label: "Tickets", icon: Ticket, badge: waiting }] : []),
    ...(canTeam ? [{ to: "/team", label: "Team", icon: MessagesSquare, badge: team.mentions || team.unread }] : []),
    { to: "/analytics", label: "Analytics", icon: BarChart3 },
    { to: "/settings", label: "Settings", icon: Settings },
  ];
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground" aria-hidden="true">
      {formatBadge(n)}
    </span>
  );
}

function RailLink({ item: i }: { item: Item }) {
  const active = !!useMatch({ path: i.to, end: false });
  return (
    <Tooltip content={i.label} side="right">
      <Link
        to={i.to}
        aria-label={i.badge ? `${i.label}, ${formatBadge(i.badge)} unread` : i.label}
        aria-current={active ? "page" : undefined}
        className={cn("relative grid size-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground", active && "bg-primary-soft text-primary-text hover:bg-primary-soft hover:text-primary-text")}
      >
        <i.icon className="size-5" aria-hidden="true" />
        {i.badge !== undefined && <Badge n={i.badge} />}
      </Link>
    </Tooltip>
  );
}

function TabLink({ item: i }: { item: Item }) {
  const active = !!useMatch({ path: i.to, end: false });
  return (
    <Link to={i.to} aria-label={i.badge ? `${i.label}, ${formatBadge(i.badge)} unread` : undefined} aria-current={active ? "page" : undefined} className={cn("relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground", active && "text-primary-text")}>
      <span className="relative">
        <i.icon className="size-5" aria-hidden="true" />
        {i.badge !== undefined && <Badge n={i.badge} />}
      </span>
      {i.label}
    </Link>
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
        <RailLink key={i.to} item={i} />
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
  // both matches are evaluated every render (hooks must not be skipped by short-circuiting)
  const inRoom = useMatch("/inbox/:roomId");
  const inChannel = useMatch("/team/:channelId");
  if (inRoom || inChannel) return null;
  return (
    <nav aria-label="Main" className="pb-safe flex shrink-0 items-stretch justify-around border-t border-border bg-surface md:hidden">
      {items.map((i) => (
        <TabLink key={i.to} item={i} />
      ))}
      <div className="flex min-h-14 flex-1 items-center justify-center">
        <UserMenu onHelp={onHelp} side="top" />
      </div>
    </nav>
  );
}
