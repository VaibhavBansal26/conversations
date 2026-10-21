import type { TicketStatus } from "../../api/types";
import { TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from "../../lib/tickets";
import { Badge } from "../../ui";

/**
 * `#12 Open`: the ticket number and its status, the same chip in the thread header, the lists and the contact history.
 * `collapse` hides the status words inside a narrow container (they stay available to screen readers).
 */
export function TicketChip({ number, status, className, collapse }: { number?: number; status: TicketStatus; className?: string; collapse?: boolean }) {
  return (
    <Badge tone={TICKET_STATUS_TONE[status]} className={className}>
      {number !== undefined && <span className="tabular-nums">#{number}</span>}
      <span className={collapse ? "@max-lg:sr-only" : undefined}>{TICKET_STATUS_LABEL[status]}</span>
    </Badge>
  );
}
