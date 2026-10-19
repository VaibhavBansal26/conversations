import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { AiSuggestions } from "../../api/types";
import { isAiUnavailable } from "../../lib/apiError";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Icon } from "../ui/Icon";

interface Props {
  roomId: string;
  /** Suggestions are tied to the customer message they answer. */
  triggerMessageId: string | null;
  onPick: (text: string) => void;
}

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
    <div className="suggestions" aria-label="AI suggested replies">
      <span className="suggestions-label">
        <Icon name="sparkles" size={14} /> Suggested
      </span>
      {q.isPending && (
        <span className="chip skeleton" role="status">
          Thinking…
        </span>
      )}
      {q.isError && !isAiUnavailable(q.error) && <ErrorNotice error={q.error} compact />}
      {q.isError && isAiUnavailable(q.error) && <span className="muted">AI unavailable</span>}
      {q.data?.suggestions.slice(0, 3).map((s) => (
        <button key={s.text} type="button" className="chip suggestion" onClick={() => onPick(s.text)} title={s.text}>
          {s.text}
        </button>
      ))}
      <button type="button" className="icon-btn sm" aria-label="Refresh suggestions" onClick={() => void q.refetch()} disabled={q.isFetching}>
        <Icon name="refresh" size={14} />
      </button>
    </div>
  );
}
