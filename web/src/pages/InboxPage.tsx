import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useCounts, useInboxes, useMembers, useRoom, useRoomList } from "../api/hooks";
import { ChatPane } from "../components/chat/ChatPane";
import { ContactPanel } from "../components/inbox/ContactPanel";
import { NewConversationDialog } from "../components/inbox/NewConversationDialog";
import { RoomListPane } from "../components/inbox/RoomListPane";
import { ShortcutsHelp } from "../components/inbox/ShortcutsHelp";
import { Sidebar } from "../components/inbox/Sidebar";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { inboxSearch, parseInboxParams } from "../lib/inboxParams";
import { useShortcuts } from "../lib/useShortcuts";
import { flattenRooms } from "../state/roomCache";

function titleFor(filters: ReturnType<typeof parseInboxParams>, inboxName: string | undefined): string {
  if (inboxName) return inboxName;
  const names = { assigned_to_me: "Assigned to me", unassigned: "Unassigned", mentions: "Mentions", priority: "Priority", favorites: "Favorites" } as const;
  return filters.filter ? names[filters.filter] : "All conversations";
}

export function InboxPage() {
  const { roomId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const filters = useMemo(() => parseInboxParams(params), [params]);
  const list = useRoomList(filters);
  const counts = useCounts();
  const inboxes = useInboxes().data ?? [];
  const members = useMembers().data;
  const memberMap = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState(true);
  const [help, setHelp] = useState(false);
  const [creating, setCreating] = useState(false);

  const rooms = flattenRooms(list.data);
  const selected = useRoom(roomId).data;

  const step = (delta: number) => {
    if (!rooms.length) return;
    const idx = rooms.findIndex((r) => r.id === roomId);
    const next = rooms[idx === -1 ? (delta > 0 ? 0 : rooms.length - 1) : Math.min(rooms.length - 1, Math.max(0, idx + delta))];
    if (next) navigate(`/inbox/${next.id}${inboxSearch(filters)}`);
  };
  useShortcuts({ next_room: () => step(1), prev_room: () => step(-1), help: () => setHelp(true) });

  const inboxName = inboxes.find((i) => i.id === filters.inbox_id)?.name;

  return (
    <div className={`inbox-shell${roomId ? " has-room" : ""}${panel && roomId ? " with-panel" : ""}`}>
      <Sidebar filters={filters} counts={counts.data} inboxes={inboxes} open={drawer} onClose={() => setDrawer(false)} onNewConversation={() => setCreating(true)} onHelp={() => setHelp(true)} />
      <RoomListPane filters={filters} query={list} counts={counts.data} members={memberMap} selectedId={roomId} title={titleFor(filters, inboxName)} onOpenSidebar={() => setDrawer(true)} />
      <main className="chat-col" id="main">
        {roomId ? (
          <ChatPane roomId={roomId} backTo={`/inbox${inboxSearch(filters)}`} panelOpen={panel} onTogglePanel={() => setPanel((p) => !p)} />
        ) : (
          <EmptyState
            title="Select a conversation"
            hint="Pick one from the list, or press ? to see keyboard shortcuts."
            action={
              <button type="button" className="btn btn-outline" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} /> New conversation
              </button>
            }
          />
        )}
      </main>
      {roomId && panel && (
        <div className="panel-col">
          {selected ? <ContactPanel room={selected} onClose={() => setPanel(false)} /> : <aside className="contact-panel" aria-label="Contact details" />}
        </div>
      )}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {creating && <NewConversationDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
