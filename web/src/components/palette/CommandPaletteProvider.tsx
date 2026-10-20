import { useQuery } from "@tanstack/react-query";
import { BarChart3, Keyboard, LayoutList, MessageSquarePlus, Moon, Settings, Sun } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { useInboxes } from "../../api/hooks";
import type { Pagination, Room } from "../../api/types";
import { inboxSearch } from "../../lib/inboxParams";
import { formatRelative } from "../../lib/time";
import { Avatar, Kbd, setTheme, useTheme } from "../../ui";
import { CommandEmpty, CommandGroup, CommandItem, CommandPalette } from "../../ui/command";

export interface PaletteAction {
  id: string;
  label: string;
  group?: string;
  keywords?: string;
  hint?: string;
  icon?: ReactNode;
  run: () => void;
}

interface PaletteApi {
  open: () => void;
  /** Contextual actions (e.g. the open conversation's) live only while their component is mounted. */
  register: (source: string, actions: PaletteAction[]) => () => void;
  /** Handlers the pages provide for global actions. */
  setGlobals: (g: { newConversation?: () => void; help?: () => void }) => void;
}

const Ctx = createContext<PaletteApi | null>(null);

export function useCommandPalette(): PaletteApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCommandPalette used outside CommandPaletteProvider");
  return v;
}

/** Registers actions for as long as the calling component is mounted. */
export function useCommandActions(source: string, actions: PaletteAction[]): void {
  const { register } = useCommandPalette();
  const ref = useRef(actions);
  ref.current = actions;
  // the run callbacks are always read through the ref, so the registration only depends on the action identities
  const signature = actions.map((a) => `${a.id}|${a.label}`).join("§");
  useEffect(() => register(source, ref.current.map((a, i) => ({ ...a, run: () => ref.current[i]?.run() }))), [register, source, signature]);
}

const roomName = (r: Room) => r.contact?.name || r.contact?.email || r.contact?.phone || "Unknown contact";

/** Cmd/Ctrl+K: jump to a conversation (server-side search), open pages, run actions on the current conversation. */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [sources, setSources] = useState<Record<string, PaletteAction[]>>({});
  const globals = useRef<{ newConversation?: () => void; help?: () => void }>({});
  const [theme] = useTheme();
  const inboxes = useInboxes().data ?? [];

  const register = useCallback((source: string, actions: PaletteAction[]) => {
    setSources((s) => ({ ...s, [source]: actions }));
    return () =>
      setSources((s) => {
        const { [source]: _gone, ...rest } = s;
        return rest;
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 200);
    return () => clearTimeout(t);
  }, [term]);

  const rooms = useQuery({
    queryKey: ["palette-rooms", debounced],
    queryFn: () => api.get<{ data: Room[]; pagination: Pagination }>("/rooms", { status: "open", search: debounced || undefined, sort: "newest", limit: 8 }),
    enabled: open,
    staleTime: 10_000,
  });

  const close = () => {
    setOpen(false);
    setTerm("");
  };
  const run = (fn: () => void) => () => {
    close();
    // let the dialog release focus first so the action's own focus/dialog is not stolen back
    setTimeout(fn, 0);
  };

  const api_ = useMemo<PaletteApi>(
    () => ({ open: () => setOpen(true), register, setGlobals: (g) => void (globals.current = { ...globals.current, ...g }) }),
    [register],
  );

  const contextual = Object.values(sources).flat();
  const nav: PaletteAction[] = [
    { id: "go-inbox", label: "Go to inbox", icon: <LayoutList className="size-4" aria-hidden="true" />, run: () => navigate("/inbox") },
    { id: "go-analytics", label: "Go to analytics", icon: <BarChart3 className="size-4" aria-hidden="true" />, run: () => navigate("/analytics") },
    { id: "go-settings", label: "Open settings", icon: <Settings className="size-4" aria-hidden="true" />, run: () => navigate("/settings") },
    ...inboxes.map<PaletteAction>((i) => ({ id: `inbox-${i.id}`, label: `Open inbox: ${i.name}`, keywords: "inbox view", icon: <LayoutList className="size-4" aria-hidden="true" />, run: () => navigate(`/inbox${inboxSearch({ status: "open", sort: "newest", inbox_id: i.id })}`) })),
  ];
  const general: PaletteAction[] = [
    { id: "new", label: "New conversation", hint: "n", icon: <MessageSquarePlus className="size-4" aria-hidden="true" />, run: () => (globals.current.newConversation ? globals.current.newConversation() : navigate("/inbox?new=1")) },
    { id: "theme", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", keywords: "appearance dark light mode", icon: theme === "dark" ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />, run: () => setTheme(theme === "dark" ? "light" : "dark") },
    { id: "help", label: "Keyboard shortcuts", hint: "?", icon: <Keyboard className="size-4" aria-hidden="true" />, run: () => globals.current.help?.() },
  ];

  const renderActions = (list: PaletteAction[]) =>
    list.map((a) => (
      <CommandItem key={a.id} value={`${a.label} ${a.keywords ?? ""}`} onSelect={run(a.run)}>
        <span className="text-subtle">{a.icon}</span>
        <span className="flex-1">{a.label}</span>
        {a.hint && <Kbd>{a.hint}</Kbd>}
      </CommandItem>
    ));

  return (
    <Ctx.Provider value={api_}>
      {children}
      <CommandPalette open={open} onOpenChange={(o) => (o ? setOpen(true) : close())} value={term} onValueChange={setTerm} placeholder="Search conversations or type a command…" shouldFilter={false}>
        <PaletteBody
          term={term}
          loading={rooms.isFetching}
          rooms={rooms.data?.data ?? []}
          onPickRoom={(r) => run(() => navigate(`/inbox/${r.id}`))()}
          groups={[
            ["This conversation", contextual],
            ["Go to", nav],
            ["Actions", general],
          ]}
          renderActions={renderActions}
        />
      </CommandPalette>
    </Ctx.Provider>
  );
}

function PaletteBody({
  term, loading, rooms, onPickRoom, groups, renderActions,
}: {
  term: string;
  loading: boolean;
  rooms: Room[];
  onPickRoom: (r: Room) => void;
  groups: [string, PaletteAction[]][];
  renderActions: (a: PaletteAction[]) => ReactNode;
}) {
  const q = term.trim().toLowerCase();
  const match = (a: PaletteAction) => !q || `${a.label} ${a.keywords ?? ""}`.toLowerCase().includes(q);
  const filtered = groups.map(([title, list]) => [title, list.filter(match)] as const).filter(([, list]) => list.length);
  return (
    <>
      {rooms.length > 0 && (
        <CommandGroup heading={q ? "Conversations" : "Recent conversations"}>
          {rooms.map((r) => (
            <CommandItem key={r.id} value={`room ${r.id} ${roomName(r)}`} onSelect={() => onPickRoom(r)}>
              <Avatar name={roomName(r)} seed={r.contact_id} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{roomName(r)}</span>
                <span className="block truncate text-xs text-subtle">{r.last_message?.snippet || r.subject || "No messages yet"}</span>
              </span>
              <span className="shrink-0 text-xs text-subtle">{formatRelative(r.last_message_at)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {filtered.map(([title, list]) => (
        <CommandGroup key={title} heading={title}>
          {renderActions(list)}
        </CommandGroup>
      ))}
      {!rooms.length && !filtered.length && <CommandEmpty>{loading ? "Searching…" : `No results for “${term}”`}</CommandEmpty>}
    </>
  );
}
