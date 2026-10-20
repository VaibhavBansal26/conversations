import { ArrowDown, Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message, TypingEvent } from "../../api/types";
import { buildItems } from "../../lib/grouping";
import type { Thread } from "../../state/messageCache";
import { Button } from "../../ui";
import { MessageBubble, type BubbleProps } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";

interface Props {
  thread: Thread;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  selfMemberId: string;
  contactName?: string;
  contactSeed?: string;
  editWindowSeconds: number;
  typing?: TypingEvent["who"];
  handlers: Pick<BubbleProps, "onReply" | "onRetry" | "onEdit" | "onDelete">;
}

const NEAR_BOTTOM_PX = 96;
const LOAD_OLDER_PX = 120;

export function MessageList({ thread, loadingOlder, onLoadOlder, selfMemberId, contactName, contactSeed, editWindowSeconds, typing, handlers }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
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

  // images, voice notes and quoted blocks settle after the first paint: stay pinned to the newest message while the reader is at the bottom
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current && prevHeight.current === null) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

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
    <div className="relative min-h-0 flex-1">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div ref={scroller} className="h-full overflow-y-auto overscroll-contain px-3 pb-3 pt-2 md:px-5" onScroll={onScroll} role="log" aria-label="Conversation messages" tabIndex={0}>
        <div ref={content}>
        {thread.hasMoreBefore && (
          <div className="flex justify-center py-2">
            {loadingOlder ? (
              <span role="status" aria-label="Loading earlier messages">
                <Loader2 className="size-5 animate-spin text-subtle motion-reduce:animate-none" aria-hidden="true" />
              </span>
            ) : (
              <Button variant="ghost" size="sm" onClick={onLoadOlder}>
                Load earlier messages
              </Button>
            )}
          </div>
        )}
        {items.length === 0 && <p className="py-16 text-center text-sm text-subtle">No messages yet. Say hello below.</p>}
        {items.map((item) =>
          item.type === "day" ? (
            <div key={item.key} className="sticky top-1 z-10 my-3 flex justify-center" role="separator" aria-label={item.label}>
              <span className="rounded-full border border-border bg-surface/95 px-3 py-0.5 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur">{item.label}</span>
            </div>
          ) : (
            <MessageBubble
              key={item.key}
              message={item.message}
              selfMemberId={selfMemberId}
              contactName={contactName}
              contactSeed={contactSeed}
              first={item.first}
              last={item.last}
              editWindowOpen={Date.now() - new Date(item.message.created_at).getTime() < editWindowSeconds * 1000}
              {...handlers}
            />
          ),
        )}
        <TypingIndicator who={typing} />
        </div>
      </div>
      {unseen > 0 || away ? (
        <Button
          variant="outline"
          size="icon"
          className="absolute bottom-3 right-4 rounded-full shadow-md"
          aria-label={unseen > 0 ? `Scroll to latest, ${unseen} new` : "Scroll to latest message"}
          onClick={() => scrollToBottom(true)}
        >
          <ArrowDown />
          {unseen > 0 && <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground">{unseen}</span>}
        </Button>
      ) : null}
    </div>
  );
}
