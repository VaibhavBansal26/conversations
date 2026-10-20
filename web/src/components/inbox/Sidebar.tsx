import { AtSign, Flag, Inbox as InboxIcon, Layers, MessageSquarePlus, PanelLeftClose, Star, UserRound, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import type { Counts, Inbox, RoomFilter } from "../../api/types";
import { inboxSearch } from "../../lib/inboxParams";
import { formatBadge } from "../../lib/unread";
import type { RoomListFilters } from "../../state/keys";
import { Button, cn, Skeleton, Tooltip } from "../../ui";

interface Props {
  filters: RoomListFilters;
  counts: Counts | undefined;
  inboxes: Inbox[];
  inboxesLoading?: boolean;
  onNavigate?: () => void;
  onNewConversation: () => void;
  /** desktop only: hide the column */
  onCollapse?: () => void;
}

interface NavDef {
  id: RoomFilter | "all";
  label: string;
  icon: LucideIcon;
  count?: number;
}

function NavItem({ to, current, icon: Icon, label, count, onClick }: { to: string; current: boolean; icon: LucideIcon; label: string; count?: number; onClick?: () => void }) {
  return (
    <li>
      <Link
        to={to}
        aria-current={current ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "group flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground",
          current && "bg-primary-soft text-primary-text hover:bg-primary-soft hover:text-primary-text",
        )}
      >
        <Icon className="size-[17px] shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined && count > 0 && <span className={cn("text-xs tabular-nums", current ? "text-primary-text" : "text-subtle")}>{formatBadge(count)}</span>}
      </Link>
    </li>
  );
}

/** Views and inboxes with live counts. Renders inline on large screens and inside a sheet on smaller ones. */
export function Sidebar({ filters, counts, inboxes, inboxesLoading, onNavigate, onNewConversation, onCollapse }: Props) {
  const t = counts?.total;
  const views: NavDef[] = [
    { id: "all", label: "All conversations", icon: InboxIcon, count: t?.open },
    { id: "assigned_to_me", label: "Assigned to me", icon: UserRound, count: t?.assigned },
    { id: "unassigned", label: "Unassigned", icon: Layers, count: t?.unassigned },
    { id: "mentions", label: "Mentions", icon: AtSign, count: t?.mentions },
    { id: "priority", label: "Priority", icon: Flag, count: t?.priority },
    { id: "favorites", label: "Favorites", icon: Star },
  ];
  const href = (next: Partial<RoomListFilters>) => `/inbox${inboxSearch({ ...filters, status: "open", search: undefined, ...next })}`;
  const noInbox = !filters.inbox_id;

  return (
    <nav aria-label="Inbox navigation" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <h2 className="text-base font-semibold tracking-tight">Inbox</h2>
        {onCollapse && (
          <Tooltip content="Hide sidebar">
            <button type="button" onClick={onCollapse} aria-label="Hide sidebar" className="grid size-8 place-items-center rounded-md text-subtle hover:bg-surface-2 hover:text-foreground">
              <PanelLeftClose className="size-4" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="px-3 pb-3">
        <Button className="w-full justify-start" onClick={onNewConversation}>
          <MessageSquarePlus aria-hidden="true" /> New conversation
          <kbd className="ml-auto rounded bg-white/20 px-1.5 font-mono text-[10px]">N</kbd>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <h3 className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-subtle">Views</h3>
        <ul className="space-y-0.5">
          {views.map((n) => (
            <NavItem
              key={n.id}
              to={href({ filter: n.id === "all" ? undefined : n.id, inbox_id: undefined })}
              current={n.id === "all" ? !filters.filter && noInbox : filters.filter === n.id}
              icon={n.icon}
              label={n.label}
              count={n.count}
              onClick={onNavigate}
            />
          ))}
        </ul>
        <h3 className="px-2.5 pb-1 pt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Inboxes</h3>
        <ul className="space-y-0.5">
          {inboxesLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="mx-2.5 my-2 h-4" />)}
          {inboxes.map((i) => {
            const c = counts?.inboxes.find((x) => x.inbox_id === i.id);
            return <NavItem key={i.id} to={href({ inbox_id: i.id, filter: undefined })} current={filters.inbox_id === i.id} icon={InboxIcon} label={i.name} count={c?.open} onClick={onNavigate} />;
          })}
          {!inboxesLoading && inboxes.length === 0 && <li className="px-2.5 py-2 text-[13px] text-subtle">No inboxes yet. Create one in Settings.</li>}
        </ul>
      </div>
    </nav>
  );
}
