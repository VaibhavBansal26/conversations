import { ArrowRightLeft, Bot, CheckCheck, Flag, Hand, RotateCcw, Ticket as TicketIcon } from "lucide-react";
import { useDepartmentStatus } from "../../api/departmentHooks";
import { useTicketActions } from "../../api/ticketHooks";
import type { TicketBrief, TicketPriority } from "../../api/types";
import { useCan, useSession } from "../../auth/AuthContext";
import { PRIORITY_LABEL } from "../../lib/tickets";
import { DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui";
import { TicketChip } from "./TicketChip";

/** The ticket chip of a conversation as a menu: resolve, close, reopen, set the priority. Read-only seats just see the chip. */
export function TicketMenu({ ticket }: { ticket: TicketBrief }) {
  const canWrite = useCan("tickets:write");
  const canClose = useCan("tickets:close");
  const actions = useTicketActions();
  const me = useSession().member.id;
  const ended = ticket.status === "resolved" || ticket.status === "closed";
  const departments = useDepartmentStatus(canWrite && !ended).data ?? [];
  // a ticket that is waiting for a person (queued, or assigned to someone who has not answered) can be taken by any seat that sees it
  const claimable = canWrite && (ticket.status === "waiting_for_human" || ticket.status === "new" || ticket.status === "bot_handling") && ticket.handler !== `human:${me}`;
  const aiHandling = ticket.status === "bot_handling" && !!ticket.handler?.startsWith("bot:");
  // a person who has the ticket can give it back to the AI agent of its department
  const canHandBack = canWrite && !ended && !!ticket.handler?.startsWith("human:") && ticket.handler === `human:${me}`;
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
        {claimable && (
          <DropdownMenuItem onSelect={() => actions.claim.mutate(ticket.id)}>
            <Hand className="size-4 text-subtle" aria-hidden="true" /> {aiHandling ? "Take over from the AI agent" : "Take this ticket"}
          </DropdownMenuItem>
        )}
        {canHandBack && (
          <DropdownMenuItem onSelect={() => actions.handBack.mutate(ticket.id)}>
            <Bot className="size-4 text-subtle" aria-hidden="true" /> Hand back to the AI agent
          </DropdownMenuItem>
        )}
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
            {departments.filter((d) => d.id !== ticket.department_id).length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>
                  <span className="inline-flex items-center gap-1.5">
                    <ArrowRightLeft className="size-3.5" aria-hidden="true" /> Transfer to
                  </span>
                </DropdownMenuLabel>
                {departments
                  .filter((d) => d.id !== ticket.department_id)
                  .map((d) => (
                    <DropdownMenuItem key={d.id} onSelect={() => actions.transfer.mutate({ id: ticket.id, department_id: d.id })}>
                      {d.name}
                      <span className="ml-auto text-xs text-subtle">{d.open ? `${d.available_agents} free` : "closed"}</span>
                    </DropdownMenuItem>
                  ))}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
