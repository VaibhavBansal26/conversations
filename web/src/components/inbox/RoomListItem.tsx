import { Flag, Mail, MessageSquare, Smartphone, Star } from "lucide-react";
import { memo } from "react";
import { Link } from "react-router";
import type { Member, Room } from "../../api/types";
import { formatRelative } from "../../lib/time";
import { formatBadge } from "../../lib/unread";
import { Avatar, cn } from "../../ui";

interface Props {
  room: Room;
  selected: boolean;
  to: string;
  members: Map<string, Member>;
  now?: Date;
  /** briefly highlight a room that changed since the last resync */
  flash?: boolean;
  online?: boolean;
}

const CHANNEL_ICON = { dm: MessageSquare, sms: Smartphone, email: Mail } as const;
const CHANNEL_NAME = { dm: "Chat", sms: "SMS", email: "Email" } as const;

function preview(room: Room): string {
  const m = room.last_message;
  if (!m) return "No messages yet";
  const who = m.kind === "note" ? "Note" : m.sender_type === "agent" ? "You" : "";
  const text = m.snippet || (m.kind === "voice" ? "Voice note" : "Attachment");
  return who ? `${who}: ${text}` : text;
}

function RoomListItemImpl({ room, selected, to, members, now, flash, online }: Props) {
  const name = room.contact?.name || room.contact?.email || room.contact?.phone || "Unknown contact";
  const channel = room.last_message?.source ?? "dm";
  const ChannelIcon = CHANNEL_ICON[channel];
  const assignees = room.assignee_ids.map((id) => members.get(id)).filter((m): m is Member => !!m);
  const unread = room.unread_count > 0;
  return (
    <li className="h-[84px] overflow-hidden [contain:layout_paint]">
      <Link
        to={to}
        aria-current={selected ? "true" : undefined}
        data-unread={unread || undefined}
        className={cn(
          "relative flex h-full gap-3 border-b border-border px-3.5 py-3 transition-colors hover:bg-surface-2/70",
          selected && "bg-primary-soft hover:bg-primary-soft",
          flash && "animate-flash",
        )}
      >
        {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden="true" />}
        <Avatar name={name} seed={room.contact_id} online={online} />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold text-foreground" : "font-medium")}>{name}</span>
            {room.priority === 1 && (
              <span role="img" aria-label="Priority" className="text-danger-text">
                <Flag className="size-3.5" fill="currentColor" aria-hidden="true" />
              </span>
            )}
            {room.favorite && (
              <span role="img" aria-label="Favorite" className="text-warning-text">
                <Star className="size-3.5" fill="currentColor" aria-hidden="true" />
              </span>
            )}
            <time className={cn("shrink-0 text-xs tabular-nums", unread ? "font-semibold text-primary-text" : "text-subtle")} dateTime={room.last_message_at ?? undefined}>
              {formatRelative(room.last_message_at, now)}
            </time>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-[13px]", unread ? "text-foreground" : "text-muted-foreground")}>
              <span className="sr-only">{CHANNEL_NAME[channel]}. </span>
              <ChannelIcon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
              <span className="truncate">{preview(room)}</span>
            </span>
            {unread && (
              <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground" aria-label={`${room.unread_count} unread`}>
                {formatBadge(room.unread_count)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-subtle">
            {assignees.length > 0 ? (
              <span className="flex items-center gap-1" aria-label={`Assigned to ${assignees.map((a) => a.name).join(", ")}`}>
                <span className="flex -space-x-1.5">
                  {assignees.slice(0, 3).map((a) => (
                    <Avatar key={a.id} name={a.name} size="xs" className="ring-2 ring-surface rounded-full" />
                  ))}
                </span>
                <span className="truncate">{assignees.length === 1 ? assignees[0]?.name : `${assignees.length} people`}</span>
              </span>
            ) : (
              <span>Unassigned</span>
            )}
            {room.subject && <span className="min-w-0 flex-1 truncate before:mr-1.5 before:content-['·']">{room.subject}</span>}
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Re-rendering thousands of rows on every socket event is what makes big inboxes sluggish: rows only update when their own room changes. */
export const RoomListItem = memo(RoomListItemImpl);
