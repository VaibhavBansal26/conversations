import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMatch } from "react-router";
import { io, type Socket } from "socket.io-client";
import type { MessageEventPayload, NotificationItem, ReceiptPayload, Room, TypingEvent } from "../api/types";
import { getToken, refreshAccess } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  onMessageDeleted, onMessageNew, onMessageUpdated, onNotificationNew, onNotificationRead, onReceipt, onRoomDeleted, onRoomNew, onRoomUnread, onRoomUpdated,
  type BridgeContext,
} from "../state/events";
import { keys } from "../state/keys";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type Ack<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

interface SocketValue {
  status: ConnectionStatus;
  connected: boolean;
  emit<T extends object>(event: string, payload: object, timeoutMs?: number): Promise<Ack<T>>;
  /** room id -> who is typing right now */
  typing: Record<string, TypingEvent["who"]>;
  onlineMembers: ReadonlySet<string>;
  visitorOnline: Record<string, boolean>;
}

const SocketContext = createContext<SocketValue | null>(null);
const TYPING_TTL_MS = 4000;
const AUTH_CODES = new Set(["INVALID_TOKEN", "TOKEN_EXPIRED", "UNAUTHORIZED", "WRONG_WORKSPACE", "UNKNOWN_WORKSPACE"]);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { token, session, logout } = useAuth();
  const qc = useQueryClient();
  const memberId = session?.member.id ?? "";
  const workspaceId = session?.workspace.id ?? "";
  const roomMatch = useMatch("/inbox/:roomId");
  const activeRoom = useRef<string | null>(null);
  activeRoom.current = roomMatch?.params.roomId ?? null;

  // the socket is created once per sign-in; a refreshed access token reaches it through the auth callback, not by recreating it
  const signedIn = !!token;
  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [typing, setTyping] = useState<Record<string, TypingEvent["who"]>>({});
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const [visitorOnline, setVisitorOnline] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!signedIn || !workspaceId) return;
    // websocket first (no long-polling round trips on every emit), polling only as a fallback; jittered exponential backoff so a
    // server restart does not make every client reconnect in the same instant
    const socket = io(`/ws/${workspaceId}`, {
      // evaluated on every (re)connect, so a socket that reconnects after a token refresh presents the new token
      auth: (cb) => cb({ token: getToken() }), transports: ["websocket", "polling"], reconnectionDelay: 1000, reconnectionDelayMax: 15_000, randomizationFactor: 0.8,
    });
    let manualTimer: ReturnType<typeof setTimeout> | undefined;
    const reconnectLater = (ms: number) => {
      clearTimeout(manualTimer);
      manualTimer = setTimeout(() => socket.connect(), ms + Math.random() * 1500);
    };
    socketRef.current = socket;
    const ctx: BridgeContext = {
      selfMemberId: memberId,
      activeRoomId: () => (document.visibilityState === "visible" ? activeRoom.current : null),
    };
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let hasConnected = false;

    socket.on("connect", () => {
      setStatus("connected");
      void socket.emitWithAck("presence:list", {}).then((r: { ok: boolean; online?: string[] }) => r.ok && setOnline(new Set(r.online ?? [])));
      if (hasConnected) {
        // Events were missed while offline: resync instead of guessing.
        void qc.invalidateQueries({ queryKey: keys.rooms });
        void qc.invalidateQueries({ queryKey: keys.counts });
        void qc.invalidateQueries({ queryKey: ["thread"] });
      }
      hasConnected = true;
    });
    socket.on("disconnect", (reason: string) => {
      setStatus("disconnected");
      // when the SERVER closes the socket (restart drain, slow-consumer drop) socket.io does not retry by itself: do it with jitter
      if (reason === "io server disconnect") reconnectLater(500);
    });
    socket.on("server:draining", (p: { reconnect_in_ms?: number }) => {
      socket.disconnect();
      reconnectLater(p.reconnect_in_ms ?? 2000);
    });
    // the server lost cross-node events (cache/pub-sub outage): refetch what the screen shows
    socket.on("server:resync", () => {
      void qc.invalidateQueries({ queryKey: keys.rooms });
      void qc.invalidateQueries({ queryKey: keys.counts });
      void qc.invalidateQueries({ queryKey: ["thread"] });
    });
    // the access token this socket authenticated with ran out: renew it and reconnect (log out only when renewal is impossible)
    socket.on("auth:expired", () => {
      void refreshAccess().then((ok) => (ok ? reconnectLater(200) : logout()));
    });
    socket.on("connect_error", (err: Error & { data?: { code?: string } }) => {
      setStatus("disconnected");
      if (err.data?.code && AUTH_CODES.has(err.data.code)) logout();
      // the server asked us to back off (capacity, drain, rate limit): honour its hint on top of the built-in backoff
      const wait = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms;
      if (wait) {
        socket.io.opts.reconnectionDelay = Math.max(socket.io.opts.reconnectionDelay ?? 1000, wait);
      }
    });
    socket.io.on("reconnect_attempt", () => setStatus("connecting"));

    socket.on("message:new", (p: MessageEventPayload) => onMessageNew(qc, p, ctx));
    socket.on("message:updated", (p: MessageEventPayload) => onMessageUpdated(qc, p, ctx));
    socket.on("message:deleted", (p: { message_id: string; room_id: string }) => onMessageDeleted(qc, p));
    socket.on("message:receipt", (p: ReceiptPayload) => onReceipt(qc, p));
    socket.on("room:new", (p: { room: Room }) => onRoomNew(qc, p.room, ctx));
    socket.on("room:updated", (p: { room: Room }) => onRoomUpdated(qc, p.room, ctx));
    socket.on("room:deleted", (p: { room_id: string }) => onRoomDeleted(qc, p.room_id));
    socket.on("room:unread", (p: { room_id: string; unread_count: number }) => onRoomUnread(qc, p.room_id, p.unread_count, ctx));
    socket.on("notification:new", (p: { notification: NotificationItem; unread_count: number }) => onNotificationNew(qc, p));
    socket.on("notification:read", (p: { id?: string; all?: boolean; unread_count: number }) => onNotificationRead(qc, p));
    for (const ev of ["inbox:new", "inbox:updated"]) socket.on(ev, () => void qc.invalidateQueries({ queryKey: keys.inboxes }));
    for (const ev of ["member:updated", "member:removed"]) socket.on(ev, () => void qc.invalidateQueries({ queryKey: keys.members }));
    socket.on("contact:updated", (c: { id: string }) => {
      void qc.invalidateQueries({ queryKey: keys.contact(c.id) });
      void qc.invalidateQueries({ queryKey: keys.rooms });
    });
    socket.on("presence:update", (p: { member_id: string; online: boolean }) =>
      setOnline((cur) => {
        const next = new Set(cur);
        if (p.online) next.add(p.member_id);
        else next.delete(p.member_id);
        return next;
      }),
    );
    socket.on("visitor:presence", (p: { room_id: string; online: boolean }) => setVisitorOnline((cur) => ({ ...cur, [p.room_id]: p.online })));
    socket.on("typing", (p: TypingEvent) => {
      if (p.who.type === "agent" && p.who.id === memberId) return;
      clearTimeout(timers.get(p.room_id));
      const clear = () => setTyping((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => k !== p.room_id)));
      if (!p.typing) return clear();
      setTyping((cur) => ({ ...cur, [p.room_id]: p.who }));
      timers.set(p.room_id, setTimeout(clear, TYPING_TTL_MS));
    });

    return () => {
      for (const t of timers.values()) clearTimeout(t);
      clearTimeout(manualTimer);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setStatus("connecting");
    };
  }, [signedIn, workspaceId, memberId, qc, logout]);

  const emit = useCallback(<T extends object>(event: string, payload: object, timeoutMs = 10_000): Promise<Ack<T>> => {
    const socket = socketRef.current;
    if (!socket?.connected) return Promise.reject(new Error("Not connected"));
    return socket.timeout(timeoutMs).emitWithAck(event, payload) as Promise<Ack<T>>;
  }, []);

  const value = useMemo<SocketValue>(
    () => ({ status, connected: status === "connected", emit, typing, onlineMembers: online, visitorOnline }),
    [status, emit, typing, online, visitorOnline],
  );
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketValue {
  const v = useContext(SocketContext);
  if (!v) throw new Error("useSocket must be used inside <SocketProvider>");
  return v;
}
