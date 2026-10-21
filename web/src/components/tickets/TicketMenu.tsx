import { CheckCheck, Flag, RotateCcw, Ticket as TicketIcon } from "lucide-react";
import { useTicketActions } from "../../api/ticketHooks";
import type { TicketBrief, TicketPriority } from "../../api/types";
import { useCan } from "../../auth/AuthContext";
import { PRIORITY_LABEL } from "../../lib/tickets";
import { DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui";
import { TicketChip } from "./TicketChip";

/** The ticket chip of a conversation as a menu: resolve, close, reopen, set the priority. Read-only seats just see the chip. */
export function TicketMenu({ ticket }: { ticket: TicketBrief }) {
  const canWrite = useCan("tickets:write");
  const canClose = useCan("tickets:close");
  const actions = useTicketActions();
  const ended = ticket.status === "resolved" || ticket.status === "closed";
  if (!canWrite && !canClose) return <TicketChip number={ticket.number} status={ticket.status} collapse />;
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger aria-label={`Ticket #${ticket.number}, ${ticket.status.replace(/_/g, " ")}`} className="rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary">
        <TicketChip number={ticket.number} status={ticket.status} className="cursor-pointer hover:brightness-95" collapse />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>
          <span className="inline-flex items-center gap-1.5">
            <TicketIcon className="size-3.5" aria-hidden="true" /> Ticket #{ticket.number}
          </span>
        </DropdownMenuLabel>
        {canClose && !ended && (
          <DropdownMenuItem onSelect={() => actions.resolve.mutate(ticket.id)}>
            <CheckCheck className="size-4 text-subtle" aria-hidden="true" /> Mark as resolved
          </DropdownMenuItem>
        )}
        {canClose && ended && ticket.status === "resolved" && (
          <DropdownMenuItem onSelect={() => actions.close.mutate(ticket.id)}>
            <CheckCheck className="size-4 text-subtle" aria-hidden="true" /> Close ticket
          </DropdownMenuItem>
        )}
        {canWrite && ended && (
          <DropdownMenuItem onSelect={() => actions.reopen.mutate(ticket.id)}>
            <RotateCcw className="size-4 text-subtle" aria-hidden="true" /> Reopen
          </DropdownMenuItem>
        )}
        {canWrite && !ended && (
          <>
            <DropdownMenuItem onSelect={() => actions.patch.mutate({ id: ticket.id, status: ticket.status === "pending_customer" ? "open" : "pending_customer" })}>
              {ticket.status === "pending_customer" ? "Customer replied: mark open" : "Waiting for the customer"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              <span className="inline-flex items-center gap-1.5">
                <Flag className="size-3.5" aria-hidden="true" /> Priority
              </span>
            </DropdownMenuLabel>
            {([0, 1, 2, 3] as TicketPriority[]).map((p) => (
              <DropdownMenuCheckItem key={p} checked={ticket.priority === p} onSelect={() => actions.patch.mutate({ id: ticket.id, priority: p })}>
                {PRIORITY_LABEL[p]}
              </DropdownMenuCheckItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
