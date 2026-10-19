import { useEffect, useId, useRef, useState } from "react";
import type { Message } from "../../api/types";
import { formatClock } from "../../lib/time";
import { getWorkerClient, CancelledError } from "../../workers/client";
import type { SearchHit } from "../../workers/protocol";
import { Icon } from "../ui/Icon";

interface Props {
  messages: Message[];
  /** older pages exist on the server that are not loaded here */
  hasOlder: boolean;
  onLoadOlder: () => void;
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
    parts.push(<mark key={i}>{hit.snippet.slice(s, e)}</mark>);
    at = e;
  });
  parts.push(hit.snippet.slice(at));
  return <>{parts}</>;
}

export function jumpToMessage(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.classList.add("found");
  setTimeout(() => el.classList.remove("found"), 1800);
}

/** Search the messages already loaded in this conversation. The scan runs off the main thread and is cancelled by the next keystroke. */
export function ThreadSearch({ messages, hasOlder, onLoadOlder }: Props) {
  const [open, setOpen] = useState(false);
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

  if (!open) {
    return (
      <div className="thread-search closed">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label="Search in this conversation">
          <Icon name="search" size={14} /> Search conversation
        </button>
      </div>
    );
  }
  return (
    <div className="thread-search" role="search">
      <div className="row">
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
              setOpen(false);
              setQ("");
            }
          }}
          aria-controls={listId}
        />
        <button type="button" className="icon-btn sm" aria-label="Close search" onClick={() => { setOpen(false); setQ(""); }}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div id={listId} aria-live="polite">
        {hits && (
          <>
            <p className="hint">
              {hits.length === 0 ? "No matches" : `${hits.length}${hits.length === 50 ? "+" : ""} match${hits.length === 1 ? "" : "es"}`} in {messages.length} loaded messages
              {hasOlder && (
                <>
                  {" "}
                  <button type="button" className="link-btn" onClick={onLoadOlder}>
                    Load older messages
                  </button>
                </>
              )}
            </p>
            <ul className="hits">
              {hits.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => jumpToMessage(h.id)}>
                    <span className="who">{h.sender}</span> <time dateTime={h.at}>{formatClock(h.at)}</time>
                    <span className="snip">
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
