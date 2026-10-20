// Adapted from the legacy UI (see docs/PROVENANCE.md): status tabs, sort options and the search box of the conversation list.
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
import { ArrowUpDown, Inbox, MenuIcon, MessageSquarePlus, Search, SearchX, X } from "lucide-react";
import { useSocket } from "../../realtime/SocketProvider";
import { Button, EmptyState, ErrorNotice, Menu, buttonVariants, SegmentedList, SegmentedTrigger, Skeleton, Tabs, Tooltip } from "../../ui";
import { RoomListItem } from "./RoomListItem";

interface Props {
  filters: RoomListFilters;
  query: ReturnType<typeof useRoomList>;
  counts: Counts | undefined;
  members: Map<string, Member>;
  selectedId: string | undefined;
  title: string;
  onOpenSidebar: () => void;
  onNewConversation: () => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

/** Fixed row height lets the list render only what is on screen; rows are clipped to it (see RoomListItem). */
export const ROW_HEIGHT = 84;
/** Below this many rooms virtualisation buys nothing. */
const VIRTUALISE_FROM = 100;
/** Above this many rooms the resync diff is computed off the main thread. */
const DIFF_IN_WORKER_FROM = 400;

const TABS: { id: RoomStatusTab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "snoozed", label: "Snoozed" },
  { id: "closed", label: "Closed" },
];

export function RoomListPane({ filters, query, counts, members, selectedId, title, onOpenSidebar, onNewConversation, searchRef }: Props) {
  const navigate = useNavigate();
  const { visitorOnline } = useSocket();
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
  const total = query.data?.pages[0]?.pagination.total;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="Conversations">
      <div className="flex items-center gap-1 px-3 pb-2 pt-3 md:px-4">
        <Button variant="ghost" size="icon" className="-ml-1 xl:hidden" aria-label="Open navigation" onClick={onOpenSidebar}>
          <MenuIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">{title}</h1>
          {typeof total === "number" && <p className="text-xs text-subtle">{total.toLocaleString()} conversation{total === 1 ? "" : "s"}</p>}
        </div>
        <Menu
          label={`Sort: ${SORT_LABELS[filters.sort]}`}
          align="end"
          triggerClassName={buttonVariants({ variant: "ghost", size: "icon" })}
          trigger={<ArrowUpDown aria-hidden="true" />}
          items={(Object.entries(SORT_LABELS) as [RoomSort, string][]).map(([id, label]) => ({ id, label, checked: filters.sort === id, onSelect: () => go({ sort: id }) }))}
        />
        <Tooltip content="New conversation" shortcut="n">
          <Button variant="outline" size="icon" aria-label="New conversation" onClick={onNewConversation} className="xl:hidden">
            <MessageSquarePlus />
          </Button>
        </Tooltip>
      </div>
      <div className="px-3 pb-2 md:px-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <label className="sr-only" htmlFor="room-search">
            Search conversations
          </label>
          <input
            id="room-search"
            ref={searchRef}
            type="search"
            placeholder="Search name, email or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-md border border-border-strong bg-surface-2 pl-8 pr-8 text-sm placeholder:text-subtle focus-visible:border-ring focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
          />
          {search ? (
            <button type="button" aria-label="Clear search" className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-subtle hover:bg-surface-3" onClick={() => setSearch("")}>
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : (
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded pointer-coarse:hidden border border-border-strong px-1.5 font-mono text-[10px] text-subtle" aria-hidden="true">
              /
            </kbd>
          )}
        </div>
      </div>
      <Tabs value={filters.status} onValueChange={(v) => go({ status: v as RoomStatusTab })} className="px-3 pb-2 md:px-4">
        <SegmentedList aria-label="Conversation status" className="flex w-full">
          {TABS.map((t) => (
            <SegmentedTrigger key={t.id} value={t.id} className="flex-1 justify-center">
              {t.label}
              {tabCount(t.id) !== undefined && <span className="text-xs tabular-nums text-subtle">{formatBadge(tabCount(t.id) ?? 0)}</span>}
            </SegmentedTrigger>
          ))}
        </SegmentedList>
      </Tabs>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border" ref={scroller} role="tabpanel" aria-busy={query.isFetching}>
        {query.isPending && (
          <div className="divide-y divide-border" aria-label="Loading conversations" role="status">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex h-[84px] gap-3 px-3.5 py-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex-1 space-y-2 pt-1">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        )}
        {query.isError && (
          <div className="p-4">
            <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
          </div>
        )}
        {query.isSuccess && rooms.length === 0 && (
          <EmptyState
            icon={filters.search ? SearchX : Inbox}
            title={filters.search ? "No matches" : filters.status === "open" ? "All caught up" : `No ${filters.status} conversations`}
            hint={filters.search ? `Nothing matches “${filters.search}”. Try a name, email or phone number.` : "New messages from customers will appear in this list."}
            action={
              filters.search ? (
                <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        )}
        {rooms.length > 0 && (
          <ul style={virtual ? { paddingTop: win.padTop, paddingBottom: win.padBottom } : undefined}>
            {rooms.slice(win.start, win.end).map((r) => (
              <RoomListItem key={r.id} room={r} selected={r.id === selectedId} to={`/inbox/${r.id}${inboxSearch(filters)}`} members={members} flash={flash.has(r.id)} online={visitorOnline[r.id]} />
            ))}
          </ul>
        )}
        {hasNextPage && (
          <div ref={sentinel} className="flex justify-center p-3">
            <Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
