import { QueryClient } from "@tanstack/react-query";
import { applyMessageToChannels, bumpReply, emptyTeamThread, prependTeam, removeTeam, sortChannels, teamKeys, threadFromPage, totalUnread, upsertTeam } from "./cache";
import { onTeamChannel, onTeamMessageDeleted, onTeamMessageNew, onTeamReaction, onTeamRead } from "./events";
import { buildTeamItems, sameTeamGroup } from "./grouping";
import { teamShortcutFor } from "./shortcuts";
import type { TeamChannel, TeamMessage, TeamThreadCache } from "./types";

let n = 0;
export const msg = (over: Partial<TeamMessage> = {}): TeamMessage => {
  n += 1;
  return {
    id: `tmsg_${n}`, channel_id: "tch_1", seq: n, thread_root_id: null, client_msg_id: null, sender: { id: "mem_a", name: "Ann" }, kind: "text", content: `hello ${n}`, content_text: `hello ${n}`,
    attachments: [], mentions: [], mention_all: false, reactions: [], reply_count: 0, last_reply_at: null, pinned: false, pinned_at: null, edited_at: null, deleted: false,
    created_at: new Date(Date.UTC(2026, 0, 5, 10, 0, n)).toISOString(), share: null, ...over,
  };
};
const chan = (over: Partial<TeamChannel> = {}): TeamChannel => ({
  id: "tch_1", kind: "channel", visibility: "public", name: "ops", title: "ops", topic: "", is_general: false, archived: false, member_count: 3, joined: true, role: "member", muted: false, unread: 0,
  mention_unread: 0, last_message: null, last_message_at: null, created_at: "2026-01-01T00:00:00Z", ...over,
});

describe("team message cache", () => {
  it("keeps messages in seq order and merges the optimistic bubble into the confirmed message by client_msg_id", () => {
    const local = msg({ id: "local-x", seq: 0, client_msg_id: "cid-1", local: { status: "sending" } });
    let t = upsertTeam(emptyTeamThread, msg({ seq: 5 }));
    t = upsertTeam(t, local);
    expect(t.messages.at(-1)!.id).toBe("local-x"); // unconfirmed messages sort after everything stored
    t = upsertTeam(t, msg({ id: "tmsg_real", seq: 6, client_msg_id: "cid-1" }));
    expect(t.messages.map((m) => m.id)).toEqual([t.messages[0]!.id, "tmsg_real"]);
    expect(t.messages.at(-1)!.local).toBeUndefined();
  });
  it("prepends an older page without duplicates and removes deleted messages", () => {
    const a = msg({ seq: 10 });
    const older = [msg({ seq: 8 }), a];
    const t = prependTeam({ messages: [a], hasMoreBefore: true, beforeCursor: a.id }, { data: older, pagination: { has_more_before: false, has_more_after: false, before_cursor: older[0]!.id, after_cursor: a.id } });
    expect(t.messages.map((m) => m.seq)).toEqual([8, 10]);
    expect(t.hasMoreBefore).toBe(false);
    expect(removeTeam(t, a.id).messages).toHaveLength(1);
    expect(threadFromPage({ data: [a], pagination: { has_more_before: true, has_more_after: false, before_cursor: "x", after_cursor: "y" } }).hasMoreBefore).toBe(true);
  });
  it("counts a reply once even though the sender hears of it twice", () => {
    const qc = new QueryClient();
    const root = msg({ id: "root", seq: 1 });
    qc.setQueryData<TeamThreadCache>(teamKeys.messages("tch_1"), { messages: [root], hasMoreBefore: false, beforeCursor: null });
    const reply = msg({ id: "reply-1", thread_root_id: "root", seq: 2 });
    bumpReply(qc, reply);
    bumpReply(qc, reply);
    bumpReply(qc, { ...reply, id: "reply-2" });
    expect(qc.getQueryData<TeamThreadCache>(teamKeys.messages("tch_1"))!.messages[0]!.reply_count).toBe(2);
    bumpReply(qc, { ...reply, id: "reply-3", local: { status: "sending" } }); // unconfirmed replies do not count
    expect(qc.getQueryData<TeamThreadCache>(teamKeys.messages("tch_1"))!.messages[0]!.reply_count).toBe(2);
  });
});

describe("channel list updates", () => {
  it("bumps unread for others' messages when the channel is not open, mentions separately, and sorts by activity", () => {
    const list = [chan({ id: "a", last_message_at: "2026-01-02T00:00:00Z" }), chan({ id: "b", last_message_at: "2026-01-01T00:00:00Z" })];
    const next = applyMessageToChannels(list, msg({ channel_id: "b", mentions: ["me"], created_at: "2026-01-03T00:00:00Z" }), { self: "me", open: false });
    expect(next.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next[0]).toMatchObject({ unread: 1, mention_unread: 1, last_message: { sender_name: "Ann" } });
    const own = applyMessageToChannels(next, msg({ channel_id: "b", sender: { id: "me", name: "Me" } }), { self: "me", open: false });
    expect(own.find((c) => c.id === "b")!.unread).toBe(1);
    const open = applyMessageToChannels(next, msg({ channel_id: "b" }), { self: "me", open: true });
    expect(open.find((c) => c.id === "b")!.unread).toBe(1);
  });
  it("totals for the navigation badge: mentions win, muted channels stay quiet unless mentioned", () => {
    expect(totalUnread([chan({ unread: 3 }), chan({ id: "m", unread: 5, muted: true })])).toEqual({ unread: 3, mentions: 0 });
    expect(totalUnread([chan({ unread: 3, mention_unread: 1 }), chan({ id: "m", unread: 5, muted: true, mention_unread: 2 })])).toEqual({ unread: 3, mentions: 3 });
    expect(totalUnread(undefined)).toEqual({ unread: 0, mentions: 0 });
    expect(sortChannels([chan({ id: "x", created_at: "2026-01-01T00:00:00Z" }), chan({ id: "y", last_message_at: "2026-02-01T00:00:00Z" })]).map((c) => c.id)).toEqual(["y", "x"]);
  });
});

describe("socket events -> caches", () => {
  const ctx = { selfMemberId: "me", activeChannelId: () => null as string | null };
  it("a new message lands in the timeline and the channel row; a message for an unknown channel triggers a refetch", () => {
    const qc = new QueryClient();
    qc.setQueryData(teamKeys.channels, [chan()]);
    onTeamMessageNew(qc, { channel_id: "tch_1", message: msg() }, ctx);
    expect(qc.getQueryData<TeamThreadCache>(teamKeys.messages("tch_1"))!.messages).toHaveLength(1);
    expect(qc.getQueryData<TeamChannel[]>(teamKeys.channels)![0]).toMatchObject({ unread: 1 });
    const spy = vi.spyOn(qc, "invalidateQueries");
    onTeamMessageNew(qc, { channel_id: "tch_unknown", message: msg({ channel_id: "tch_unknown" }) }, ctx);
    expect(spy).toHaveBeenCalledWith({ queryKey: teamKeys.channels });
  });
  it("reactions, deletes, removal and read cursors update the right caches", () => {
    const qc = new QueryClient();
    const m = msg();
    qc.setQueryData(teamKeys.channels, [chan({ unread: 4, mention_unread: 1 })]);
    qc.setQueryData<TeamThreadCache>(teamKeys.messages("tch_1"), { messages: [m], hasMoreBefore: false, beforeCursor: null });
    onTeamReaction(qc, { channel_id: "tch_1", message_id: m.id, reactions: [{ emoji: "👍", count: 1, member_ids: ["me"] }] });
    expect(qc.getQueryData<TeamThreadCache>(teamKeys.messages("tch_1"))!.messages[0]!.reactions).toHaveLength(1);
    onTeamRead(qc, { channel_id: "tch_1", member_id: "me", seq: 9 }, "me");
    expect(qc.getQueryData<TeamChannel[]>(teamKeys.channels)![0]).toMatchObject({ unread: 0, mention_unread: 0 });
    onTeamMessageDeleted(qc, { channel_id: "tch_1", message_id: m.id });
    expect(qc.getQueryData<TeamThreadCache>(teamKeys.messages("tch_1"))!.messages).toEqual([]);
    onTeamChannel(qc, "updated", { channel_id: "tch_1", muted: true });
    expect(qc.getQueryData<TeamChannel[]>(teamKeys.channels)![0]!.muted).toBe(true);
    onTeamChannel(qc, "removed", { channel_id: "tch_1" });
    expect(qc.getQueryData<TeamChannel[]>(teamKeys.channels)).toEqual([]);
    onTeamChannel(qc, "created", { channel: chan({ id: "new", joined: true, last_message_at: "2026-05-01T00:00:00Z" }) });
    expect(qc.getQueryData<TeamChannel[]>(teamKeys.channels)!.map((c) => c.id)).toEqual(["new"]);
  });
});

describe("grouping and shortcuts", () => {
  it("groups one sender's messages within five minutes and inserts day separators", () => {
    const a = msg({ created_at: "2026-01-05T10:00:00Z" });
    const b = msg({ created_at: "2026-01-05T10:04:00Z" });
    const c = msg({ created_at: "2026-01-05T10:20:00Z" });
    const d = msg({ created_at: "2026-01-06T10:00:00Z", sender: { id: "mem_b", name: "Bo" } });
    expect(sameTeamGroup(a, b)).toBe(true);
    expect(sameTeamGroup(b, c)).toBe(false);
    const items = buildTeamItems([a, b, c, d], new Date("2026-01-06T12:00:00Z"));
    expect(items.map((i) => i.type)).toEqual(["day", "message", "message", "message", "day", "message"]);
    expect(items.filter((i) => i.type === "message").map((i) => (i.type === "message" ? [i.first, i.last] : null))).toEqual([[true, false], [false, true], [true, true], [true, true]]);
  });
  it("Alt+Arrow navigates, plain arrows and other modifiers do not", () => {
    const k = (key: string, o: object = {}) => teamShortcutFor({ key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...o });
    expect(k("ArrowUp", { altKey: true })).toBe("prev");
    expect(k("ArrowDown", { altKey: true })).toBe("next");
    expect(k("ArrowDown", { altKey: true, shiftKey: true })).toBe("next_unread");
    expect(k("ArrowUp")).toBeNull();
    expect(k("ArrowUp", { altKey: true, ctrlKey: true })).toBeNull();
    expect(k("j", { altKey: true })).toBeNull();
  });
});
