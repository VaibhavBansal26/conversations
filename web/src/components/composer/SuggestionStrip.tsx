import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { api } from "../../api/client";
import type { AiSuggestions } from "../../api/types";
import { isAiUnavailable } from "../../lib/apiError";
import { ErrorNotice, Skeleton } from "../../ui";

interface Props {
  roomId: string;
  /** Suggestions are tied to the customer message they answer. */
  triggerMessageId: string | null;
  onPick: (text: string) => void;
}

/** AI suggested replies: one tap puts the text in the composer, nothing is ever sent automatically. */
export function SuggestionStrip({ roomId, triggerMessageId, onPick }: Props) {
  const q = useQuery({
    queryKey: ["ai-suggestions", roomId, triggerMessageId],
    queryFn: () => api.post<AiSuggestions>("/ai/suggest-replies", { room_id: roomId }),
    enabled: !!triggerMessageId,
    retry: false,
    staleTime: Infinity,
  });
  if (!triggerMessageId) return null;

  return (
    <div className="mb-2 flex items-center gap-2" aria-label="AI suggested replies" role="group">
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary-text">
        <Sparkles className="size-3.5" aria-hidden="true" /> Suggested
      </span>
      <div className="scrollbar-none flex min-w-0 flex-1 gap-2 overflow-x-auto py-0.5">
        {q.isPending && (
          <span role="status" className="flex items-center gap-2">
            <Skeleton className="h-7 w-40 rounded-full" />
            <Skeleton className="h-7 w-32 rounded-full" />
            <span className="sr-only">Thinking…</span>
          </span>
        )}
        {q.isError && !isAiUnavailable(q.error) && <ErrorNotice error={q.error} compact />}
        {q.isError && isAiUnavailable(q.error) && <span className="text-xs text-subtle">AI unavailable</span>}
        {q.data?.suggestions.slice(0, 3).map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => onPick(s.text)}
            title={s.text}
            className="max-w-64 shrink-0 truncate rounded-full border border-primary/30 bg-primary-soft px-3 py-1 text-[13px] text-primary-text transition-colors hover:border-primary"
          >
            {s.text}
          </button>
        ))}
      </div>
      <button type="button" aria-label="Refresh suggestions" onClick={() => void q.refetch()} disabled={q.isFetching} className="grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-surface-2 disabled:opacity-50">
        <RefreshCw className={q.isFetching ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
      </button>
    </div>
  );
}
