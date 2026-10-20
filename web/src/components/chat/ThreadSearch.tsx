import { useEffect, useId, useRef, useState } from "react";
import type { Message } from "../../api/types";
import { formatClock } from "../../lib/time";
import { getWorkerClient, CancelledError } from "../../workers/client";
import type { SearchHit } from "../../workers/protocol";
import { Search, X } from "lucide-react";
import { Button } from "../../ui";

interface Props {
  messages: Message[];
  /** older pages exist on the server that are not loaded here */
  hasOlder: boolean;
  onLoadOlder: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEBOUNCE_MS = 150;
/** Below this many messages the worker round trip costs more than searching inline. */
const WORKER_FROM = 2000;

/** Highlight match ranges inside a snippet without ever injecting HTML. */
function Highlighted({ hit }: { hit: SearchHit }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  hit.ranges.forEach(([s, e], i) => {
    if (s > at) parts.push(hit.snippet.slice(at, s));
    parts.push(<mark key={i} className="rounded bg-warning-soft px-0.5 text-warning-text">{hit.snippet.slice(s, e)}</mark>);
    at = e;
  });
  parts.push(hit.snippet.slice(at));
  return <>{parts}</>;
}

export function jumpToMessage(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.dataset.found = "true";
  setTimeout(() => delete el.dataset.found, 1800);
}

/** Search the messages already loaded in this conversation. The scan runs off the main thread and is cancelled by the next keystroke. */
export function ThreadSearch({ messages, hasOlder, onLoadOlder, open, onOpenChange: setOpen }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      const items = messages.filter((m) => m.kind !== "system" && !m.deleted).map((m) => ({ id: m.id, text: m.content_text || "", sender: m.sender.name, at: m.created_at }));
      getWorkerClient()
        .run("search", { items, query: q, limit: 50 }, { signal: ac.signal, size: items.length, inlineBelow: WORKER_FROM })
        .then(setHits)
        .catch((e) => !(e instanceof CancelledError) && setHits([]));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, messages]);

  if (!open) return null;
  return (
    <div className="border-b border-border bg-surface px-3 py-2 md:px-5" role="search">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <label className="sr-only" htmlFor={`${listId}-q`}>
            Search in this conversation
          </label>
          <input
            id={`${listId}-q`}
            ref={input}
            type="search"
            placeholder="Search messages in this conversation"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
                setQ("");
              }
            }}
            aria-controls={listId}
            className="h-9 w-full rounded-md border border-border-strong bg-surface-2 pl-8 pr-3 text-sm focus-visible:border-ring focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close search" onClick={() => { setOpen(false); setQ(""); }}>
          <X />
        </Button>
      </div>
      <div id={listId} aria-live="polite">
        {hits && (
          <>
            <p className="mt-2 text-xs text-subtle">
              {hits.length === 0 ? "No matches" : `${hits.length}${hits.length === 50 ? "+" : ""} match${hits.length === 1 ? "" : "es"}`} in {messages.length} loaded messages
              {hasOlder && (
                <>
                  {" "}
                  <button type="button" className="font-medium text-primary-text underline-offset-2 hover:underline" onClick={onLoadOlder}>
                    Load older messages
                  </button>
                </>
              )}
            </p>
            <ul className="mt-1 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {hits.map((h) => (
                <li key={h.id}>
                  <button type="button" className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-[13px] hover:bg-surface-2" onClick={() => jumpToMessage(h.id)}>
                    <span className="flex items-center gap-2 text-xs text-subtle">
                      <span className="font-medium text-muted-foreground">{h.sender}</span> <time dateTime={h.at}>{formatClock(h.at)}</time>
                    </span>
                    <span className="line-clamp-2">
                      <Highlighted hit={h} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
