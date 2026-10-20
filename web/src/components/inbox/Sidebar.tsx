import { Link } from "react-router";
import type { Counts, Inbox, RoomFilter } from "../../api/types";
import { inboxSearch } from "../../lib/inboxParams";
import { formatBadge } from "../../lib/unread";
import type { RoomListFilters } from "../../state/keys";
import { Icon, type IconName } from "../../ui";
import { NotificationsMenu } from "./NotificationsMenu";
import { UserMenu } from "./UserMenu";

interface Props {
  filters: RoomListFilters;
  counts: Counts | undefined;
  inboxes: Inbox[];
  open: boolean;
  onClose: () => void;
  onNewConversation: () => void;
  onHelp: () => void;
}

interface NavDef {
  id: RoomFilter | "all";
  label: string;
  icon: IconName;
  count?: number;
}

export function Sidebar({ filters, counts, inboxes, open, onClose, onNewConversation, onHelp }: Props) {
  const t = counts?.total;
  const nav: NavDef[] = [
    { id: "all", label: "All conversations", icon: "inbox", count: t?.open },
    { id: "assigned_to_me", label: "Assigned to me", icon: "user", count: t?.assigned },
    { id: "unassigned", label: "Unassigned", icon: "inboxes", count: t?.unassigned },
    { id: "mentions", label: "Mentions", icon: "at", count: t?.mentions },
    { id: "priority", label: "Priority", icon: "flag", count: t?.priority },
    { id: "favorites", label: "Favorites", icon: "star" },
  ];
  const href = (next: Partial<RoomListFilters>) => `/inbox${inboxSearch({ ...filters, status: "open", search: undefined, ...next })}`;
  const noInbox = !filters.inbox_id;

  return (
    <>
      {open && <div className="scrim" onClick={onClose} aria-hidden="true" />}
      <nav className={`sidebar${open ? " open" : ""}`} aria-label="Inbox navigation">
        <div className="sidebar-head">
          <span className="brand">
            <Icon name="chat" size={20} /> Conversations
          </span>
          <NotificationsMenu />
          <button type="button" className="icon-btn drawer-close" aria-label="Close navigation" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <button type="button" className="btn btn-primary new-btn" onClick={onNewConversation}>
          <Icon name="plus" size={16} /> New conversation
        </button>
        <ul className="nav-list">
          {nav.map((n) => {
            const current = n.id === "all" ? !filters.filter && noInbox : filters.filter === n.id;
            return (
              <li key={n.id}>
                <Link to={href({ filter: n.id === "all" ? undefined : n.id, inbox_id: undefined })} className={`nav-item${current ? " current" : ""}`} aria-current={current ? "page" : undefined} onClick={onClose}>
                  <Icon name={n.icon} size={17} />
                  <span>{n.label}</span>
                  {n.count !== undefined && n.count > 0 && <span className="count">{formatBadge(n.count)}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        <h2 className="nav-heading">Inboxes</h2>
        <ul className="nav-list">
          {inboxes.map((i) => {
            const current = filters.inbox_id === i.id;
            const c = counts?.inboxes.find((x) => x.inbox_id === i.id);
            return (
              <li key={i.id}>
                <Link to={href({ inbox_id: i.id, filter: undefined })} className={`nav-item${current ? " current" : ""}`} aria-current={current ? "page" : undefined} onClick={onClose}>
                  <Icon name="inbox" size={17} />
                  <span>{i.name}</span>
                  {!!c?.open && <span className="count">{formatBadge(c.open)}</span>}
                </Link>
              </li>
            );
          })}
          {inboxes.length === 0 && <li className="muted nav-empty">No inboxes yet</li>}
        </ul>
        <div className="sidebar-foot">
          <UserMenu onHelp={onHelp} />
        </div>
      </nav>
    </>
  );
}
