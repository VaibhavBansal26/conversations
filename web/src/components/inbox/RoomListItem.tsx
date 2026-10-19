import { memo } from "react";
import { Link } from "react-router";
import type { Member, Room } from "../../api/types";
import { formatBadge } from "../../lib/unread";
import { formatRelative } from "../../lib/time";
import { Avatar } from "../ui/Avatar";
import { Icon } from "../ui/Icon";

interface Props {
  room: Room;
  selected: boolean;
  to: string;
  members: Map<string, Member>;
  now?: Date;
  /** briefly highlight a room that changed since the last resync */
  flash?: boolean;
}

const CHANNEL_ICON = { dm: "chat", sms: "sms", email: "mail" } as const;
const CHANNEL_NAME = { dm: "Chat", sms: "SMS", email: "Email" } as const;

function preview(room: Room): string {
  const m = room.last_message;
  if (!m) return "No messages yet";
  const who = m.kind === "note" ? "Note" : m.sender_type === "agent" ? "You" : "";
  const text = m.snippet || (m.kind === "voice" ? "Voice note" : "Attachment");
  return who ? `${who}: ${text}` : text;
}

function RoomListItemImpl({ room, selected, to, members, now, flash }: Props) {
  const name = room.contact?.name || room.contact?.email || room.contact?.phone || "Unknown contact";
  const channel = room.last_message?.source ?? "dm";
  const assignees = room.assignee_ids.map((id) => members.get(id)).filter((m): m is Member => !!m);
  const unread = room.unread_count > 0;
  return (
    <li>
      <Link to={to} className={`room-item${selected ? " selected" : ""}${unread ? " unread" : ""}${flash ? " flash" : ""}`} aria-current={selected ? "true" : undefined}>
        <Avatar name={name} seed={room.contact_id} />
        <div className="room-main">
          <div className="room-line">
            <span className="room-name">{name}</span>
            {room.priority === 1 && (
              <span className="flag" role="img" aria-label="Priority">
                <Icon name="flag" size={13} filled />
              </span>
            )}
            {room.favorite && (
              <span className="fav" role="img" aria-label="Favorite">
                <Icon name="star" size={13} filled />
              </span>
            )}
            <time className="room-time" dateTime={room.last_message_at ?? undefined}>
              {formatRelative(room.last_message_at, now)}
            </time>
          </div>
          <div className="room-line">
            <span className="room-snippet">
              <span className="sr-only">{CHANNEL_NAME[channel]}. </span>
              <Icon name={CHANNEL_ICON[channel]} size={13} className="chan" />
              {preview(room)}
            </span>
            {unread && (
              <span className="badge" aria-label={`${room.unread_count} unread`}>
                {formatBadge(room.unread_count)}
              </span>
            )}
          </div>
          {assignees.length > 0 && (
            <div className="room-assignees" aria-label={`Assigned to ${assignees.map((a) => a.name).join(", ")}`}>
              {assignees.slice(0, 3).map((a) => (
                <Avatar key={a.id} name={a.name} size="sm" />
              ))}
              {assignees.length > 3 && <span className="more">+{assignees.length - 3}</span>}
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

/** Re-rendering thousands of rows on every socket event is what makes big inboxes sluggish: rows only update when their own room changes. */
export const RoomListItem = memo(RoomListItemImpl);
