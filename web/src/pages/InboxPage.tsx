import { MessageSquareText, MessageSquarePlus, PanelLeftOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useCounts, useInboxes, useMembers, useRoom, useRoomList } from "../api/hooks";
import { ChatPane } from "../components/chat/ChatPane";
import { ContactPanel } from "../components/inbox/ContactPanel";
import { NewConversationDialog } from "../components/inbox/NewConversationDialog";
import { RoomListPane } from "../components/inbox/RoomListPane";
import { Sidebar } from "../components/inbox/Sidebar";
import { useCommandPalette } from "../components/palette/CommandPaletteProvider";
import { inboxSearch, parseInboxParams } from "../lib/inboxParams";
import { readStorage, writeStorage } from "../lib/storage";
import { BREAKPOINT, useMediaQuery } from "../lib/useMediaQuery";
import { useShortcuts } from "../lib/useShortcuts";
import { flattenRooms } from "../state/roomCache";
import { Button, cn, EmptyState, Kbd, Sheet, Tooltip } from "../ui";

function titleFor(filters: ReturnType<typeof parseInboxParams>, inboxName: string | undefined): string {
  if (inboxName) return inboxName;
  const names = { assigned_to_me: "Assigned to me", unassigned: "Unassigned", mentions: "Mentions", priority: "Priority", favorites: "Favorites" } as const;
  return filters.filter ? names[filters.filter] : "All conversations";
}

const SIDEBAR_KEY = "conv.sidebar.hidden";

/**
 * Three columns (views, conversations, thread) plus a collapsible contact panel.
 *  - xl and up: everything inline, panel open by default
 *  - lg: sidebar inline, contact panel is a drawer
 *  - md: sidebar is a drawer; list and thread side by side
 *  - below md: list and thread are separate screens (the URL decides which one)
 */
export function InboxPage() {
  const { roomId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const filters = useMemo(() => parseInboxParams(params), [params]);
  const list = useRoomList(filters);
  const counts = useCounts();
  const inboxesQ = useInboxes();
  const inboxes = inboxesQ.data ?? [];
  const members = useMembers().data;
  const memberMap = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);
  const palette = useCommandPalette();
  const isXl = useMediaQuery(BREAKPOINT.xl, true);
  const is2xl = useMediaQuery(BREAKPOINT["2xl"], true);
  const [drawer, setDrawer] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => readStorage(SIDEBAR_KEY) === "1");
  const [panelPref, setPanelPref] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // the panel is inline where it fits (and open by default there); elsewhere it is a drawer that starts closed
  const panel = panelPref ?? is2xl;
  const rooms = flattenRooms(list.data);
  const selected = useRoom(roomId).data;

  useEffect(() => {
    if (params.get("new") !== "1") return;
    setCreating(true);
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => palette.setGlobals({ newConversation: () => setCreating(true) }), [palette]);

  const step = (delta: number) => {
    if (!rooms.length) return;
    const idx = rooms.findIndex((r) => r.id === roomId);
    const next = rooms[idx === -1 ? (delta > 0 ? 0 : rooms.length - 1) : Math.min(rooms.length - 1, Math.max(0, idx + delta))];
    if (next) navigate(`/inbox/${next.id}${inboxSearch(filters)}`);
  };
  useShortcuts({
    next_room: () => step(1),
    prev_room: () => step(-1),
    focus_search: () => searchRef.current?.focus(),
    new_conversation: () => setCreating(true),
    toggle_panel: () => roomId && setPanelPref(!panel),
  });

  const hideSidebar = (hidden: boolean) => {
    setSidebarHidden(hidden);
    writeStorage(SIDEBAR_KEY, hidden ? "1" : null);
  };

  const inboxName = inboxes.find((i) => i.id === filters.inbox_id)?.name;
  const sidebar = (onNavigate?: () => void, onCollapse?: () => void) => (
    <Sidebar filters={filters} counts={counts.data} inboxes={inboxes} inboxesLoading={inboxesQ.isPending} onNavigate={onNavigate} onNewConversation={() => { onNavigate?.(); setCreating(true); }} onCollapse={onCollapse} />
  );

  return (
    <div className="flex h-full min-h-0 bg-surface">
      {isXl && !sidebarHidden && <aside className="w-60 shrink-0 border-r border-border">{sidebar(undefined, () => hideSidebar(true))}</aside>}
      {!isXl && (
        <Sheet open={drawer} onOpenChange={setDrawer} side="left" title="Inbox navigation" hideTitle>
          {sidebar(() => setDrawer(false))}
        </Sheet>
      )}

      <div className={cn("relative min-h-0 w-full shrink-0 border-r border-border md:w-72 lg:w-80 2xl:w-[23rem]", roomId ? "hidden md:block" : "block")}>
        {isXl && sidebarHidden && (
          <Tooltip content="Show sidebar" side="right">
            <button type="button" onClick={() => hideSidebar(false)} aria-label="Show sidebar" className="absolute -left-px top-4 z-10 grid size-7 place-items-center rounded-r-md border border-l-0 border-border bg-surface text-subtle shadow-xs hover:text-foreground">
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        <RoomListPane
          filters={filters}
          query={list}
          counts={counts.data}
          members={memberMap}
          selectedId={roomId}
          title={titleFor(filters, inboxName)}
          onOpenSidebar={() => setDrawer(true)}
          onNewConversation={() => setCreating(true)}
          searchRef={searchRef}
        />
      </div>

      <section className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", roomId ? "flex" : "hidden md:flex")} aria-label="Conversation">
        {roomId ? (
          <ChatPane roomId={roomId} backTo={`/inbox${inboxSearch(filters)}`} panelOpen={panel} onTogglePanel={() => setPanelPref(!panel)} />
        ) : (
          <EmptyState
            className="m-auto"
            icon={MessageSquareText}
            title="Select a conversation"
            hint="Pick one from the list to read and reply."
            action={
              <div className="flex flex-col items-center gap-3">
                <Button variant="outline" onClick={() => setCreating(true)}>
                  <MessageSquarePlus /> New conversation
                </Button>
                <p className="flex items-center gap-1.5 text-xs text-subtle">
                  <Kbd>j</Kbd> <Kbd>k</Kbd> to move, <Kbd>?</Kbd> for all shortcuts
                </p>
              </div>
            }
          />
        )}
      </section>

      {roomId && isXl && panel && (
        <aside className="w-80 shrink-0 border-l border-border bg-surface 2xl:w-[22rem]" aria-label="Contact details">
          {selected ? <ContactPanel room={selected} onClose={() => setPanelPref(false)} /> : null}
        </aside>
      )}
      {roomId && !isXl && (
        <Sheet open={panel} onOpenChange={(o) => setPanelPref(o)} side="right" title="Contact details" hideTitle hideClose className="w-[min(24rem,100vw)]">
          {selected ? <ContactPanel room={selected} onClose={() => setPanelPref(false)} /> : null}
        </Sheet>
      )}

      {creating && <NewConversationDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
