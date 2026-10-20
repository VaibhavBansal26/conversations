import { AlertTriangle, Sparkles } from "lucide-react";
import { errorMessage, isAiUnavailable } from "../lib/apiError";
import { Button } from "./button";
import { cn } from "./cn";

interface Props {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}

/** Shows the server's message verbatim; AI outages get a calm, non-blocking wording. */
export function ErrorNotice({ error, onRetry, compact }: Props) {
  if (isAiUnavailable(error)) {
    return (
      <p className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-muted-foreground" role="status">
        <Sparkles className="size-4 shrink-0" aria-hidden="true" /> AI unavailable right now. Everything else keeps working.
      </p>
    );
  }
  return (
    <div className={cn("flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-3 text-[13px] text-danger-text", compact ? "py-1.5" : "py-2.5")} role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{errorMessage(error)}</span>
      {onRetry && (
        <Button variant="ghost" size="sm" className="-my-1 h-7 text-danger-text hover:bg-danger/10" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
