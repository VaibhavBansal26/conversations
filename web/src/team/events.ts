import type { QueryClient } from "@tanstack/react-query";
import { applyMessageToChannels, bumpReply, sortChannels, teamKeys } from "./cache";
import { dropMessage, patchMessage, putMessage } from "./hooks";
import type { TeamChannel, TeamMessage, TeamReaction } from "./types";

export interface TeamBridgeContext {
  selfMemberId: string;
  /** channel open and visible right now: its messages are read on arrival */
  activeChannelId: () => string | null;
}

const listOf = (qc: QueryClient) => qc.getQueryData<TeamChannel[]>(teamKeys.channels);

/** Socket events -> react-query caches. Delivery is at-most-once; anything unknown is repaired by refetching over REST. */
export function onTeamMessageNew(qc: QueryClient, p: { channel_id: string; message: TeamMessage }, ctx: TeamBridgeContext): void {
  const m = p.message;
  putMessage(qc, m);
  if (m.thread_root_id) bumpReply(qc, m);
  const list = listOf(qc);
  if (!list || !list.some((c) => c.id === m.channel_id)) {
    void qc.invalidateQueries({ queryKey: teamKeys.channels });
    return;
  }
  // thread replies do not light up the channel; they only move the root's counter (done by putMessage)
  if (m.thread_root_id) return;
  qc.setQueryData<TeamChannel[]>(teamKeys.channels, applyMessageToChannels(list, m, { self: ctx.selfMemberId, open: ctx.activeChannelId() === m.channel_id }));
}

export function onTeamMessageUpdated(qc: QueryClient, p: { channel_id: string; message: TeamMessage }): void {
  putMessage(qc, p.message);
  if (p.message.pinned !== undefined) void qc.invalidateQueries({ queryKey: teamKeys.pins(p.channel_id) });
}

export function onTeamMessageDeleted(qc: QueryClient, p: { channel_id: string; message_id: string }): void {
  dropMessage(qc, p.channel_id, p.message_id);
  void qc.invalidateQueries({ queryKey: teamKeys.pins(p.channel_id) });
}

export function onTeamReaction(qc: QueryClient, p: { channel_id: string; message_id: string; reactions: TeamReaction[] }): void {
  patchMessage(qc, p.channel_id, p.message_id, (m) => ({ ...m, reactions: p.reactions }));
}

export function onTeamChannel(qc: QueryClient, event: "created" | "updated" | "removed" | "members", p: { channel?: TeamChannel; channel_id?: string; muted?: boolean }): void {
  const list = listOf(qc);
  if (event === "removed" && p.channel_id) {
    qc.setQueryData<TeamChannel[]>(teamKeys.channels, (cur) => cur?.filter((c) => c.id !== p.channel_id));
    qc.removeQueries({ queryKey: teamKeys.messages(p.channel_id) });
    void qc.invalidateQueries({ queryKey: teamKeys.browse });
    return;
  }
  if (event === "members") {
    if (p.channel_id) void qc.invalidateQueries({ queryKey: teamKeys.channel(p.channel_id) });
    return;
  }
  if (event === "updated" && p.channel_id && p.muted !== undefined) {
    qc.setQueryData<TeamChannel[]>(teamKeys.channels, (cur) => cur?.map((c) => (c.id === p.channel_id ? { ...c, muted: p.muted! } : c)));
    return;
  }
  const ch = p.channel;
  if (!ch) return;
  if (!ch.joined) {
    void qc.invalidateQueries({ queryKey: teamKeys.browse });
    return;
  }
  qc.setQueryData<TeamChannel[]>(teamKeys.channels, sortChannels([...(list ?? []).filter((c) => c.id !== ch.id), { ...(list?.find((c) => c.id === ch.id) ?? ch), ...ch }]));
  void qc.invalidateQueries({ queryKey: teamKeys.channel(ch.id) });
}

/** The read cursor of this member moved (maybe in another tab): the channel has no unread any more up to there. */
export function onTeamRead(qc: QueryClient, p: { channel_id: string; member_id: string; seq: number }, selfMemberId: string): void {
  if (p.member_id !== selfMemberId) {
    void qc.invalidateQueries({ queryKey: teamKeys.channel(p.channel_id) });
    return;
  }
  qc.setQueryData<TeamChannel[]>(teamKeys.channels, (cur) => cur?.map((c) => (c.id === p.channel_id ? { ...c, unread: 0, mention_unread: 0 } : c)));
}
