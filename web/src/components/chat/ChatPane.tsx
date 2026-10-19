import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useLoadOlder, useRoom, useRoomActions, useThread } from "../../api/hooks";
import type { Message } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { useShortcuts } from "../../lib/useShortcuts";
import { useSocket } from "../../realtime/SocketProvider";
import { patchRoomEverywhere } from "../../state/events";
import { keys } from "../../state/keys";
import { newestConfirmed, upsertMessage, type Thread } from "../../state/messageCache";
import { useSendMessage } from "../../state/useSendMessage";
import { Composer } from "../composer/Composer";
import { ErrorNotice } from "../ui/ErrorNotice";
import { LoadingBlock } from "../ui/Spinner";
import { MessageList } from "./MessageList";
import { RoomHeader } from "./RoomHeader";

interface Props {
  roomId: string;
  backTo: string;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

export function ChatPane({ roomId, backTo, panelOpen, onTogglePanel }: Props) {
  const qc = useQueryClient();
  const { member, workspace } = useSession();
  const socket = useSocket();
  const room = useRoom(roomId);
  const thread = useThread(roomId);
  const older = useLoadOlder(roomId);
  const actions = useRoomActions(roomId);
  const { retry } = useSendMessage(roomId);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const markedRef = useRef<string | null>(null);
  const visible = usePageVisible();

  useEffect(() => {
    setReplyTo(null);
    setActionError(null);
    markedRef.current = null;
  }, [roomId]);

  // Opening a conversation moves focus to its heading so keyboard and screen-reader users land in the right place.
  const hasRoom = !!room.data;
  useEffect(() => {
    if (hasRoom) titleRef.current?.focus({ preventScroll: true });
  }, [roomId, hasRoom]);

  const newestId = thread.data ? newestConfirmed(thread.data)?.id : undefined;
  useEffect(() => {
    if (!newestId || !visible || markedRef.current === newestId) return;
    markedRef.current = newestId;
    patchRoomEverywhere(qc, roomId, { id: roomId, unread_count: 0 }, new Date());
    const body = { room_id: roomId, message_id: newestId };
    const send = socket.connected ? socket.emit("message:read", body) : api.post(`/rooms/${roomId}/read`, { message_id: newestId });
    void Promise.resolve(send).catch(() => undefined);
  }, [newestId, visible, roomId, qc, socket]);

  useShortcuts({
    toggle_status: () => room.data && actions.patch.mutate({ status: room.data.status === "closed" ? "open" : "closed" }),
    open_assign: () => setAssignOpen(true),
    focus_composer: () => composerRef.current?.focus(),
  });

  const merge = (m: Message): void => {
    qc.setQueryData<Thread>(keys.thread(roomId), (cur) => (cur ? upsertMessage(cur, m) : cur));
  };
  const guard = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e);
    }
  };

  const handlers = {
    onReply: setReplyTo,
    onRetry: (m: Message) => {
      if (m.local && m.client_msg_id) void retry(m.client_msg_id);
      else void guard(async () => merge(await api.post<Message>(`/messages/${m.id}/retry`)));
    },
    onEdit: (m: Message, content: string) => guard(async () => merge(await api.patch<Message>(`/messages/${m.id}`, { content }))),
    onDelete: (m: Message) => {
      if (window.confirm("Delete this message for everyone?")) void guard(() => api.delete(`/messages/${m.id}`));
    },
  };

  if (room.isPending || thread.isPending) return <LoadingBlock label="Loading conversation" />;
  if (room.isError || thread.isError) return <ErrorNotice error={room.error ?? thread.error} onRetry={() => { void room.refetch(); void thread.refetch(); }} />;

  return (
    <section className="chat" aria-label={`Conversation with ${room.data.contact?.name ?? "contact"}`}>
      <RoomHeader room={room.data} backTo={backTo} assignOpen={assignOpen} onAssignOpen={setAssignOpen} panelOpen={panelOpen} onTogglePanel={onTogglePanel} titleRef={titleRef} />
      {actionError !== null && <ErrorNotice error={actionError} compact />}
      {actions.patch.error && <ErrorNotice error={actions.patch.error} compact />}
      {actions.assign.error && <ErrorNotice error={actions.assign.error} compact />}
      <MessageList
        key={`messages-${roomId}`}
        thread={thread.data}
        loadingOlder={older.isPending}
        onLoadOlder={() => older.mutate()}
        selfMemberId={member.id}
        contactName={room.data.contact?.name}
        editWindowSeconds={workspace.settings.edit_window_seconds}
        typing={socket.typing[roomId]}
        handlers={handlers}
      />
      <Composer key={`composer-${roomId}`} room={room.data} messages={thread.data.messages} replyTo={replyTo} onClearReply={() => setReplyTo(null)} textareaRef={composerRef} />
    </section>
  );
}
