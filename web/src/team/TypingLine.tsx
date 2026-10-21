import { useSocket } from "../realtime/SocketProvider";

/** "Ann is typing…" for the channel (or one thread). Quiet when nobody is. */
export function TypingLine({ channelId, threadRootId = null }: { channelId: string; threadRootId?: string | null }) {
  const { teamTyping } = useSocket();
  const who = (teamTyping[channelId] ?? []).filter((t) => (t.thread_root_id ?? null) === threadRootId);
  const text = who.length === 0 ? "" : who.length === 1 ? `${who[0]!.name} is typing…` : who.length === 2 ? `${who[0]!.name} and ${who[1]!.name} are typing…` : "Several people are typing…";
  return (
    <div className="h-5 shrink-0 px-4 text-xs text-subtle" aria-live="polite" role="status">
      {text}
    </div>
  );
}
