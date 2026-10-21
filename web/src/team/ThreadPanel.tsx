import { X } from "lucide-react";
import { useRef } from "react";
import { useMembers } from "../api/hooks";
import { useSession, useCan } from "../auth/AuthContext";
import { useSocket } from "../realtime/SocketProvider";
import { Button, ErrorNotice, Skeleton } from "../ui";
import { useTeamActions } from "./actions";
import { MessageTimeline } from "./MessageTimeline";
import { TeamComposer } from "./TeamComposer";
import { TypingLine } from "./TypingLine";
import { useTeamThread } from "./hooks";
import type { TeamChannel } from "./types";

export function ThreadPanel({ channel, rootId, onClose, readOnly }: { channel: TeamChannel; rootId: string; onClose: () => void; readOnly: boolean }) {
  const { member } = useSession();
  const thread = useTeamThread(rootId);
  const actions = useTeamActions(channel.id);
  const socket = useSocket();
  const canModerate = useCan("team_chat:moderate");
  const members = useMembers();
  void members;
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <section aria-label="Thread" className="flex h-full min-h-0 w-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Thread</h2>
          <p className="truncate text-xs text-muted-foreground">{channel.kind === "channel" ? `#${channel.name}` : channel.title}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close thread" onClick={onClose}>
          <X />
        </Button>
      </header>
      {thread.isPending && <div className="p-4"><Skeleton className="h-24" /></div>}
      {thread.isError && <div className="p-4"><ErrorNotice error={thread.error} onRetry={() => void thread.refetch()} /></div>}
      {thread.data && (
        <MessageTimeline
          thread={thread.data}
          selfId={member.id}
          online={socket.onlineMembers}
          loadingOlder={false}
          onLoadOlder={() => undefined}
          canModerate={canModerate}
          readOnly={readOnly}
          label="Thread messages"
          inThread
          onReact={(m, e) => void actions.react(m, e)}
          onEdit={actions.edit}
          onDelete={(m) => void actions.remove(m, m.sender.id !== member.id)}
          onRetry={actions.retry}
        />
      )}
      <TypingLine channelId={channel.id} threadRootId={rootId} />
      <TeamComposer
        draftKey={`${channel.id}:${rootId}`}
        channelId={channel.id}
        threadRootId={rootId}
        placeholder="Reply…"
        textareaRef={box}
        compact
        disabled={readOnly}
        disabledReason="This channel is archived or you are not a member."
        onSend={(a) => void actions.send({ channelId: channel.id, content: a.content, attachmentIds: a.attachmentIds, threadRootId: rootId }).catch(() => undefined)}
      />
    </section>
  );
}
