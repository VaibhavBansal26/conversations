// Adapted from the legacy UI (see docs/PROVENANCE.md): assignee, status, priority and snooze controls in the conversation header.
import { ArrowLeft, Check, Phone, PhoneOutgoing, CircleDollarSign, Flag, Inbox as InboxIcon, MoreHorizontal, PanelRight, RotateCcw, Search, Share2, Sparkles, Star, UserRound, Video } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useInboxes, useMembers, useRoomActions } from "../../api/hooks";
import type { Room } from "../../api/types";
import { useCan, useSession } from "../../auth/AuthContext";
import { snoozePresets, toApiTimestamp } from "../../lib/snooze";
import { useCalls } from "../../calls/CallProvider";
import { PhoneCallDialog } from "../../calls/PhoneCall";
import { useSocket } from "../../realtime/SocketProvider";
import { isSnoozed } from "../../state/roomCache";
import {
  Avatar, Button, cn, DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip,
} from "../../ui";
import { ShareToTeamDialog } from "../../team/Dialogs";
import { RequestPaymentDialog } from "./RequestPaymentDialog";
import { SnoozeMenu } from "./SnoozeMenu";
import { SummaryPopover } from "./SummaryPopover";
import { TicketMenu } from "../tickets/TicketMenu";

interface Props {
  room: Room;
  backTo: string;
  assignOpen: boolean;
  onAssignOpen: (open: boolean) => void;
  snoozeOpen: boolean;
  onSnoozeOpen: (open: boolean) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  titleRef: React.RefObject<HTMLHeadingElement | null>;
}

const iconBtn = "grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground aria-pressed:bg-primary-soft aria-pressed:text-primary-text";

function IconToggle({ label, shortcut, pressed, onClick, children, className }: { label: string; shortcut?: string; pressed?: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick} className={cn(iconBtn, className)}>
        {children}
      </button>
    </Tooltip>
  );
}

export function RoomHeader({ room, backTo, assignOpen, onAssignOpen, snoozeOpen, onSnoozeOpen, panelOpen, onTogglePanel, searchOpen, onToggleSearch, titleRef }: Props) {
  const { member, workspace } = useSession();
  const members = useMembers().data ?? [];
  const inboxes = useInboxes().data ?? [];
  const { visitorOnline } = useSocket();
  const actions = useRoomActions(room.id);
  const canRequestPayment = useCan("payments:request");
  const canTeamChat = useCan("team_chat:use");
  const calls = useCalls();
  const [sharing, setSharing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [phoning, setPhoning] = useState(false);
  const [summary, setSummary] = useState(false);
  const name = room.contact?.name || room.contact?.email || room.contact?.phone || "Unknown contact";
  const closed = room.status === "closed";
  // the server says no (VISITOR_OFFLINE) when nobody is in the chat; the button only gives up early when the socket reported the visitor leaving
  const online = visitorOnline[room.id] !== false;
  const canCall = !!calls?.available && !closed && !!room.ticket && room.ticket.status !== "resolved" && room.ticket.status !== "closed";
  const inCall = !!calls && calls.view.phase !== "idle" && calls.view.phase !== "ended";
  const callTitle = (kind: "voice" | "video") => (inCall ? "You are already in a call" : !online ? "The visitor is not in the chat right now" : kind === "voice" ? "Voice call" : "Video call");
  const snoozed = isSnoozed(room, new Date());
  const assigned = members.filter((m) => room.assignee_ids.includes(m.id));
  const details = [room.contact?.email, room.contact?.phone].filter(Boolean).join(" · ") || room.subject || "No contact details";

  return (
    <header className="@container shrink-0 border-b border-border bg-surface">
      <div className="flex h-16 items-center gap-2 px-2 md:px-4">
        <Link to={backTo} className={cn(iconBtn, "md:hidden")} aria-label="Back to conversations">
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Link>
        <Avatar name={name} seed={room.contact_id} online={visitorOnline[room.id]} />
        <div className="min-w-0 flex-1">
          <h2 ref={titleRef} tabIndex={-1} className="truncate text-[15px] font-semibold leading-tight focus:outline-none">
            {name}
          </h2>
          <p className="truncate text-xs text-subtle">
            {details}
            {snoozed && <span className="ml-1.5 rounded bg-warning-soft px-1.5 py-px font-medium text-warning-text">Snoozed</span>}
            {closed && <span className="ml-1.5 rounded bg-surface-3 px-1.5 py-px font-medium text-muted-foreground">Closed</span>}
          </p>
        </div>

        {room.ticket && (
          <div className="shrink-0">
            <TicketMenu ticket={room.ticket} />
          </div>
        )}

        <DropdownMenuRoot open={assignOpen} onOpenChange={onAssignOpen}>
          <DropdownMenuTrigger
            aria-label="Assign conversation"
            className="flex h-9 items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] font-medium shadow-xs hover:bg-surface-2"
          >
            {assigned.length ? (
              <span className="flex -space-x-1.5">
                {assigned.slice(0, 2).map((a) => (
                  <Avatar key={a.id} name={a.name} size="xs" className="rounded-full ring-2 ring-surface" />
                ))}
              </span>
            ) : (
              <UserRound className="size-4 text-subtle" aria-hidden="true" />
            )}
            <span className="max-w-28 truncate @max-lg:hidden">{assigned.length ? assigned.map((m) => m.name.split(" ")[0]).join(", ") : "Unassigned"}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>Assign to</DropdownMenuLabel>
            <DropdownMenuCheckItem checked={room.assignee_ids.includes(member.id)} onSelect={() => actions.assign.mutate({ member_ids: [member.id] })}>
              Assign to me
            </DropdownMenuCheckItem>
            <DropdownMenuItem onSelect={() => actions.assign.mutate({ auto: true })}>Auto-assign (round robin)</DropdownMenuItem>
            <DropdownMenuSeparator />
            {members
              .filter((m) => m.id !== member.id && m.live_seat)
              .map((m) => (
                <DropdownMenuCheckItem key={m.id} checked={room.assignee_ids.includes(m.id)} onSelect={() => actions.assign.mutate({ member_ids: [m.id] })}>
                  {m.name}
                </DropdownMenuCheckItem>
              ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem danger disabled={!room.assignee_ids.length} onSelect={() => actions.assign.mutate({ member_ids: [] })}>
              Unassign
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>

        <div className="hidden items-center @2xl:flex">
          <IconToggle label="Mark as priority" shortcut="p" pressed={!!room.priority} onClick={() => actions.patch.mutate({ priority: room.priority ? 0 : 1 })}>
            <Flag className="size-[18px]" fill={room.priority ? "currentColor" : "none"} aria-hidden="true" />
          </IconToggle>
          <IconToggle label="Favorite" shortcut="f" pressed={room.favorite} onClick={() => actions.favorite.mutate(!room.favorite)}>
            <Star className="size-[18px]" fill={room.favorite ? "currentColor" : "none"} aria-hidden="true" />
          </IconToggle>
          <SnoozeMenu snoozed={snoozed} onSnooze={(until) => actions.snooze.mutate(until)} open={snoozeOpen} onOpenChange={onSnoozeOpen} />
          <SummaryPopover roomId={room.id} />
          <IconToggle label="Search in this conversation" pressed={searchOpen} onClick={onToggleSearch}>
            <Search className="size-[18px]" aria-hidden="true" />
          </IconToggle>
          {canCall && calls!.config?.browser.voice && (
            <IconToggle label={callTitle("voice")} onClick={() => !inCall && online && void calls!.start(room.id, "voice")} className={cn((inCall || !online) && "opacity-45")}>
              <Phone className="size-[18px]" aria-hidden="true" />
            </IconToggle>
          )}
          {canCall && calls!.config?.browser.video && (
            <IconToggle label={callTitle("video")} onClick={() => !inCall && online && void calls!.start(room.id, "video")} className={cn((inCall || !online) && "opacity-45")}>
              <Video className="size-[18px]" aria-hidden="true" />
            </IconToggle>
          )}
          {canCall && calls!.config?.phone?.ready && (
            <IconToggle label="Call by phone" onClick={() => setPhoning(true)}>
              <PhoneOutgoing className="size-[18px]" aria-hidden="true" />
            </IconToggle>
          )}
          {canRequestPayment && (
            <IconToggle label="Request payment" onClick={() => setPaying(true)}>
              <CircleDollarSign className="size-[18px]" aria-hidden="true" />
            </IconToggle>
          )}
        </div>

        <Button variant={closed ? "primary" : "outline"} size="sm" className="h-9" onClick={() => actions.patch.mutate({ status: closed ? "open" : "closed" })}>
          {closed ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span className="@max-md:sr-only">{closed ? "Reopen" : "Close"}</span>
        </Button>

        <DropdownMenuRoot>
          <DropdownMenuTrigger aria-label="More actions" className={cn(iconBtn, "data-[state=open]:bg-surface-2")}>
            <MoreHorizontal className="size-5" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <div className="@2xl:hidden">
              <DropdownMenuCheckItem checked={!!room.priority} onSelect={() => actions.patch.mutate({ priority: room.priority ? 0 : 1 })}>
                Mark as priority
              </DropdownMenuCheckItem>
              <DropdownMenuCheckItem checked={room.favorite} onSelect={() => actions.favorite.mutate(!room.favorite)}>
                Favorite
              </DropdownMenuCheckItem>
              <DropdownMenuItem onSelect={() => setSummary(true)}>
                <Sparkles className="size-4 text-subtle" aria-hidden="true" /> AI summary
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onToggleSearch}>
                <Search className="size-4 text-subtle" aria-hidden="true" /> Search in conversation
              </DropdownMenuItem>
              {canCall && calls!.config?.browser.voice && (
                <DropdownMenuItem disabled={inCall || !online} onSelect={() => void calls!.start(room.id, "voice")}>
                  <Phone className="size-4 text-subtle" aria-hidden="true" /> Voice call
                </DropdownMenuItem>
              )}
              {canCall && calls!.config?.browser.video && (
                <DropdownMenuItem disabled={inCall || !online} onSelect={() => void calls!.start(room.id, "video")}>
                  <Video className="size-4 text-subtle" aria-hidden="true" /> Video call
                </DropdownMenuItem>
              )}
              {canCall && calls!.config?.phone?.ready && (
                <DropdownMenuItem onSelect={() => setPhoning(true)}>
                  <PhoneOutgoing className="size-4 text-subtle" aria-hidden="true" /> Call by phone
                </DropdownMenuItem>
              )}
              {canRequestPayment && (
                <DropdownMenuItem onSelect={() => setPaying(true)}>
                  <CircleDollarSign className="size-4 text-subtle" aria-hidden="true" /> Request payment
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
              {snoozePresets(new Date()).slice(0, 4).map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => actions.snooze.mutate(toApiTimestamp(p.until))}>
                  {p.label}
                </DropdownMenuItem>
              ))}
              {snoozed && (
                <DropdownMenuItem danger onSelect={() => actions.snooze.mutate(null)}>
                  Remove snooze
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </div>
            {canTeamChat && (
              <>
                <DropdownMenuItem onSelect={() => setSharing(true)}>
                  <Share2 className="size-4 text-subtle" aria-hidden="true" /> Share with the team
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuLabel>Move to inbox</DropdownMenuLabel>
            <DropdownMenuCheckItem checked={!room.inbox_id} onSelect={() => actions.assign.mutate({ inbox_id: null })}>
              <InboxIcon className="size-4 text-subtle" aria-hidden="true" /> No inbox
            </DropdownMenuCheckItem>
            {inboxes.map((i) => (
              <DropdownMenuCheckItem key={i.id} checked={room.inbox_id === i.id} onSelect={() => actions.assign.mutate({ inbox_id: i.id })}>
                {i.name}
              </DropdownMenuCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenuRoot>

        <IconToggle label="Contact details" shortcut="i" pressed={panelOpen} onClick={onTogglePanel}>
          <PanelRight className="size-5" aria-hidden="true" />
        </IconToggle>
      </div>
      {phoning && <PhoneCallDialog room={room} onClose={() => setPhoning(false)} />}
      {paying && <RequestPaymentDialog roomId={room.id} currency={workspace.currency} onClose={() => setPaying(false)} />}
      {sharing && <ShareToTeamDialog roomId={room.id} onClose={() => setSharing(false)} />}
      <div className="@2xl:hidden">
        <SummaryPopover roomId={room.id} sheet open={summary} onOpenChange={setSummary} />
      </div>
    </header>
  );
}
