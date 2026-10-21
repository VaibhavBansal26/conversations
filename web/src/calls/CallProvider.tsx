import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useCan } from "../auth/AuthContext";
import { useSocket } from "../realtime/SocketProvider";
import { toast } from "../ui";
import { CallPanel } from "./CallPanel";
import { CallEngine, type CallKind, type CallView } from "./engine";

export interface CallsConfig {
  browser: { enabled: boolean; voice: boolean; video: boolean; screen_share: boolean };
  ring_seconds: number;
  turn_provider: string;
  warning: string | null;
}
interface CallsValue {
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
  const available = canCall && !!cfg?.browser.enabled;
  const value = useMemo<CallsValue>(
    () => ({
      available,
      config: cfg,
      view,
      engine,
      start: async (roomId, kind) => {
        const r = await engine.start(roomId, kind);
        if (!r.ok) toast({ title: "Could not start the call", description: r.message, tone: "error" });
      },
    }),
    [available, cfg, view, engine],
  );
  return (
    <CallsContext.Provider value={value}>
      {children}
      <CallPanel />
    </CallsContext.Provider>
  );
}
