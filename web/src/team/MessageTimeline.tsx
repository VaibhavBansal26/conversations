import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui";
import { buildTeamItems } from "./grouping";
import { TeamMessageView, type TeamMessageHandlers } from "./TeamMessageView";
import type { TeamThreadCache } from "./types";

interface Props extends TeamMessageHandlers {
  thread: TeamThreadCache;
  selfId: string;
  online: ReadonlySet<string>;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  canModerate: boolean;
  readOnly: boolean;
  label: string;
  /** shown when there is nothing yet */
  empty?: string;
  /** called when the reader is at the bottom and the newest message is visible (to move the read cursor) */
  onSeenNewest?: () => void;
  inThread?: boolean;
  highlightId?: string | null;
  editRequestId?: string | null;
  onEditStarted?: () => void;
}

const NEAR_BOTTOM_PX = 120;
const LOAD_OLDER_PX = 160;

/**
 * Virtualised message list: only the rows near the viewport are in the DOM however long the history is. Rows are measured (messages differ in
 * height), the view follows the newest message while the reader is at the bottom, and older pages are prepended without moving what is read.
 */
export function MessageTimeline({ thread, selfId, online, loadingOlder, onLoadOlder, canModerate, readOnly, label, empty, onSeenNewest, inThread, highlightId, editRequestId, onEditStarted, ...handlers }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const items = useMemo(() => buildTeamItems(thread.messages), [thread.messages]);
  const atBottom = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const firstKey = useRef<string | null>(null);
  const lastKey = useRef<string | null>(null);
  const count = items.length;

  const virt = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (items[i]?.type === "day" ? 40 : 64),
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 8,
    // jsdom has no layout; a real browser measures the element straight away
    initialRect: { width: 800, height: 600 },
  });

  const scrollToEnd = (smooth = false) => {
    if (count === 0) return;
    virt.scrollToIndex(count - 1, { align: "end", behavior: smooth ? "smooth" : "auto" });
    // dynamic row heights settle after the first pass: land on the real bottom
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    setUnseen(0);
  };

  useLayoutEffect(() => {
    const first = items.find((i) => i.type === "message")?.key ?? null;
    const last = [...items].reverse().find((i) => i.type === "message");
    const lastK = last?.key ?? null;
    const lastMsg = last && last.type === "message" ? last.message : null;
    if (firstKey.current !== null && first !== firstKey.current) {
      // older messages were prepended: keep the row that was first on screen where it was
      const idx = items.findIndex((i) => i.type === "message" && i.key === firstKey.current);
      if (idx > 0) virt.scrollToIndex(idx, { align: "start" });
    } else if (lastK !== lastKey.current) {
      const initial = lastKey.current === null;
      if (initial || atBottom.current || lastMsg?.local || lastMsg?.sender.id === selfId) scrollToEnd();
      else setUnseen((n) => n + 1);
    }
    firstKey.current = first;
    lastKey.current = lastK;
  }, [items]);

  useEffect(() => {
    if (atBottom.current) onSeenNewest?.();
  }, [thread.messages.at(-1)?.id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setAway(!atBottom.current);
    if (atBottom.current) {
      setUnseen(0);
      onSeenNewest?.();
    }
    if (el.scrollTop < LOAD_OLDER_PX && thread.hasMoreBefore && !loadingOlder) onLoadOlder();
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-2 pb-3 pt-2 md:px-4" role="log" aria-label={label} aria-relevant="additions" tabIndex={0} data-testid="team-timeline">
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
        {count === 0 && <p className="py-16 text-center text-sm text-subtle">{empty ?? "No messages yet."}</p>}
        <div style={{ height: virt.getTotalSize(), position: "relative", width: "100%" }}>
          {virt.getVirtualItems().map((v) => {
            const item = items[v.index];
            if (!item) return null;
            return (
              <div key={v.key} data-index={v.index} ref={virt.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}>
                {item.type === "day" ? (
                  <div className="my-3 flex justify-center" role="separator" aria-label={item.label}>
                    <span className="rounded-full border border-border bg-surface px-3 py-0.5 text-xs font-medium text-muted-foreground shadow-xs">{item.label}</span>
                  </div>
                ) : (
                  <TeamMessageView
                    message={item.message}
                    selfId={selfId}
                    first={item.first}
                    online={item.first ? online.has(item.message.sender.id) : undefined}
                    inThread={inThread}
                    canModerate={canModerate}
                    readOnly={readOnly}
                    highlight={highlightId === item.message.id}
                    editRequestId={editRequestId}
                    onEditStarted={onEditStarted}
                    {...handlers}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {unseen > 0 || away ? (
        <Button variant="outline" size="icon" className="absolute bottom-3 right-4 rounded-full shadow-md" aria-label={unseen > 0 ? `Scroll to latest, ${unseen} new` : "Scroll to latest message"} onClick={() => scrollToEnd(true)}>
          <ArrowDown />
          {unseen > 0 && <span className="absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground">{unseen}</span>}
        </Button>
      ) : null}
    </div>
  );
}
