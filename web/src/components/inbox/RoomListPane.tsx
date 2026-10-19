import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Counts, Member, RoomSort, RoomStatusTab } from "../../api/types";
import { inboxSearch, SORT_LABELS } from "../../lib/inboxParams";
import { formatBadge } from "../../lib/unread";
import type { RoomListFilters } from "../../state/keys";
import type { useRoomList } from "../../api/hooks";
import { flattenRooms } from "../../state/roomCache";
import { EmptyState } from "../ui/EmptyState";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Icon } from "../ui/Icon";
import { LoadingBlock } from "../ui/Spinner";
import { RoomListItem } from "./RoomListItem";

interface Props {
  filters: RoomListFilters;
  query: ReturnType<typeof useRoomList>;
  counts: Counts | undefined;
  members: Map<string, Member>;
  selectedId: string | undefined;
  title: string;
  onOpenSidebar: () => void;
}

const TABS: { id: RoomStatusTab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "snoozed", label: "Snoozed" },
  { id: "closed", label: "Closed" },
];

export function RoomListPane({ filters, query, counts, members, selectedId, title, onOpenSidebar }: Props) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [search, setSearch] = useState(filters.search ?? "");
  const sentinel = useRef<HTMLDivElement>(null);
  const rooms = flattenRooms(query.data);

  // Debounce the search box into the URL (the URL is the source of truth for filters).
  useEffect(() => {
    if ((filters.search ?? "") === search.trim()) return;
    const t = setTimeout(() => navigate({ pathname, search: inboxSearch({ ...filters, search: search.trim() || undefined }) }, { replace: true }), 300);
    return () => clearTimeout(t);
  }, [search, filters, navigate, pathname]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && !isFetchingNextPage && void fetchNextPage(), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const go = (next: Partial<RoomListFilters>) => navigate({ pathname: "/inbox", search: inboxSearch({ ...filters, ...next }) });
  const tabCount = (id: RoomStatusTab) => counts?.total[id];

  return (
    <section className="room-list" aria-label="Conversations">
      <div className="list-head">
        <button type="button" className="icon-btn menu-btn" aria-label="Open navigation" onClick={onOpenSidebar}>
          <Icon name="menu" />
        </button>
        <h1>{title}</h1>
      </div>
      <div className="list-tools">
        <div className="search">
          <Icon name="search" size={16} />
          <label className="sr-only" htmlFor="room-search">
            Search conversations
          </label>
          <input id="room-search" type="search" placeholder="Search name, email, phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="sr-only" htmlFor="room-sort">
          Sort conversations
        </label>
        <select id="room-sort" className="select-sm" value={filters.sort} onChange={(e) => go({ sort: e.target.value as RoomSort })}>
          {Object.entries(SORT_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="tabs" role="tablist" aria-label="Conversation status">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={filters.status === t.id} className={filters.status === t.id ? "active" : ""} onClick={() => go({ status: t.id })}>
            {t.label}
            {tabCount(t.id) !== undefined && <span className="tab-count">{formatBadge(tabCount(t.id) ?? 0)}</span>}
          </button>
        ))}
      </div>
      <div className="list-scroll" role="tabpanel" aria-busy={query.isFetching}>
        {query.isPending && <LoadingBlock label="Loading conversations" />}
        {query.isError && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
        {query.isSuccess && rooms.length === 0 && (
          <EmptyState title="No conversations here" hint={filters.search ? "Try a different search." : "New messages from customers will appear in this list."} />
        )}
        {rooms.length > 0 && (
          <ul className="rooms">
            {rooms.map((r) => (
              <RoomListItem key={r.id} room={r} selected={r.id === selectedId} to={`/inbox/${r.id}${inboxSearch(filters)}`} members={members} />
            ))}
          </ul>
        )}
        {hasNextPage && (
          <div ref={sentinel} className="load-more">
            <button type="button" className="btn btn-ghost btn-sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
