import { errorMessage, isAiUnavailable } from "../../lib/apiError";
import { Icon } from "./Icon";

interface Props {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}

/** Shows the server's message verbatim; AI outages get a calm, non-blocking wording. */
export function ErrorNotice({ error, onRetry, compact }: Props) {
  if (isAiUnavailable(error)) {
    return (
      <p className="notice notice-muted" role="status">
        <Icon name="sparkles" size={14} /> AI unavailable right now. Everything else keeps working.
      </p>
    );
  }
  return (
    <div className={`notice notice-error${compact ? " compact" : ""}`} role="alert">
      <Icon name="alert" size={16} />
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
