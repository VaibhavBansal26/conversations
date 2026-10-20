import type { Message } from "../../api/types";
import { sendStateOf } from "../../state/optimistic";
import { Icon } from "../../ui";

/** Tick state of an outgoing message: pending clock, sent check, delivered double check, read (accent) double check. */
export function DeliveryStatus({ message }: { message: Message }) {
  const state = sendStateOf(message);
  if (state === "failed" || message.delivery === "failed") return null;
  if (state === "sending" || message.delivery === "pending") {
    return (
      <span className="ticks" role="img" aria-label="Sending">
        <Icon name="clock" size={13} />
      </span>
    );
  }
  if (message.read) {
    return (
      <span className="ticks read" role="img" aria-label="Read">
        <Icon name="checks" size={14} />
      </span>
    );
  }
  if (message.delivery === "delivered") {
    return (
      <span className="ticks" role="img" aria-label="Delivered">
        <Icon name="checks" size={14} />
      </span>
    );
  }
  return (
    <span className="ticks" role="img" aria-label="Sent">
      <Icon name="check" size={14} />
    </span>
  );
}
