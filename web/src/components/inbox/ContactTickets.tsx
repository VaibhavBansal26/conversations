import { Link } from "react-router";
import { useRoomTickets } from "../../api/ticketHooks";
import { formatRelative } from "../../lib/time";
import { Skeleton } from "../../ui";
import { TicketChip } from "../tickets/TicketChip";

/** Ticket history of a conversation, newest first: number, status, subject and how it ended. */
export function ContactTickets({ roomId }: { roomId: string }) {
  const q = useRoomTickets(roomId);
  if (q.isPending) return <Skeleton className="h-10" />;
  if (!q.data?.length) return <p className="text-[13px] text-subtle">No tickets yet. One opens with the customer's next message.</p>;
  return (
    <ul className="-mx-1 space-y-0.5">
      {q.data.map((t) => (
        <li key={t.id}>
          <Link to={`/tickets?q=${t.number}`} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
            <span className="flex items-center gap-2">
              <TicketChip number={t.number} status={t.status} />
              <small className="ml-auto text-xs text-subtle">{formatRelative(t.last_activity_at)}</small>
            </span>
            <span className="truncate text-[13px] font-medium">{t.subject || "Conversation"}</span>
            {t.csat !== null && <small className="text-xs text-subtle">Rated {t.csat} out of 5</small>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
