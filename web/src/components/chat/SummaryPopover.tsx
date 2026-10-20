import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api } from "../../api/client";
import type { AiSummary } from "../../api/types";
import { ErrorNotice, LoadingBlock, Popover, Sheet, Tooltip, buttonVariants, cn } from "../../ui";

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h4>
      <ul className="list-disc space-y-0.5 pl-4 text-[13px]">
        {items.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </section>
  );
}

export function SummaryBody({ roomId }: { roomId: string }) {
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
    <div className="space-y-3 text-sm">
      <p className="leading-relaxed">{s.summary}</p>
      <List title="Key facts" items={s.key_facts} />
      <List title="Open questions" items={s.open_questions} />
      {s.next_action && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">Next action</h4>
          <p className="rounded-md bg-primary-soft px-3 py-2 text-[13px] text-primary-text">{s.next_action}</p>
        </section>
      )}
      {s.truncated && <p className="text-xs text-subtle">Long conversation: only the most recent messages were summarised.</p>}
    </div>
  );
}

interface Props {
  roomId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** render as a bottom sheet (no trigger) */
  sheet?: boolean;
}

export function SummaryPopover({ roomId, open, onOpenChange, sheet }: Props) {
  if (sheet) {
    return (
      <Sheet open={!!open} onOpenChange={(o) => onOpenChange?.(o)} side="bottom" title="AI summary">
        <div className="overflow-y-auto p-4 pt-2">
          <SummaryBody roomId={roomId} />
        </div>
      </Sheet>
    );
  }
  return (
    <Popover
      label="AI summary"
      trigger={
        <Tooltip content="Summarise with AI">
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-4" aria-hidden="true" /> <span className="@max-2xl:hidden">Summary</span>
          </span>
        </Tooltip>
      }
      triggerClassName={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-9")}
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      panelClassName="w-80 p-4"
    >
      <SummaryBody roomId={roomId} />
    </Popover>
  );
}
