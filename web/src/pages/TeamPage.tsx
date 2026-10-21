import { MessagesSquare } from "lucide-react";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { useTeamChannels, useTeamChannel } from "../team/hooks";
import { ChannelView } from "../team/ChannelView";
import { TeamSidebar } from "../team/TeamSidebar";
import { teamShortcutFor } from "../team/shortcuts";
import { EmptyState, ErrorNotice, Skeleton, cn } from "../ui";

/** Team chat shell: sidebar + channel (desktop), one screen at a time on phones (the URL decides which). */
export function TeamPage() {
  const { channelId } = useParams();
  const nav = useNavigate();
  const channels = useTeamChannels();
  const joined = channels.data?.find((c) => c.id === channelId);
  // a public channel you have not joined is previewed from its own record
  const preview = useTeamChannel(channelId && channels.data && !joined ? channelId : undefined);
  const channel = joined ?? preview.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = teamShortcutFor(e);
      if (!act || !channels.data) return;
      const order = [...channels.data].filter((c) => !c.archived);
      const i = order.findIndex((c) => c.id === channelId);
      if (act === "prev" || act === "next") {
        e.preventDefault();
        const step = act === "next" ? 1 : -1;
        const from = i === -1 ? (step === 1 ? -1 : 0) : i;
        const target = order[(from + step + order.length) % order.length];
        if (target) nav(`/team/${target.id}`);
      } else if (act === "next_unread") {
        e.preventDefault();
        const target = order.find((c) => c.id !== channelId && (c.unread > 0 || c.mention_unread > 0) && (!c.muted || c.mention_unread > 0));
        if (target) nav(`/team/${target.id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [channels.data, channelId, nav]);

  return (
    <div className="flex h-full min-h-0" data-testid="team-page">
      <TeamSidebar className={cn("w-full shrink-0 border-r border-border lg:w-72", channelId && "hidden lg:flex")} />
      <main className={cn("min-h-0 min-w-0 flex-1", !channelId && "hidden lg:block")} aria-label="Conversation">
        {!channelId && <EmptyState icon={MessagesSquare} title="Talk to your team" hint="Pick a channel or a person on the left. Customer conversations stay in the Inbox; this is where your team talks to each other." className="h-full" />}
        {channelId && !channel && (preview.isError ? <div className="p-6"><ErrorNotice error={preview.error} /></div> : channels.isError ? <div className="p-6"><ErrorNotice error={channels.error} /></div> : <div className="p-6"><Skeleton className="h-24" /></div>)}
        {channel && <ChannelView key={channel.id} channel={channel} />}
      </main>
    </div>
  );
}
