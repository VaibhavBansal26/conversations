import { useSocket } from "../../realtime/SocketProvider";
import { Icon } from "../ui/Icon";

/** Shown while the realtime socket is down; sends fall back to REST, new messages resync on reconnect. */
export function ReconnectBanner() {
  const { status } = useSocket();
  if (status === "connected") return null;
  return (
    <div className="banner" role="status" aria-live="polite">
      <Icon name="refresh" size={14} />
      {status === "connecting" ? "Connecting to live updates…" : "Connection lost. Reconnecting… You can keep working; messages send over a fallback connection."}
    </div>
  );
}
