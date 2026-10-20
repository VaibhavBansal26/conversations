import { Link } from "react-router";
import { useInboxes, useMembers, useRoomActions } from "../../api/hooks";
import type { Room } from "../../api/types";
import { useCan, useSession } from "../../auth/AuthContext";
import { useSocket } from "../../realtime/SocketProvider";
import { isSnoozed } from "../../state/roomCache";
import { Avatar } from "../../ui";
import { Icon } from "../../ui";
import { Menu, type MenuItem } from "../../ui";
import { useState } from "react";
import { RequestPaymentDialog } from "./RequestPaymentDialog";
import { SnoozeMenu } from "./SnoozeMenu";
import { SummaryPopover } from "./SummaryPopover";

interface Props {
  room: Room;
  backTo: string;
  assignOpen: boolean;
  onAssignOpen: (open: boolean) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  titleRef: React.RefObject<HTMLHeadingElement | null>;
}

export function RoomHeader({ room, backTo, assignOpen, onAssignOpen, panelOpen, onTogglePanel, titleRef }: Props) {
  const { member, workspace } = useSession();
  const members = useMembers().data ?? [];
  const inboxes = useInboxes().data ?? [];
  const { visitorOnline } = useSocket();
  const actions = useRoomActions(room.id);
  const canRequestPayment = useCan("payments:request");
  const [paying, setPaying] = useState(false);
  const name = room.contact?.name || room.contact?.email || room.contact?.phone || "Unknown contact";
  const closed = room.status === "closed";
  const assigned = members.filter((m) => room.assignee_ids.includes(m.id));

  const assignItems: MenuItem[] = [
    { id: "me", label: "Assign to me", checked: room.assignee_ids.includes(member.id), onSelect: () => actions.assign.mutate({ member_ids: [member.id] }) },
    { id: "auto", label: "Auto-assign (round robin)", onSelect: () => actions.assign.mutate({ auto: true }) },
    ...members
      .filter((m) => m.id !== member.id && m.live_seat)
      .map<MenuItem>((m) => ({ id: m.id, label: m.name, checked: room.assignee_ids.includes(m.id), onSelect: () => actions.assign.mutate({ member_ids: [m.id] }) })),
    { id: "none", label: "Unassign", disabled: !room.assignee_ids.length, danger: true, onSelect: () => actions.assign.mutate({ member_ids: [] }) },
  ];

  return (
    <header className="room-header">
      <Link to={backTo} className="icon-btn back-btn" aria-label="Back to conversations">
        <Icon name="left" />
      </Link>
      <Avatar name={name} seed={room.contact_id} online={visitorOnline[room.id]} />
      <div className="room-title">
        <h2 ref={titleRef} tabIndex={-1}>
          {name}
        </h2>
        <p>
          {[room.contact?.email, room.contact?.phone].filter(Boolean).join(" · ") || room.subject || "No contact details"}
          {isSnoozed(room, new Date()) && " · Snoozed"}
        </p>
      </div>
      <div className="room-actions">
        <label className="sr-only" htmlFor="room-inbox">
          Inbox
        </label>
        <select id="room-inbox" className="select-sm" value={room.inbox_id ?? ""} onChange={(e) => actions.assign.mutate({ inbox_id: e.target.value || null })}>
          <option value="">No inbox</option>
          {inboxes.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <Menu
          label="Assign conversation"
          open={assignOpen}
          onOpenChange={onAssignOpen}
          align="end"
          triggerClassName="btn btn-ghost btn-sm"
          trigger={
            <>
              <Icon name="user" size={16} /> <span>{assigned.length ? assigned.map((m) => m.name.split(" ")[0]).join(", ") : "Unassigned"}</span>
            </>
          }
          items={assignItems}
        />
        <button type="button" className={`icon-btn${room.priority ? " on" : ""}`} aria-pressed={!!room.priority} aria-label="Mark as priority" onClick={() => actions.patch.mutate({ priority: room.priority ? 0 : 1 })}>
          <Icon name="flag" filled={!!room.priority} />
        </button>
        <button type="button" className={`icon-btn${room.favorite ? " on" : ""}`} aria-pressed={room.favorite} aria-label="Favorite" onClick={() => actions.favorite.mutate(!room.favorite)}>
          <Icon name="star" filled={room.favorite} />
        </button>
        <SnoozeMenu snoozed={isSnoozed(room, new Date())} onSnooze={(until) => actions.snooze.mutate(until)} />
        <SummaryPopover roomId={room.id} />
        {canRequestPayment && (
          <button type="button" className="icon-btn" aria-label="Request payment" title="Request payment" onClick={() => setPaying(true)}>
            <Icon name="card" />
          </button>
        )}
        <button type="button" className={`btn btn-sm ${closed ? "btn-primary" : "btn-outline"}`} onClick={() => actions.patch.mutate({ status: closed ? "open" : "closed" })}>
          <Icon name={closed ? "refresh" : "check"} size={15} /> {closed ? "Reopen" : "Close"}
        </button>
        <button type="button" className={`icon-btn panel-toggle${panelOpen ? " on" : ""}`} aria-pressed={panelOpen} aria-label="Contact details" onClick={onTogglePanel}>
          <Icon name="panel" />
        </button>
      </div>
      {paying && <RequestPaymentDialog roomId={room.id} currency={workspace.currency} onClose={() => setPaying(false)} />}
    </header>
  );
}
