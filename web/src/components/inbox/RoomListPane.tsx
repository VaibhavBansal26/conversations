import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Counts, Member, RoomSort, RoomStatusTab } from "../../api/types";
import { inboxSearch, SORT_LABELS } from "../../lib/inboxParams";
import { formatBadge } from "../../lib/unread";
import type { RoomListFilters } from "../../state/keys";
import type { useRoomList } from "../../api/hooks";
import { flattenRooms } from "../../state/roomCache";
import { scrollToReveal, windowRange } from "../../lib/virtual";
import { getWorkerClient } from "../../workers/client";
import { roomSig } from "../../workers/logic/diff";
import { EmptyState } from "../../ui";
import { ErrorNotice } from "../../ui";
import { Icon } from "../../ui";
import { LoadingBlock } from "../../ui";
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

/** Fixed row height lets the list render only what is on screen; rows are clipped to it (see layout.css). */
export const ROW_HEIGHT = 76;
/** Below this many rooms virtualisation buys nothing. */
const VIRTUALISE_FROM = 100;
/** Above this many rooms the resync diff is computed off the main thread. */
const DIFF_IN_WORKER_FROM = 400;

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
  const rooms = useMemo(() => flattenRooms(query.data), [query.data]);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 640 });
  const virtual = rooms.length >= VIRTUALISE_FROM;
  const win = virtual ? windowRange(view.top, view.height, ROW_HEIGHT, rooms.length) : { start: 0, end: rooms.length, padTop: 0, padBottom: 0 };
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const prevSigs = useRef<{ id: string; sig: string }[]>([]);

  // track the scroll window (one state update per animation frame)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !virtual) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [virtual]);

  // keyboard navigation (j/k) changes the selection: keep it on screen even when its row is not rendered
  useEffect(() => {
    const el = scroller.current;
    if (!el || !virtual || !selectedId) return;
    const i = rooms.findIndex((r) => r.id === selectedId);
    const to = i < 0 ? null : scrollToReveal(i, ROW_HEIGHT, el.clientHeight, el.scrollTop);
    if (to !== null) el.scrollTop = to;
  }, [selectedId, virtual, rooms]);

  // after a resync, flash rooms whose content changed (computed in a worker for big lists)
  useEffect(() => {
    const next = rooms.map((r) => ({ id: r.id, sig: roomSig(r) }));
    const prev = prevSigs.current;
    prevSigs.current = next;
    if (!prev.length) return;
    const ac = new AbortController();
    void getWorkerClient()
      .run("diff", { prev, next }, { signal: ac.signal, size: next.length, inlineBelow: DIFF_IN_WORKER_FROM })
      .then((d) => {
        if (!d.changed.length) return;
        setFlash(new Set(d.changed));
        setTimeout(() => setFlash(new Set()), 1600);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [rooms]);

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
      <div className="list-scroll" ref={scroller} role="tabpanel" aria-busy={query.isFetching}>
        {query.isPending && <LoadingBlock label="Loading conversations" />}
        {query.isError && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
        {query.isSuccess && rooms.length === 0 && (
          <EmptyState title="No conversations here" hint={filters.search ? "Try a different search." : "New messages from customers will appear in this list."} />
        )}
        {rooms.length > 0 && (
          <ul className={`rooms${virtual ? " virtual" : ""}`} style={virtual ? { paddingTop: win.padTop, paddingBottom: win.padBottom } : undefined}>
            {rooms.slice(win.start, win.end).map((r) => (
              <RoomListItem key={r.id} room={r} selected={r.id === selectedId} to={`/inbox/${r.id}${inboxSearch(filters)}`} members={members} flash={flash.has(r.id)} />
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
