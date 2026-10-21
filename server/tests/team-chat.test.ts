import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createRole, setMemberRole } from "../src/services/roles.js";
import { removeMember, updateMember, actorFromRow, getMember } from "../src/services/members.js";
import { listNotifications } from "../src/services/notifications.js";
import {
  accessChannel,
  addChannelMembers,
  browseChannels,
  createChannel,
  deleteTeamMessage,
  editTeamMessage,
  getThread,
  joinChannel,
  leaveChannel,
  listChannels,
  listPins,
  listTeamMessages,
  markTeamRead,
  openDm,
  removeChannelMember,
  searchTeam,
  sendTeamMessage,
  setMuted,
  setPinned,
  teamRetentionSweep,
  toggleReaction,
  updateChannel,
} from "../src/services/teamChat.js";
import { runDueJobs } from "../src/jobs/queue.js";
import { jobHandlers } from "../src/jobs/scheduler.js";
import { addMemberRaw, client, fullApp, mkRoom, seedWorkspace, setSettings, tokenFor } from "./helpers.js";

async function world() {
  const f = await fullApp();
  const { ctx, wsId, owner } = f;
  const manager = await addMemberRaw(ctx, wsId, { name: "Mia Manager", role: "manager", email: "mia@acme.test" });
  const ann = await addMemberRaw(ctx, wsId, { name: "Ann Agent", role: "agent", email: "ann@acme.test" });
  const bo = await addMemberRaw(ctx, wsId, { name: "Bo Agent", role: "agent", email: "bo@acme.test" });
  const viewer = await addMemberRaw(ctx, wsId, { name: "Vic Viewer", role: "agent", email: "vic@acme.test" });
  await setMemberRole(ctx, owner, viewer.memberId, "role_viewer");
  const viewerActor = actorFromRow(await getMember(ctx, wsId, viewer.memberId));
  const api = client(createApp(ctx));
  const tok = async (a: typeof owner) => tokenFor(ctx, a);
  return { ...f, manager, ann, bo, viewer: viewerActor, api, tok };
}
const send = (w: Awaited<ReturnType<typeof world>>, a: typeof w.owner, ch: string, content: string, extra: object = {}) => sendTeamMessage(w.ctx, a, ch, { content, ...extra });

describe("#general", () => {
  it("exists once per workspace and everyone who opens team chat is in it", async () => {
    const w = await world();
    const mine = (await listChannels(w.ctx, w.ann)).data;
    expect(mine.map((c) => c.name)).toEqual(["general"]);
    expect(mine[0]).toMatchObject({ is_general: true, visibility: "public", joined: true });
    await listChannels(w.ctx, w.bo);
    await listChannels(w.ctx, w.owner);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM team_channels WHERE workspace_id = ? AND is_general = 1", w.wsId)).toEqual({ n: 1 });
    expect(Number((await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM team_channel_members"))!.n)).toBe(3);
  });
  it("cannot be renamed, archived or left", async () => {
    const w = await world();
    const g = (await listChannels(w.ctx, w.owner)).data[0]!;
    await expect(updateChannel(w.ctx, w.owner, g.id, { archived: true })).rejects.toMatchObject({ code: "GENERAL_PROTECTED" });
    await expect(updateChannel(w.ctx, w.owner, g.id, { name: "random" })).rejects.toMatchObject({ code: "GENERAL_PROTECTED" });
    await expect(leaveChannel(w.ctx, w.owner, g.id)).rejects.toMatchObject({ code: "GENERAL_PROTECTED" });
    expect((await updateChannel(w.ctx, w.owner, g.id, { topic: "hello all" })).topic).toBe("hello all");
  });
  it("registering a workspace creates it", async () => {
    const f = await fullApp();
    const r = await f.http.post("/api/auth/register", { email: "new@x.test", password: "password123", name: "N", workspace_name: "New" });
    const chans = await f.http.get("/api/team/channels", r.body.token);
    expect(chans.body.data.map((c: { name: string }) => c.name)).toEqual(["general"]);
  });
});

describe("direct and group messages", () => {
  it("the same people always give the same conversation, in any order, and yourself works", async () => {
    const w = await world();
    const a = await openDm(w.ctx, w.ann, [w.bo.memberId]);
    expect(a.created).toBe(true);
    expect(a.channel).toMatchObject({ kind: "dm", visibility: "private", title: "Bo Agent" });
    const b = await openDm(w.ctx, w.bo, [w.ann.memberId]);
    expect(b.created).toBe(false);
    expect(b.channel.id).toBe(a.channel.id);
    expect(b.channel.title).toBe("Ann Agent");
    const self = await openDm(w.ctx, w.ann, [w.ann.memberId]);
    expect(self.channel).toMatchObject({ kind: "dm", title: "Ann Agent (you)" });
    const g1 = await openDm(w.ctx, w.ann, [w.bo.memberId, w.manager.memberId]);
    const g2 = await openDm(w.ctx, w.manager, [w.ann.memberId, w.bo.memberId, w.manager.memberId]);
    expect(g1.channel.kind).toBe("group");
    expect(g2.channel.id).toBe(g1.channel.id);
  });
  it("concurrent creation resolves to one conversation", async () => {
    const w = await world();
    const [x, y] = await Promise.all([openDm(w.ctx, w.ann, [w.bo.memberId]), openDm(w.ctx, w.bo, [w.ann.memberId])]);
    expect(x.channel.id).toBe(y.channel.id);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM team_channels WHERE kind = 'dm' AND workspace_id = ?", w.wsId)).toEqual({ n: 1 });
  });
  it("rejects people from other workspaces, unknown ids and oversized groups", async () => {
    const w = await world();
    const other = await seedWorkspace(w.ctx, "Other");
    await expect(openDm(w.ctx, w.ann, [other.owner.memberId])).rejects.toMatchObject({ code: "UNKNOWN_MEMBER" });
    await expect(openDm(w.ctx, w.ann, ["mem_" + "0".repeat(24)])).rejects.toMatchObject({ code: "UNKNOWN_MEMBER" });
    const many = [];
    for (let i = 0; i < 8; i++) many.push((await addMemberRaw(w.ctx, w.wsId, { name: `X${i}` })).memberId);
    await expect(openDm(w.ctx, w.ann, many)).rejects.toMatchObject({ code: "TOO_MANY_MEMBERS" });
  });
  it("is invisible to everyone else (404, not 403)", async () => {
    const w = await world();
    const dm = (await openDm(w.ctx, w.ann, [w.bo.memberId])).channel;
    await send(w, w.ann, dm.id, "secret plan");
    for (const outsider of [w.manager, w.owner]) {
      await expect(accessChannel(w.ctx, outsider, dm.id)).rejects.toMatchObject({ status: 404 });
      expect((await w.api.get(`/api/team/channels/${dm.id}/messages`, await w.tok(outsider))).status).toBe(404);
      expect((await w.api.get(`/api/team/channels/${dm.id}`, await w.tok(outsider))).status).toBe(404);
      expect((await searchTeam(w.ctx, outsider, { q: "secret", limit: 10 })).data).toEqual([]);
      expect((await listChannels(w.ctx, outsider)).data.some((c) => c.id === dm.id)).toBe(false);
    }
  });
});

describe("channels", () => {
  it("only managers create channels; names are normalised and unique", async () => {
    const w = await world();
    await expect(createChannel(w.ctx, w.ann, { name: "random" })).rejects.toMatchObject({ status: 403 });
    const c = await createChannel(w.ctx, w.manager, { name: "  Sales Team " });
    expect(c).toMatchObject({ name: "sales-team", visibility: "public", member_count: 1 });
    await expect(createChannel(w.ctx, w.owner, { name: "SALES-team" })).rejects.toMatchObject({ code: "CHANNEL_EXISTS" });
    await expect(createChannel(w.ctx, w.owner, { name: "!!!" })).rejects.toMatchObject({ code: "INVALID_CHANNEL_NAME" });
    await updateChannel(w.ctx, w.manager, c.id, { archived: true });
    expect((await createChannel(w.ctx, w.owner, { name: "sales-team" })).name).toBe("sales-team"); // an archived name is free again
  });

  it("public channels are readable by everyone but writable only after joining; private ones do not exist for outsiders", async () => {
    const w = await world();
    const pub = await createChannel(w.ctx, w.manager, { name: "announcements" });
    const priv = await createChannel(w.ctx, w.manager, { name: "managers-only", visibility: "private", member_ids: [w.owner.memberId] });
    await send(w, w.manager, pub.id, "welcome");
    await send(w, w.manager, priv.id, "salary review");
    expect((await listTeamMessages(w.ctx, w.ann, pub.id, { limit: 10 })).data.map((m) => m.content)).toEqual(["welcome"]);
    await expect(send(w, w.ann, pub.id, "hi")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect((await browseChannels(w.ctx, w.ann)).data.map((c) => c.name)).toEqual(["announcements"]);
    await joinChannel(w.ctx, w.ann, pub.id);
    expect((await send(w, w.ann, pub.id, "hi")).created).toBe(true);
    expect((await browseChannels(w.ctx, w.ann)).data).toEqual([]);
    // private
    await expect(accessChannel(w.ctx, w.ann, priv.id)).rejects.toMatchObject({ status: 404 });
    await expect(joinChannel(w.ctx, w.ann, priv.id)).rejects.toMatchObject({ status: 404 });
    expect((await w.api.get(`/api/team/channels/${priv.id}`, await w.tok(w.ann))).status).toBe(404);
    expect((await searchTeam(w.ctx, w.ann, { q: "salary", limit: 10 })).data).toEqual([]);
    expect((await searchTeam(w.ctx, w.owner, { q: "salary", limit: 10 })).data).toHaveLength(1);
    expect((await browseChannels(w.ctx, w.ann)).data.some((c) => c.name === "managers-only")).toBe(false);
  });

  it("joining starts at the newest message: the backlog is not unread", async () => {
    const w = await world();
    const c = await createChannel(w.ctx, w.manager, { name: "ops" });
    for (let i = 0; i < 5; i++) await send(w, w.manager, c.id, `m${i}`);
    await joinChannel(w.ctx, w.ann, c.id);
    expect((await listChannels(w.ctx, w.ann)).data.find((x) => x.id === c.id)).toMatchObject({ unread: 0 });
  });

  it("members are added and removed by managers or the channel owner; removal cuts access at once", async () => {
    const w = await world();
    const c = await createChannel(w.ctx, w.manager, { name: "launch", visibility: "private", member_ids: [w.ann.memberId] });
    await send(w, w.manager, c.id, "plan");
    await expect(addChannelMembers(w.ctx, w.ann, c.id, [w.bo.memberId])).rejects.toMatchObject({ status: 403 });
    await addChannelMembers(w.ctx, w.manager, c.id, [w.bo.memberId]);
    expect((await listTeamMessages(w.ctx, w.bo, c.id, { limit: 5 })).data).toHaveLength(1);
    await expect(removeChannelMember(w.ctx, w.ann, c.id, w.bo.memberId)).rejects.toMatchObject({ status: 403 });
    w.ctx.bus.clear();
    await removeChannelMember(w.ctx, w.manager, c.id, w.bo.memberId);
    await expect(listTeamMessages(w.ctx, w.bo, c.id, { limit: 5 })).rejects.toMatchObject({ status: 404 });
    expect(w.ctx.bus.ofType("team:channel:removed").some((e) => e.targetId === w.bo.memberId)).toBe(true);
    // and no later message reaches them
    w.ctx.bus.clear();
    await send(w, w.manager, c.id, "after removal");
    expect(w.ctx.bus.ofType("team:message:new").map((e) => e.targetId).sort()).toEqual([ w.ann.memberId, w.manager.memberId].sort());
  });

  it("archived channels are read-only; removed workspace members lose their memberships", async () => {
    const w = await world();
    const c = await createChannel(w.ctx, w.manager, { name: "old", member_ids: [w.ann.memberId] });
    await send(w, w.manager, c.id, "bye");
    await updateChannel(w.ctx, w.manager, c.id, { archived: true });
    await expect(send(w, w.ann, c.id, "still here?")).rejects.toMatchObject({ code: "CHANNEL_ARCHIVED" });
    expect((await listTeamMessages(w.ctx, w.ann, c.id, { limit: 5 })).data).toHaveLength(1);
    await removeMember(w.ctx, w.owner, w.ann.memberId, async () => {});
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM team_channel_members WHERE member_id = ?", w.ann.memberId)).toEqual({ n: 0 });
  });

  it("is tenant isolated: another workspace's channel id is a 404 everywhere", async () => {
    const w = await world();
    const other = await seedWorkspace(w.ctx, "Other");
    const theirs = await createChannel(w.ctx, other.owner, { name: "theirs" });
    const msg = await send(w, other.owner, theirs.id, "their data");
    for (const path of [`/api/team/channels/${theirs.id}`, `/api/team/channels/${theirs.id}/messages`, `/api/team/messages/${msg.message.id}/thread`, `/api/team/channels/${theirs.id}/pins`]) {
      expect((await w.api.get(path, await w.tok(w.owner))).status, path).toBe(404);
    }
    expect((await w.api.post(`/api/team/channels/${theirs.id}/join`, {}, await w.tok(w.owner))).status).toBe(404);
    expect((await w.api.post(`/api/team/channels/${theirs.id}/messages`, { content: "x" }, await w.tok(w.owner))).status).toBe(404);
    expect((await w.api.post(`/api/team/messages/${msg.message.id}/reactions`, { emoji: "👍" }, await w.tok(w.owner))).status).toBe(404);
    expect((await searchTeam(w.ctx, w.owner, { q: "their", limit: 5 })).data).toEqual([]);
  });
});

describe("messages", () => {
  async function channel(w: Awaited<ReturnType<typeof world>>) {
    return await createChannel(w.ctx, w.manager, { name: "dev", member_ids: [w.ann.memberId, w.bo.memberId, w.owner.memberId] });
  }
  it("orders by a contiguous per-channel seq even with identical timestamps", async () => {
    const w = await world();
    const c = await channel(w);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await send(w, w.ann, c.id, `n${i}`)).message);
    expect(ids.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await listTeamMessages(w.ctx, w.ann, c.id, { limit: 50 })).data.map((m) => m.content)).toEqual(["n0", "n1", "n2", "n3", "n4", "n5"]);
  });
  it("is idempotent on client_msg_id, including concurrent duplicates", async () => {
    const w = await world();
    const c = await channel(w);
    const qid = "client-msg-0001";
    const [a, b] = await Promise.all([send(w, w.ann, c.id, "once", { client_msg_id: qid }), send(w, w.ann, c.id, "once", { client_msg_id: qid })]);
    expect(a.message.id).toBe(b.message.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect((await send(w, w.ann, c.id, "once", { client_msg_id: qid })).created).toBe(false);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM team_messages WHERE channel_id = ?", c.id)).toEqual({ n: 1 });
    // the same id in another channel is a different message
    const d = await createChannel(w.ctx, w.manager, { name: "design", member_ids: [w.ann.memberId] });
    expect((await send(w, w.ann, d.id, "once", { client_msg_id: qid })).created).toBe(true);
  });
  it("pages with cursors: empty channel, exactly one page, walking back and forward, bad cursors", async () => {
    const w = await world();
    const c = await channel(w);
    expect(await listTeamMessages(w.ctx, w.ann, c.id, { limit: 3 })).toMatchObject({ data: [], pagination: { has_more_before: false, has_more_after: false, before_cursor: null } });
    for (let i = 1; i <= 7; i++) await send(w, w.ann, c.id, `m${i}`);
    const p1 = await listTeamMessages(w.ctx, w.ann, c.id, { limit: 3 });
    expect(p1.data.map((m) => m.content)).toEqual(["m5", "m6", "m7"]);
    expect(p1.pagination).toMatchObject({ has_more_before: true, has_more_after: false });
    const p2 = await listTeamMessages(w.ctx, w.ann, c.id, { limit: 3, before: p1.pagination.before_cursor! });
    expect(p2.data.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
    const p3 = await listTeamMessages(w.ctx, w.ann, c.id, { limit: 3, before: p2.pagination.before_cursor! });
    expect(p3.data.map((m) => m.content)).toEqual(["m1"]);
    expect(p3.pagination.has_more_before).toBe(false);
    const fwd = await listTeamMessages(w.ctx, w.ann, c.id, { limit: 3, after: p3.pagination.after_cursor! });
    expect(fwd.data.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
    expect(fwd.pagination).toMatchObject({ has_more_before: true, has_more_after: true });
    await expect(listTeamMessages(w.ctx, w.ann, c.id, { limit: 3, before: "tmsg_nope" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(listTeamMessages(w.ctx, w.ann, c.id, { limit: 3, before: p1.pagination.before_cursor!, after: p1.pagination.before_cursor! })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    const other = await createChannel(w.ctx, w.manager, { name: "other", member_ids: [w.ann.memberId] });
    await expect(listTeamMessages(w.ctx, w.ann, other.id, { limit: 3, before: p1.pagination.before_cursor! })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it("validates content: empty, too long, control characters stripped", async () => {
    const w = await world();
    const c = await channel(w);
    await expect(send(w, w.ann, c.id, "   ")).rejects.toMatchObject({ code: "EMPTY_MESSAGE" });
    await expect(send(w, w.ann, c.id, "x".repeat(4001))).rejects.toMatchObject({ code: "CONTENT_TOO_LONG" });
    expect((await send(w, w.ann, c.id, "he\u0000llo")).message.content).toBe("hello");
  });

  it("threads: replies attach to the first message, counts and last reply are computed, replies of replies are refused", async () => {
    const w = await world();
    const c = await channel(w);
    const root = (await send(w, w.ann, c.id, "question?")).message;
    const r1 = (await send(w, w.bo, c.id, "answer", { thread_root_id: root.id })).message;
    await send(w, w.ann, c.id, "thanks", { thread_root_id: root.id });
    await expect(send(w, w.ann, c.id, "nested", { thread_root_id: r1.id })).rejects.toMatchObject({ code: "INVALID_THREAD" });
    await expect(send(w, w.ann, c.id, "nope", { thread_root_id: "tmsg_unknown" })).rejects.toMatchObject({ code: "INVALID_THREAD" });
    const page = await listTeamMessages(w.ctx, w.ann, c.id, { limit: 10 });
    expect(page.data.map((m) => m.content)).toEqual(["question?"]); // replies are not in the channel timeline
    expect(page.data[0]).toMatchObject({ reply_count: 2 });
    const t = await getThread(w.ctx, w.bo, root.id);
    expect(t.replies.map((m) => m.content)).toEqual(["answer", "thanks"]);
    await expect(getThread(w.ctx, w.bo, r1.id)).rejects.toMatchObject({ code: "INVALID_THREAD" });
    // a thread root from another channel cannot be used
    const d = await createChannel(w.ctx, w.manager, { name: "elsewhere", member_ids: [w.ann.memberId] });
    await expect(send(w, w.ann, d.id, "cross", { thread_root_id: root.id })).rejects.toMatchObject({ code: "INVALID_THREAD" });
  });

  it("edit: own messages only, mentions recomputed, editing a deleted message is a 404", async () => {
    const w = await world();
    const c = await channel(w);
    const m = (await send(w, w.ann, c.id, "first draft")).message;
    await expect(editTeamMessage(w.ctx, w.bo, m.id, "hijack")).rejects.toMatchObject({ status: 403 });
    await expect(editTeamMessage(w.ctx, w.manager, m.id, "moderator edit")).rejects.toMatchObject({ status: 403 });
    const e = await editTeamMessage(w.ctx, w.ann, m.id, "second draft");
    expect(e).toMatchObject({ content: "second draft", edited_at: expect.any(String) });
    expect((await w.api.patch(`/api/team/messages/${m.id}`, { content: "" }, await w.tok(w.ann))).status).toBe(400);
    await deleteTeamMessage(w.ctx, w.ann, m.id);
    await expect(editTeamMessage(w.ctx, w.ann, m.id, "zombie")).rejects.toMatchObject({ status: 404 });
  });

  it("delete is soft; own messages by their author, anyone's through the moderation route with team_chat:moderate", async () => {
    const w = await world();
    const c = await channel(w);
    const mine = (await send(w, w.ann, c.id, "mine")).message;
    const theirs = (await send(w, w.bo, c.id, "theirs")).message;
    await expect(deleteTeamMessage(w.ctx, w.ann, theirs.id)).rejects.toMatchObject({ status: 403 });
    expect((await w.api.del(`/api/team/messages/${theirs.id}`, await w.tok(w.manager))).status).toBe(403); // a moderator uses the moderation route
    expect((await w.api.del(`/api/team/channels/${c.id}/messages/${theirs.id}`, await w.tok(w.ann))).status).toBe(403); // an agent lacks the permission
    w.ctx.bus.clear();
    expect((await w.api.del(`/api/team/channels/${c.id}/messages/${theirs.id}`, await w.tok(w.manager))).status).toBe(204);
    expect(w.ctx.bus.ofType("team:message:deleted").length).toBeGreaterThan(0);
    expect((await w.api.del(`/api/team/messages/${mine.id}`, await w.tok(w.ann))).status).toBe(204);
    expect((await listTeamMessages(w.ctx, w.owner, c.id, { limit: 10 })).data).toEqual([]);
    expect(await w.ctx.db.get<{ deleted_by: string }>("SELECT deleted_by FROM team_messages WHERE id = ?", theirs.id)).toEqual({ deleted_by: w.manager.memberId });
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'team.message_moderated'")).toEqual({ n: 1 });
    // idempotent
    expect((await w.api.del(`/api/team/messages/${mine.id}`, await w.tok(w.ann))).status).toBe(204);
  });

  it("reactions toggle per member and emoji; counts and members are returned; junk is refused", async () => {
    const w = await world();
    const c = await channel(w);
    const m = (await send(w, w.ann, c.id, "ship it")).message;
    const r1 = await toggleReaction(w.ctx, w.bo, m.id, "👍");
    expect(r1).toMatchObject({ added: true, reactions: [{ emoji: "👍", count: 1, member_ids: [w.bo.memberId] }] });
    await toggleReaction(w.ctx, w.ann, m.id, "👍");
    const r3 = await toggleReaction(w.ctx, w.bo, m.id, "🎉");
    expect(r3.reactions).toEqual(expect.arrayContaining([{ emoji: "👍", count: 2, member_ids: [w.bo.memberId, w.ann.memberId].sort() }, { emoji: "🎉", count: 1, member_ids: [w.bo.memberId] }]));
    const off = await toggleReaction(w.ctx, w.bo, m.id, "👍");
    expect(off.added).toBe(false);
    expect(off.reactions.find((r) => r.emoji === "👍")).toMatchObject({ count: 1 });
    for (const bad of ["", "two words", "<b>", "x".repeat(33)]) await expect(toggleReaction(w.ctx, w.bo, m.id, bad), bad).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_EMOJI|VALIDATION/) });
    for (let i = 0; i < 18; i++) await toggleReaction(w.ctx, w.bo, m.id, `e${i}`);
    await expect(toggleReaction(w.ctx, w.bo, m.id, "overflow")).rejects.toMatchObject({ code: "TOO_MANY_REACTIONS" });
    expect((await listTeamMessages(w.ctx, w.owner, c.id, { limit: 5 })).data[0]!.reactions.find((r) => r.emoji === "👍")).toMatchObject({ count: 1 });
    // a non-member cannot react in a public channel, an outsider of a private one gets 404
    const other = (await send(w, w.ann, c.id, "x")).message;
    await expect(toggleReaction(w.ctx, w.viewer, other.id, "👍")).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("pins: members pin top-level messages, listed newest first; deleting unpins", async () => {
    const w = await world();
    const c = await channel(w);
    const a = (await send(w, w.ann, c.id, "rules")).message;
    const b = (await send(w, w.ann, c.id, "links")).message;
    const reply = (await send(w, w.bo, c.id, "re", { thread_root_id: a.id })).message;
    await expect(setPinned(w.ctx, w.bo, reply.id, true)).rejects.toMatchObject({ code: "NOT_PINNABLE" });
    await setPinned(w.ctx, w.bo, a.id, true);
    w.ctx.clockCtl.advance(1000);
    await setPinned(w.ctx, w.owner, b.id, true);
    expect((await listPins(w.ctx, w.ann, c.id)).data.map((m) => m.content)).toEqual(["links", "rules"]);
    await setPinned(w.ctx, w.bo, a.id, false);
    await deleteTeamMessage(w.ctx, w.ann, b.id);
    expect((await listPins(w.ctx, w.ann, c.id)).data).toEqual([]);
  });

  it("search: literal text, wildcards are data, scoped to channels you can see, can be limited to one channel", async () => {
    const w = await world();
    const c = await channel(w);
    const priv = await createChannel(w.ctx, w.manager, { name: "board", visibility: "private" });
    await send(w, w.ann, c.id, "deploy at 100% tonight");
    await send(w, w.ann, c.id, "deploy_all is broken");
    await send(w, w.manager, priv.id, "deploy plan for the board");
    expect((await searchTeam(w.ctx, w.ann, { q: "deploy", limit: 10 })).data).toHaveLength(2);
    expect((await searchTeam(w.ctx, w.manager, { q: "deploy", limit: 10 })).data).toHaveLength(3);
    expect((await searchTeam(w.ctx, w.ann, { q: "100%", limit: 10 })).data.map((m) => m.content)).toEqual(["deploy at 100% tonight"]);
    expect((await searchTeam(w.ctx, w.ann, { q: "deploy_", limit: 10 })).data.map((m) => m.content)).toEqual(["deploy_all is broken"]);
    expect((await searchTeam(w.ctx, w.ann, { q: "' OR 1=1 --", limit: 10 })).data).toEqual([]);
    expect((await searchTeam(w.ctx, w.manager, { q: "deploy", channel_id: priv.id, limit: 10 })).data).toHaveLength(1);
    const hit = (await searchTeam(w.ctx, w.ann, { q: "broken", limit: 5 })).data[0]!;
    expect(hit.channel).toMatchObject({ id: c.id, name: "dev" });
    // deleted messages are not found
    await deleteTeamMessage(w.ctx, w.ann, hit.id);
    expect((await searchTeam(w.ctx, w.ann, { q: "broken", limit: 5 })).data).toEqual([]);
    expect((await w.api.get("/api/team/search?q=a", await w.tok(w.ann))).status).toBe(400); // too short
  });
});

describe("unread math (computed from read cursors, no stored counters)", () => {
  it("counts others' messages after your cursor; your own never count; deleted ones drop out; the cursor only moves forward", async () => {
    const w = await world();
    const c = await createChannel(w.ctx, w.manager, { name: "news", member_ids: [w.ann.memberId, w.bo.memberId] });
    const unread = async (a: typeof w.ann) => (await listChannels(w.ctx, a)).data.find((x) => x.id === c.id)!.unread;
    expect(await unread(w.ann)).toBe(0);
    const m1 = (await send(w, w.manager, c.id, "one")).message;
    const m2 = (await send(w, w.manager, c.id, "two")).message;
    await send(w, w.ann, c.id, "mine");
    expect(await unread(w.bo)).toBe(3);
    expect(await unread(w.ann)).toBe(0); // writing marks up to your own message as read
    await deleteTeamMessage(w.ctx, w.manager, m2.id);
    expect(await unread(w.bo)).toBe(2);
    expect((await markTeamRead(w.ctx, w.bo, c.id, m1.id)).moved).toBe(true);
    expect(await unread(w.bo)).toBe(1);
    expect((await markTeamRead(w.ctx, w.bo, c.id, m1.id)).moved).toBe(false); // already there
    await markTeamRead(w.ctx, w.bo, c.id);
    expect(await unread(w.bo)).toBe(0);
    expect((await w.api.post(`/api/team/channels/${c.id}/read`, { message_id: m1.id }, await w.tok(w.bo))).body.moved).toBe(false); // never backwards
    await expect(markTeamRead(w.ctx, w.bo, c.id, "tmsg_none")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(await unread(w.bo)).toBe(0);
  });
  it("mention_unread counts only messages that mention you and clears with the cursor", async () => {
    const w = await world();
    const c = await createChannel(w.ctx, w.manager, { name: "team", member_ids: [w.ann.memberId, w.bo.memberId] });
    await send(w, w.manager, c.id, `hey @[Ann Agent](${w.ann.memberId}) look`);
    await send(w, w.manager, c.id, "unrelated");
    const row = async (a: typeof w.ann) => (await listChannels(w.ctx, a)).data.find((x) => x.id === c.id)!;
    expect(await row(w.ann)).toMatchObject({ unread: 2, mention_unread: 1 });
    expect(await row(w.bo)).toMatchObject({ unread: 2, mention_unread: 0 });
    await markTeamRead(w.ctx, w.ann, c.id);
    expect(await row(w.ann)).toMatchObject({ unread: 0, mention_unread: 0 });
  });
});

describe("mentions and notifications", () => {
  async function chan(w: Awaited<ReturnType<typeof world>>, name = "chat") {
    return await createChannel(w.ctx, w.manager, { name, member_ids: [w.ann.memberId, w.bo.memberId] });
  }
  const notifs = async (w: Awaited<ReturnType<typeof world>>, a: typeof w.ann) => (await listNotifications(w.ctx, a, { limit: 20 })).data.filter((n) => n.type.startsWith("team_"));
  it("notifies the people mentioned by token or handle, not the author, not people who cannot see a private channel", async () => {
    const w = await world();
    const priv = await createChannel(w.ctx, w.manager, { name: "inner", visibility: "private", member_ids: [w.ann.memberId] });
    await send(w, w.manager, priv.id, `@[Ann Agent](${w.ann.memberId}) and @bo and @[Mia Manager](${w.manager.memberId})`);
    const n = await notifs(w, w.ann);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: "team_mention", channel_id: priv.id, title: "Mia Manager mentioned you in #inner" });
    expect(await notifs(w, w.bo)).toEqual([]); // bo is not in the private channel
    expect(await notifs(w, w.manager)).toEqual([]);
    expect(w.ctx.bus.ofType("notification:new").some((e) => e.targetId === w.ann.memberId)).toBe(true);
    const c = await chan(w);
    await send(w, w.manager, c.id, "ping @bo please");
    expect((await notifs(w, w.bo)).map((x) => x.type)).toEqual(["team_mention"]);
  });
  it("@channel notifies everyone in the channel, but a muted member only hears of a mention by name", async () => {
    const w = await world();
    const c = await chan(w);
    await setMuted(w.ctx, w.bo, c.id, true);
    await send(w, w.manager, c.id, "@channel standup now");
    expect(await notifs(w, w.ann)).toHaveLength(1);
    expect(await notifs(w, w.bo)).toHaveLength(0);
    await send(w, w.manager, c.id, `@[Bo Agent](${w.bo.memberId}) just you`);
    expect(await notifs(w, w.bo)).toHaveLength(1);
  });
  it("direct messages notify the other people; muting and the preference silence them; plain channel chatter does not notify", async () => {
    const w = await world();
    const dm = (await openDm(w.ctx, w.ann, [w.bo.memberId])).channel;
    await send(w, w.ann, dm.id, "got a minute?");
    expect((await notifs(w, w.bo)).map((n) => ({ type: n.type, title: n.title }))).toEqual([{ type: "team_dm", title: "Ann Agent sent you a message" }]);
    expect(await notifs(w, w.ann)).toEqual([]);
    await setMuted(w.ctx, w.bo, dm.id, true);
    await send(w, w.ann, dm.id, "hello?");
    expect(await notifs(w, w.bo)).toHaveLength(1);
    await setMuted(w.ctx, w.bo, dm.id, false);
    await updateMember(w.ctx, w.bo, w.bo.memberId, { notification_prefs: { team_messages: false } });
    await send(w, w.ann, dm.id, "again");
    expect(await notifs(w, w.bo)).toHaveLength(1);
    const c = await chan(w);
    await send(w, w.manager, c.id, "just chatting");
    expect((await notifs(w, w.ann)).filter((n) => n.channel_id === c.id)).toEqual([]);
  });
  it("the mentions preference switches mention notifications off", async () => {
    const w = await world();
    const c = await chan(w);
    await updateMember(w.ctx, w.ann, w.ann.memberId, { notification_prefs: { mentions: false } });
    await send(w, w.manager, c.id, `@[Ann Agent](${w.ann.memberId}) hi`);
    expect(await notifs(w, w.ann)).toEqual([]);
  });
  it("editing notifies only the newly mentioned; deleting removes the mentions", async () => {
    const w = await world();
    const c = await chan(w);
    const m = (await send(w, w.manager, c.id, `@[Ann Agent](${w.ann.memberId}) first`)).message;
    await editTeamMessage(w.ctx, w.manager, m.id, `@[Ann Agent](${w.ann.memberId}) and @[Bo Agent](${w.bo.memberId}) edited`);
    expect(await notifs(w, w.ann)).toHaveLength(1);
    expect(await notifs(w, w.bo)).toHaveLength(1);
    await deleteTeamMessage(w.ctx, w.manager, m.id);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM team_mentions WHERE message_id = ?", m.id)).toEqual({ n: 0 });
  });
  it("emails an offline member who wants email, but not one in do-not-disturb or online; the link opens the chat", async () => {
    const w = await world();
    const dm = (await openDm(w.ctx, w.ann, [w.bo.memberId, w.manager.memberId])).channel;
    await updateMember(w.ctx, w.manager, w.manager.memberId, { dnd_until: new Date(w.ctx.clock().getTime() + 3600_000).toISOString() });
    await send(w, w.ann, dm.id, "heads up");
    await runDueJobs(w.ctx, jobHandlers);
    const sent = w.ctx.email.sent.filter((e) => /sent you a message/.test(e.subject));
    expect(sent.map((e) => e.to)).toEqual(["bo@acme.test"]);
    expect(sent[0]!.text).toContain(`/team/${dm.id}`);
  });
});

describe("sharing a customer conversation into a channel", () => {
  it("members who can open the conversation see its card; others get a bare card with no content", async () => {
    const w = await world();
    const { room, contact } = await mkRoom(w.ctx, w.wsId, { contact: { name: "Dana Customer", email: "dana@example.test" }, assignees: [w.ann] });
    const c = await createChannel(w.ctx, w.manager, { name: "escalations", member_ids: [w.ann.memberId, w.bo.memberId] });
    const shared = await send(w, w.ann, c.id, "can someone take this?", { share_room_id: room.id });
    expect(shared.message).toMatchObject({ kind: "share", share: { room_id: room.id, available: true, title: "Dana Customer", status: "open" } });
    const forBo = (await listTeamMessages(w.ctx, w.bo, c.id, { limit: 5 })).data[0]!;
    expect(forBo.share).toEqual({ room_id: room.id, available: false }); // bo is an agent of no inbox and not assigned
    expect(JSON.stringify(forBo)).not.toContain("Dana");
    const forManager = (await listTeamMessages(w.ctx, w.manager, c.id, { limit: 5 })).data[0]!;
    expect(forManager.share).toMatchObject({ available: true, title: "Dana Customer" });
    // realtime copies are made per viewer too
    w.ctx.bus.clear();
    await send(w, w.ann, c.id, "again", { share_room_id: room.id });
    const ev = w.ctx.bus.ofType("team:message:new");
    expect(ev.find((e) => e.targetId === w.bo.memberId)!.payload.message.share).toEqual({ room_id: room.id, available: false });
    expect(ev.find((e) => e.targetId === w.ann.memberId)!.payload.message.share.available).toBe(true);
    expect(JSON.stringify(ev.find((e) => e.targetId === w.bo.memberId)!.payload)).not.toContain("Dana");
    // once bo is assigned, the card opens for them
    const { setAssignees } = await import("../src/services/rooms.js");
    await setAssignees(w.ctx, room, [w.ann.memberId, w.bo.memberId], "Test");
    expect((await listTeamMessages(w.ctx, w.bo, c.id, { limit: 5 })).data[0]!.share).toMatchObject({ available: true });
    void contact;
  });
  it("cannot be shared by someone who may not open the conversation (404, nothing stored), nor from another workspace", async () => {
    const w = await world();
    const { room } = await mkRoom(w.ctx, w.wsId, { contact: { name: "Private Person", email: "p@example.test" } });
    const c = await createChannel(w.ctx, w.manager, { name: "general-chat", member_ids: [w.bo.memberId] });
    await expect(send(w, w.bo, c.id, "look", { share_room_id: room.id })).rejects.toMatchObject({ status: 404 });
    const other = await seedWorkspace(w.ctx, "Other");
    const theirRoom = await mkRoom(w.ctx, other.wsId);
    await expect(send(w, w.manager, c.id, "look", { share_room_id: theirRoom.room.id })).rejects.toMatchObject({ status: 404 });
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM team_messages WHERE channel_id = ?", c.id)).toEqual({ n: 0 });
  });
});

describe("permissions", () => {
  it("a custom role without team_chat:use is refused everywhere; with it, chat works", async () => {
    const w = await world();
    const role = await createRole(w.ctx, w.owner, { name: "Billing only", base_role: "agent", permissions: ["conversations:read"] });
    const m = await addMemberRaw(w.ctx, w.wsId, { name: "Cy" });
    await setMemberRole(w.ctx, w.owner, m.memberId, role.id);
    const cy = actorFromRow(await getMember(w.ctx, w.wsId, m.memberId));
    const t = await w.tok(cy);
    for (const [method, path] of [["GET", "/api/team/channels"], ["GET", "/api/team/search?q=abc"], ["POST", "/api/team/dms"]] as const) {
      const r = method === "GET" ? await w.api.get(path, t) : await w.api.post(path, { member_ids: [w.ann.memberId] }, t);
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe("PERMISSION_DENIED");
    }
    const role2 = await createRole(w.ctx, w.owner, { name: "Chatty", base_role: "agent", permissions: ["conversations:read", "team_chat:use"] });
    await setMemberRole(w.ctx, w.owner, m.memberId, role2.id);
    expect((await w.api.get("/api/team/channels", await w.tok(actorFromRow(await getMember(w.ctx, w.wsId, m.memberId))))).status).toBe(200);
  });
  it("agents and viewers chat but cannot create channels", async () => {
    const w = await world();
    expect((await w.api.post("/api/team/channels", { name: "x" }, await w.tok(w.ann))).status).toBe(403);
    expect((await w.api.post("/api/team/channels", { name: "x" }, await w.tok(w.viewer))).status).toBe(403);
    expect((await w.api.post("/api/team/dms", { member_ids: [w.ann.memberId] }, await w.tok(w.viewer))).status).toBe(201);
    expect((await w.api.post("/api/team/channels", { name: "ok" }, await w.tok(w.manager))).status).toBe(201);
  });
});

describe("retention", () => {
  it("deletes messages older than team_retention_days (pins kept) and purges soft-deleted ones after 30 days", async () => {
    const w = await world();
    const c = await createChannel(w.ctx, w.manager, { name: "keep", member_ids: [w.ann.memberId] });
    await setSettings(w.ctx, w.wsId, { team_retention_days: 10 });
    const old = (await send(w, w.ann, c.id, "old")).message;
    const pinned = (await send(w, w.ann, c.id, "old but pinned")).message;
    await setPinned(w.ctx, w.ann, pinned.id, true);
    const gone = (await send(w, w.ann, c.id, "deleted")).message;
    await deleteTeamMessage(w.ctx, w.ann, gone.id);
    w.ctx.clockCtl.advance(11 * 86400_000);
    const fresh = (await send(w, w.ann, c.id, "fresh")).message;
    const r = await teamRetentionSweep(w.ctx);
    expect(r.deleted).toBeGreaterThanOrEqual(2);
    const left = (await w.ctx.db.all<{ id: string }>("SELECT id FROM team_messages WHERE channel_id = ?", c.id)).map((x) => x.id).sort();
    expect(left).toEqual([pinned.id, fresh.id].sort());
    void old;
  });
});
