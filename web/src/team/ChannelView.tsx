import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellOff, Hash, Info, Lock, Pin, Search, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { useCan, useSession } from "../auth/AuthContext";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useSocket } from "../realtime/SocketProvider";
import { Avatar, Button, ErrorNotice, Sheet, Skeleton, Tooltip } from "../ui";
import { useTeamActions } from "./actions";
import { teamKeys } from "./cache";
import { DetailsPanel, PinsPanel } from "./DetailsPanel";
import { TeamSearchDialog } from "./Dialogs";
import { MessageTimeline } from "./MessageTimeline";
import { TeamComposer } from "./TeamComposer";
import { ThreadPanel } from "./ThreadPanel";
import { TypingLine } from "./TypingLine";
import { useLoadOlderTeam, useTeamMessages } from "./hooks";
import type { TeamChannel } from "./types";

type Panel = "thread" | "details" | "pins" | null;

export function ChannelIcon({ channel, className }: { channel: TeamChannel; className?: string }) {
  if (channel.kind === "group") return <Users className={className} aria-hidden="true" />;
  if (channel.kind === "dm") return null;
  return channel.visibility === "private" ? <Lock className={className} aria-hidden="true" /> : <Hash className={className} aria-hidden="true" />;
}

export function ChannelView({ channel }: { channel: TeamChannel }) {
  const { member } = useSession();
  const socket = useSocket();
  const [params, setParams] = useSearchParams();
  // the thread / details panel sits beside the conversation from 1280 px; below that it opens as a drawer so the messages keep their width
  const wide = useMediaQuery("(min-width: 1280px)");
  const msgs = useTeamMessages(channel.id);
  const older = useLoadOlderTeam(channel.id);
  const actions = useTeamActions(channel.id);
  const canModerate = useCan("team_chat:moderate");
  const [search, setSearch] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const unreadRef = useRef(channel.unread);
  unreadRef.current = channel.unread;

  const threadId = params.get("thread");
  const panelParam = params.get("panel");
  const panel: Panel = threadId ? "thread" : panelParam === "details" || panelParam === "pins" ? panelParam : null;
  const setPanel = useCallback(
    (p: Panel, thread?: string) => {
      const next = new URLSearchParams(params);
      next.delete("thread");
      next.delete("panel");
      if (p === "thread" && thread) next.set("thread", thread);
      else if (p) next.set("panel", p);
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  // Escape closes the side panel (thread, pins, details) unless a dialog or menu owns the key
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]')) return;
      setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, setPanel]);

  const readOnly = channel.archived || !channel.joined;
  const dmOther = channel.kind === "dm" ? (channel.member_ids ?? []).find((id) => id !== member.id) ?? member.id : null;

  // reading: the newest message is on screen and the tab is visible
  const seen = useCallback(() => {
    if (document.visibilityState === "visible" && channel.joined) actions.markRead(unreadRef.current > 0 || channel.mention_unread > 0);
  }, [actions, channel.joined, channel.mention_unread]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && seen();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [seen]);
  useEffect(() => {
    if (channel.unread > 0 && msgs.data) seen();
  }, [channel.unread, msgs.data, seen]);

  const [editId, setEditId] = useState<string | null>(null);
  const editLast = () => {
    const last = [...(msgs.data?.messages ?? [])].reverse().find((m) => m.sender.id === member.id && !m.local && m.kind === "text");
    if (last) setEditId(last.id);
  };

  const side =
    panel === "thread" && threadId ? <ThreadPanel channel={channel} rootId={threadId} readOnly={readOnly} onClose={() => setPanel(null)} /> :
    panel === "details" ? <DetailsPanel channel={channel} onClose={() => setPanel(null)} /> :
    panel === "pins" ? <PinsPanel channel={channel} onClose={() => setPanel(null)} onUnpin={(id) => { const m = msgs.data?.messages.find((x) => x.id === id); if (m) void actions.pin(m, false); }} /> : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1" data-testid="channel-view">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={channel.kind === "channel" ? `#${channel.name}` : channel.title}>
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 md:px-4">
          <Link to="/team" aria-label="Back to team chat" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 lg:hidden">
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
          {dmOther ? <Avatar name={channel.title} seed={dmOther} size="sm" online={socket.onlineMembers.has(dmOther)} /> : <ChannelIcon channel={channel} className="size-4 shrink-0 text-subtle" />}
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-1.5 truncate text-[15px] font-semibold leading-tight">
              {channel.title}
              {channel.muted && <BellOff className="size-3.5 text-subtle" aria-label="Muted" />}
              {channel.archived && <span className="rounded bg-surface-3 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Archived</span>}
            </h1>
            {channel.topic && <p className="truncate text-xs text-muted-foreground">{channel.topic}</p>}
          </div>
          <Tooltip content="Search this conversation">
            <Button variant="ghost" size="icon-sm" aria-label="Search this conversation" onClick={() => setSearch(true)}>
              <Search />
            </Button>
          </Tooltip>
          <Tooltip content="Pinned messages">
            <Button variant="ghost" size="icon-sm" aria-label="Pinned messages" aria-pressed={panel === "pins"} onClick={() => setPanel(panel === "pins" ? null : "pins")}>
              <Pin />
            </Button>
          </Tooltip>
          <Button variant="ghost" size="sm" aria-label={`Details, ${channel.member_count} member${channel.member_count === 1 ? "" : "s"}`} aria-pressed={panel === "details"} onClick={() => setPanel(panel === "details" ? null : "details")}>
            <Info aria-hidden="true" /> <span className="tabular-nums">{channel.member_count}</span>
          </Button>
        </header>
        {msgs.isPending && (
          <div className="flex-1 p-4">
            <Skeleton className="h-16" />
          </div>
        )}
        {msgs.isError && (
          <div className="p-4">
            <ErrorNotice error={msgs.error} onRetry={() => void msgs.refetch()} />
          </div>
        )}
        {msgs.data && (
          <MessageTimeline
            thread={msgs.data}
            selfId={member.id}
            online={socket.onlineMembers}
            loadingOlder={older.isPending}
            onLoadOlder={() => older.mutate()}
            canModerate={canModerate}
            readOnly={readOnly}
            label={`Messages in ${channel.title}`}
            empty={channel.kind === "channel" ? `This is the start of #${channel.name}. Say hello.` : `This is the start of your conversation with ${channel.title}.`}
            onSeenNewest={seen}
            highlightId={null}
            editRequestId={editId}
            onEditStarted={() => setEditId(null)}
            onReact={(m, e) => void actions.react(m, e)}
            onReply={(m) => setPanel("thread", m.id)}
            onOpenThread={(m) => setPanel("thread", m.id)}
            onEdit={actions.edit}
            onDelete={(m) => void actions.remove(m, m.sender.id !== member.id)}
            onPin={(m, p) => void actions.pin(m, p)}
            onRetry={actions.retry}
          />
        )}
        <TypingLine channelId={channel.id} threadRootId={null} />
        <TeamComposer
          draftKey={channel.id}
          channelId={channel.id}
          placeholder={channel.kind === "channel" ? `Message #${channel.name}` : `Message ${channel.title}`}
          textareaRef={box}
          disabled={readOnly}
          disabledReason={channel.archived ? "This channel is archived and read-only." : "Join this channel to write in it."}
          onEditLast={editLast}
          onSend={(a) => void actions.send({ channelId: channel.id, content: a.content, attachmentIds: a.attachmentIds }).catch(() => undefined)}
        />
        {!channel.joined && !channel.archived && <JoinBar channel={channel} />}
      </section>
      {side && wide && <aside className="w-[22rem] shrink-0 border-l border-border">{side}</aside>}
      {side && !wide && (
        <Sheet open onOpenChange={(o) => !o && setPanel(null)} title={panel === "thread" ? "Thread" : panel === "pins" ? "Pinned messages" : "Details"} side="right" hideTitle hideClose className="w-[min(26rem,100vw)]">
          {side}
        </Sheet>
      )}
      {search && <TeamSearchDialog onClose={() => setSearch(false)} channelId={channel.id} />}
    </div>
  );
}

function JoinBar({ channel }: { channel: TeamChannel }) {
  const qc = useQueryClient();
  const join = useMutation({
    mutationFn: () => api.post(`/team/channels/${channel.id}/join`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: teamKeys.channels });
      void qc.invalidateQueries({ queryKey: teamKeys.channel(channel.id) });
      void qc.invalidateQueries({ queryKey: teamKeys.browse });
    },
  });
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-2 px-4 py-2.5 text-sm">
      <span>You are previewing #{channel.name}.</span>
      <Button size="sm" loading={join.isPending} onClick={() => join.mutate()}>
        Join channel
      </Button>
    </div>
  );
}
