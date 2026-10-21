import { Compass, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Link, useMatch } from "react-router";
import { useCan, useSession } from "../auth/AuthContext";
import { formatBadge } from "../lib/unread";
import { useSocket } from "../realtime/SocketProvider";
import { formatRelative } from "../lib/time";
import { Avatar, Button, cn, ErrorNotice, Menu, Skeleton, Tooltip } from "../ui";
import { ChannelIcon } from "./ChannelView";
import { BrowseChannelsDialog, CreateChannelDialog, NewMessageDialog, TeamSearchDialog } from "./Dialogs";
import { useTeamChannels } from "./hooks";
import type { TeamChannel } from "./types";

function Count({ channel }: { channel: TeamChannel }) {
  if (channel.mention_unread > 0) return <span className="grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold leading-5 text-primary-foreground" aria-hidden="true">{formatBadge(channel.mention_unread)}</span>;
  if (channel.unread > 0 && !channel.muted) return <span className="grid min-w-5 place-items-center rounded-full bg-surface-3 px-1.5 text-[11px] font-bold leading-5 text-foreground" aria-hidden="true">{formatBadge(channel.unread)}</span>;
  return null;
}

function Row({ channel, selfId }: { channel: TeamChannel; selfId: string }) {
  const active = !!useMatch(`/team/${channel.id}/*`);
  const { onlineMembers } = useSocket();
  const other = channel.kind === "dm" ? (channel.member_ids ?? []).find((id) => id !== selfId) ?? selfId : null;
  const unread = (channel.unread > 0 && !channel.muted) || channel.mention_unread > 0;
  const label = [channel.kind === "channel" ? `${channel.visibility === "private" ? "Private channel " : "Channel "}${channel.title}` : channel.title, channel.mention_unread ? `${channel.mention_unread} mention${channel.mention_unread === 1 ? "" : "s"}` : channel.unread && !channel.muted ? `${channel.unread} unread` : "", channel.muted ? "muted" : ""].filter(Boolean).join(", ");
  return (
    <li>
      <Link
        to={`/team/${channel.id}`}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-surface-2", active && "bg-primary-soft text-primary-text hover:bg-primary-soft", channel.muted && !active && "text-subtle")}
      >
        {other ? <Avatar name={channel.title} seed={other} size="xs" online={onlineMembers.has(other)} /> : <ChannelIcon channel={channel} className="size-4 shrink-0 opacity-70" />}
        <span className={cn("min-w-0 flex-1 truncate", unread && "font-semibold text-foreground")}>{channel.title}</span>
        <Count channel={channel} />
      </Link>
    </li>
  );
}

/** Left column of team chat: channels, direct messages, unread counts and presence. */
export function TeamSidebar({ className }: { className?: string }) {
  const { member } = useSession();
  const channels = useTeamChannels();
  const manage = useCan("team_chat:manage_channels");
  const [dialog, setDialog] = useState<"new" | "create" | "browse" | "search" | null>(null);
  const list = channels.data ?? [];
  const chans = list.filter((c) => c.kind === "channel").sort((a, b) => Number(b.is_general) - Number(a.is_general) || (a.name ?? "").localeCompare(b.name ?? ""));
  const dms = list.filter((c) => c.kind !== "channel");
  return (
    <nav aria-label="Team chat" className={cn("flex min-h-0 flex-col bg-surface", className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-3">
        <h1 className="flex-1 text-base font-semibold">Team</h1>
        <Tooltip content="Search team chat">
          <Button variant="ghost" size="icon-sm" aria-label="Search team chat" onClick={() => setDialog("search")}>
            <Search />
          </Button>
        </Tooltip>
        <Menu
          label="Start something"
          triggerClassName="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary-hover"
          trigger={<Plus className="size-4" aria-hidden="true" />}
          align="end"
          items={[
            { id: "dm", label: "New message", onSelect: () => setDialog("new") },
            ...(manage ? [{ id: "create", label: "Create a channel", onSelect: () => setDialog("create") }] : []),
            { id: "browse", label: "Browse channels", onSelect: () => setDialog("browse") },
          ]}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {channels.isPending && <Skeleton className="m-1 h-32" />}
        {channels.isError && <ErrorNotice error={channels.error} onRetry={() => void channels.refetch()} />}
        {channels.data && (
          <>
            <section aria-labelledby="team-channels">
              <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
                <h2 id="team-channels" className="text-xs font-semibold uppercase tracking-wide text-subtle">
                  Channels
                </h2>
                <Tooltip content="Browse channels">
                  <button type="button" aria-label="Browse channels" onClick={() => setDialog("browse")} className="grid size-6 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-foreground">
                    <Compass className="size-3.5" aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
              <ul className="flex flex-col gap-0.5">{chans.map((c) => <Row key={c.id} channel={c} selfId={member.id} />)}</ul>
              {!chans.length && <p className="px-2.5 py-2 text-[13px] text-subtle">No channels yet.</p>}
            </section>
            <section aria-labelledby="team-dms" className="mt-4">
              <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
                <h2 id="team-dms" className="text-xs font-semibold uppercase tracking-wide text-subtle">
                  Direct messages
                </h2>
                <Tooltip content="New message">
                  <button type="button" aria-label="New message" onClick={() => setDialog("new")} className="grid size-6 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-foreground">
                    <Plus className="size-3.5" aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
              <ul className="flex flex-col gap-0.5">{dms.map((c) => <Row key={c.id} channel={c} selfId={member.id} />)}</ul>
              {!dms.length && (
                <p className="px-2.5 py-2 text-[13px] text-subtle">
                  Nobody yet.{" "}
                  <button type="button" className="font-medium text-primary-text underline underline-offset-2" onClick={() => setDialog("new")}>
                    Send a message
                  </button>
                </p>
              )}
            </section>
          </>
        )}
      </div>
      {dialog === "new" && <NewMessageDialog onClose={() => setDialog(null)} />}
      {dialog === "create" && <CreateChannelDialog onClose={() => setDialog(null)} />}
      {dialog === "browse" && <BrowseChannelsDialog onClose={() => setDialog(null)} />}
      {dialog === "search" && <TeamSearchDialog onClose={() => setDialog(null)} />}
    </nav>
  );
}

export const lastActivity = (c: TeamChannel) => formatRelative(c.last_message_at);
