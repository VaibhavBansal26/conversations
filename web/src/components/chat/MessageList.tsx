import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message, TypingEvent } from "../../api/types";
import { buildItems } from "../../lib/grouping";
import type { Thread } from "../../state/messageCache";
import { Icon } from "../../ui";
import { Spinner } from "../../ui";
import { MessageBubble, type BubbleProps } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";

interface Props {
  thread: Thread;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  selfMemberId: string;
  contactName?: string;
  editWindowSeconds: number;
  typing?: TypingEvent["who"];
  handlers: Pick<BubbleProps, "onReply" | "onRetry" | "onEdit" | "onDelete">;
}

const NEAR_BOTTOM_PX = 96;
const LOAD_OLDER_PX = 120;

export function MessageList({ thread, loadingOlder, onLoadOlder, selfMemberId, contactName, editWindowSeconds, typing, handlers }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const lastKey = useRef<string | null>(null);
  const firstKey = useRef<string | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [away, setAway] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const items = useMemo(() => buildItems(thread.messages), [thread.messages]);
  const last: Message | undefined = thread.messages[thread.messages.length - 1];
  const first: Message | undefined = thread.messages[0];

  const scrollToBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    setUnseen(0);
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const lastId = last ? (last.client_msg_id ?? last.id) : null;
    const firstId = first ? (first.client_msg_id ?? first.id) : null;
    if (prevHeight.current !== null && firstId !== firstKey.current) {
      // older messages were prepended: keep the viewport anchored on what the agent was reading
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (lastId !== lastKey.current) {
      const initial = lastKey.current === null;
      if (initial || atBottom.current || last?.local) scrollToBottom();
      else setUnseen((n) => n + 1);
      if (!initial && last && last.sender.type === "contact" && last.kind !== "system") setAnnouncement(`New message from ${last.sender.name || "customer"}: ${last.content_text.slice(0, 120)}`);
    }
    lastKey.current = lastId;
    firstKey.current = firstId;
  }, [first, last]);

  useEffect(() => {
    if (typing && atBottom.current) scrollToBottom();
  }, [typing]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setAway(!atBottom.current);
    if (atBottom.current) setUnseen(0);
    if (el.scrollTop < LOAD_OLDER_PX && thread.hasMoreBefore && !loadingOlder) {
      prevHeight.current = el.scrollHeight;
      onLoadOlder();
    }
  };

  return (
    <div className="messages-wrap">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div ref={scroller} className="messages" onScroll={onScroll} role="log" aria-label="Conversation messages" tabIndex={0}>
        {thread.hasMoreBefore && (
          <div className="load-older">
            {loadingOlder ? (
              <Spinner label="Loading earlier messages" />
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onLoadOlder}>
                Load earlier messages
              </button>
            )}
          </div>
        )}
        {items.map((item) =>
          item.type === "day" ? (
            <div key={item.key} className="day-sep" role="separator" aria-label={item.label}>
              <span>{item.label}</span>
            </div>
          ) : (
            <MessageBubble
              key={item.key}
              message={item.message}
              selfMemberId={selfMemberId}
              contactName={contactName}
              first={item.first}
              last={item.last}
              editWindowOpen={Date.now() - new Date(item.message.created_at).getTime() < editWindowSeconds * 1000}
              {...handlers}
            />
          ),
        )}
        <TypingIndicator who={typing} />
      </div>
      {unseen > 0 || away ? (
        <button type="button" className="scroll-down" aria-label={unseen > 0 ? `Scroll to latest, ${unseen} new` : "Scroll to latest message"} onClick={() => scrollToBottom(true)}>
          <Icon name="arrowDown" size={16} />
          {unseen > 0 && <span className="badge">{unseen}</span>}
        </button>
      ) : null}
    </div>
  );
}
