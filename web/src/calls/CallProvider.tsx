import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useCan, useSession } from "../auth/AuthContext";
import { useSocket } from "../realtime/SocketProvider";
import { toast } from "../ui";
import { CallPanel } from "./CallPanel";
import { PhoneCallPanel } from "./PhoneCall";
import { CallEngine, type CallKind, type CallView } from "./engine";

export interface PhoneReadiness {
  enabled: boolean;
  ready: boolean;
  caller_id: string | null;
  allowed_countries: string[];
  problems: string[];
}
export interface CallsConfig {
  browser: { enabled: boolean; voice: boolean; video: boolean; screen_share: boolean };
  phone?: PhoneReadiness;
  ring_seconds: number;
  turn_provider: string;
  warning: string | null;
  ai?: { engine: "browser" | "realtime"; realtime_available: boolean; realtime_switched_off: boolean };
}
/** A phone call this member placed: Twilio rings their phone, then the contact's. Driven by `call:state` events; there is no media in the browser. */
export interface PhoneCallView {
  id: string;
  roomId: string;
  state: "ringing" | "connecting" | "active" | "declined" | "missed" | "ended" | "failed";
  endReason: string | null;
  endedBy: string | null;
  durationS: number | null;
  startedAt: number;
}
interface CallsValue {
  phoneCall: PhoneCallView | null;
  dismissPhoneCall(): void;
  hangUpPhone(): Promise<void>;
  /** calls are on for this workspace and this seat may place them */
  available: boolean;
  config: CallsConfig | null;
  view: CallView;
  start(roomId: string, kind: CallKind): Promise<void>;
  engine: CallEngine;
}
const CallsContext = createContext<CallsValue | null>(null);

/** Null outside the provider (a thread rendered on its own): call buttons simply do not show. */
export const useCalls = (): CallsValue | null => useContext(CallsContext);

export function useCallsConfig(enabled: boolean) {
  return useQuery({ queryKey: ["calls", "config"], enabled, staleTime: 60_000, queryFn: () => api.get<CallsConfig>("/calls/config") });
}

export function CallProvider({ children }: { children: ReactNode }) {
  const socket = useSocket();
  const canCall = useCan("calls:make");
  const cfg = useCallsConfig(canCall).data ?? null;
  const me = useSession().member.id;
  const [phoneCall, setPhoneCall] = useState<PhoneCallView | null>(null);
  const socketRef = useRef(socket);
  socketRef.current = socket;
  // one engine per signed-in tab; it reaches the live socket through the ref, so a reconnect needs no new engine
  const engine = useMemo(
    () =>
      new CallEngine({
        transport: {
          emit: (event, payload, timeoutMs) => socketRef.current.emit(event, payload, timeoutMs),
          subscribe: (event, handler) => socketRef.current.subscribe(event, handler),
        },
      }),
    [],
  );
  const [view, setView] = useState<CallView>(engine.state);
  useEffect(() => engine.subscribe(setView), [engine]);
  useEffect(() => () => engine.reset(), [engine]);
  // phone calls: follow the ones this member placed (the server publishes every state change to the room's team)
  useEffect(() => {
    if (!socket.connected) return;
    return socket.subscribe("call:state", ((p: { call: { id: string; room_id: string; transport: string; state: PhoneCallView["state"]; initiated_by: string; end_reason: string | null; ended_by: string | null; duration_s: number | null } }) => {
      const c = p.call;
      if (c.transport !== "phone" || c.initiated_by !== me) return;
      setPhoneCall((cur) => (cur && cur.id !== c.id && !["ended", "failed", "declined", "missed"].includes(cur.state) ? cur : { id: c.id, roomId: c.room_id, state: c.state, endReason: c.end_reason, endedBy: c.ended_by, durationS: c.duration_s, startedAt: cur?.id === c.id ? cur.startedAt : Date.now() }));
    }) as never);
  }, [socket, socket.connected, me]);
  const available = canCall && !!cfg?.browser.enabled;
  const value = useMemo<CallsValue>(
    () => ({
      available,
      config: cfg,
      view,
      engine,
      phoneCall,
      dismissPhoneCall: () => setPhoneCall(null),
      hangUpPhone: async () => {
        if (!phoneCall) return;
        try {
          await api.post(`/calls/${phoneCall.id}/hangup`, {});
        } catch (e) {
          toast({ title: "Could not hang up", description: e instanceof Error ? e.message : "Try again", tone: "error" });
        }
      },
      start: async (roomId, kind) => {
        const r = await engine.start(roomId, kind);
        if (!r.ok) toast({ title: "Could not start the call", description: r.message, tone: "error" });
      },
    }),
    [available, cfg, view, engine, phoneCall],
  );
  return (
    <CallsContext.Provider value={value}>
      {children}
      <CallPanel />
      <PhoneCallPanel />
    </CallsContext.Provider>
  );
}
