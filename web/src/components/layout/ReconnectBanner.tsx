import { RefreshCw, WifiOff } from "lucide-react";
import { useSocket } from "../../realtime/SocketProvider";

/** Shown while the realtime socket is down; sends fall back to REST, new messages resync on reconnect. */
export function ReconnectBanner() {
  const { status } = useSocket();
  if (status === "connected") return null;
  const connecting = status === "connecting";
  return (
    <div className="flex items-center justify-center gap-2 border-b border-warning-border bg-warning-soft px-4 py-1.5 text-[13px] text-warning-text" role="status" aria-live="polite">
      {connecting ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <WifiOff className="size-3.5" aria-hidden="true" />}
      {connecting ? "Connecting to live updates…" : "Connection lost. Reconnecting… You can keep working; messages send over a fallback connection."}
    </div>
  );
}
