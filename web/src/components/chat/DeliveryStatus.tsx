import { Check, CheckCheck, Clock, FlaskConical } from "lucide-react";
import type { Message } from "../../api/types";
import { sendStateOf } from "../../state/optimistic";

/**
 * Tick state of an outgoing message: pending clock, sent check, delivered double check, read (accent) double check.
 * A message stored in test mode never gets a tick: nothing was sent, so "sent", "delivered" and "read" would be lies.
 */
export function DeliveryStatus({ message }: { message: Message }) {
  const state = sendStateOf(message);
  if (state === "failed" || message.delivery === "failed") return null;
  if (message.delivery === "not_sent_test_mode") {
    return (
      <span className="inline-flex items-center gap-1 font-medium" data-state="test-mode">
        <FlaskConical className="size-3" aria-hidden="true" /> Test mode: not sent
      </span>
    );
  }
  if (state === "sending" || message.delivery === "pending") {
    return (
      <span className="inline-flex" role="img" aria-label="Sending">
        <Clock className="size-3" aria-hidden="true" />
      </span>
    );
  }
  if (message.read) {
    return (
      <span className="inline-flex text-sky-200" role="img" aria-label="Read" data-state="read">
        <CheckCheck className="size-3.5" aria-hidden="true" />
      </span>
    );
  }
  if (message.delivery === "delivered") {
    return (
      <span className="inline-flex" role="img" aria-label="Delivered">
        <CheckCheck className="size-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="inline-flex" role="img" aria-label="Sent">
      <Check className="size-3.5" aria-hidden="true" />
    </span>
  );
}
