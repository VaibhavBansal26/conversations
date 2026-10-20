import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { AiSummary } from "../../api/types";
import { ErrorNotice } from "../../ui";
import { Icon } from "../../ui";
import { LoadingBlock } from "../../ui";
import { Popover } from "../../ui";

function SummaryBody({ roomId }: { roomId: string }) {
  const q = useQuery({
    queryKey: ["ai-summary", roomId],
    queryFn: () => api.post<AiSummary>("/ai/summary", { room_id: roomId }),
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (q.isPending) return <LoadingBlock label="Summarising" />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <div className="summary">
      <p>{s.summary}</p>
      {s.key_facts.length > 0 && (
        <section>
          <h4>Key facts</h4>
          <ul>{s.key_facts.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>
      )}
      {s.open_questions.length > 0 && (
        <section>
          <h4>Open questions</h4>
          <ul>{s.open_questions.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>
      )}
      {s.next_action && (
        <section>
          <h4>Next action</h4>
          <p>{s.next_action}</p>
        </section>
      )}
      {s.truncated && <p className="hint">Long conversation: only the most recent messages were summarised.</p>}
    </div>
  );
}

export function SummaryPopover({ roomId }: { roomId: string }) {
  return (
    <Popover label="AI summary" trigger={<><Icon name="sparkles" size={16} /> <span className="hide-sm">Summary</span></>} triggerClassName="btn btn-ghost btn-sm" align="end" panelClassName="summary-panel">
      <SummaryBody roomId={roomId} />
    </Popover>
  );
}
