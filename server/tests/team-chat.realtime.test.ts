import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRole, setMemberRole } from "../src/services/roles.js";
import { removeChannelMember, createChannel, openDm } from "../src/services/teamChat.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { ack, recorder, sleep, startServer } from "./rt-helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "40", SOCKET_RATE_PER_SEC: "1000" });
});
afterAll(async () => {
  await srv.close();
});

const EVENTS = ["team:message:new", "team:message:updated", "team:message:deleted", "team:reaction", "team:channel:created", "team:channel:updated", "team:channel:removed", "team:channel:members", "team:typing", "team:read", "notification:new"];

async function world() {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
  const mk = (name: string, role: "manager" | "agent" = "agent") => srv.addMemberRaw(srv.ctx, wsId, { name, role });
  const ann = await mk("Ann"), bo = await mk("Bo"), cy = await mk("Cy", "manager");
  const sock = async (a: typeof ann) => {
    const s = await srv.team(wsId, a);
    return { s, rec: recorder(s, EVENTS) };
  };
  return { wsId, owner, ann, bo, cy, sock };
}

describe("team chat over sockets", () => {
  it("delivers a message to the other members only, in real time, and acks the sender", async () => {
    const w = await world();
    const ch = await createChannel(srv.ctx, w.cy, { name: "ops", visibility: "private", member_ids: [w.ann.memberId, w.bo.memberId] });
    const [ann, bo, owner] = [await w.sock(w.ann), await w.sock(w.bo), await w.sock(w.owner)];
    const sent = await ack(ann.s, "team:message:send", { channel_id: ch.id, content: "hello team", client_msg_id: "rt-team-0001" });
    expect(sent).toMatchObject({ ok: true, created: true, message: { content: "hello team", seq: 1, sender: { id: w.ann.memberId } } });
    const got = await bo.rec.waitFor("team:message:new");
    expect(got).toMatchObject({ channel_id: ch.id, message: { content: "hello team", client_msg_id: "rt-team-0001" } });
    await ann.rec.waitFor("team:message:new"); // the sender's other tabs / own echo
    await sleep(80);
    expect(owner.rec.of("team:message:new")).toEqual([]); // not a member of the private channel
    // idempotent over the socket
    const again = await ack(ann.s, "team:message:send", { channel_id: ch.id, content: "hello team", client_msg_id: "rt-team-0001" });
    expect(again).toMatchObject({ ok: true, created: false, message: { id: sent.message.id } });
    await sleep(60);
    expect(bo.rec.of("team:message:new")).toHaveLength(1);
  });

  it("refuses sends from non-members and from members of other workspaces, with the same not-found as REST", async () => {
    const w = await world();
    const ch = await createChannel(srv.ctx, w.cy, { name: "board", visibility: "private" });
    const bo = await w.sock(w.bo);
    expect(await ack(bo.s, "team:message:send", { channel_id: ch.id, content: "let me in" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const other = await srv.seedWorkspace(srv.ctx, "Other");
    const theirs = await createChannel(srv.ctx, other.owner, { name: "theirs" });
    expect(await ack(bo.s, "team:message:send", { channel_id: theirs.id, content: "x" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const own = await createChannel(srv.ctx, w.cy, { name: "mine", member_ids: [w.bo.memberId] });
    expect(await ack(bo.s, "team:message:send", { channel_id: own.id })).toMatchObject({ ok: false, error: { code: "EMPTY_MESSAGE" } });
  });

  it("removing someone from a private channel stops their live delivery at once", async () => {
    const w = await world();
    const ch = await createChannel(srv.ctx, w.cy, { name: "temp", visibility: "private", member_ids: [w.ann.memberId, w.bo.memberId] });
    const [ann, bo] = [await w.sock(w.ann), await w.sock(w.bo)];
    await ack(ann.s, "team:message:send", { channel_id: ch.id, content: "before" });
    await bo.rec.waitFor("team:message:new");
    await removeChannelMember(srv.ctx, w.cy, ch.id, w.bo.memberId);
    await bo.rec.waitFor("team:channel:removed");
    await ack(ann.s, "team:message:send", { channel_id: ch.id, content: "after" });
    await sleep(100);
    expect(bo.rec.of("team:message:new").map((p) => p.message.content)).toEqual(["before"]);
    expect(await ack(bo.s, "team:typing", { channel_id: ch.id, typing: true })).toMatchObject({ ok: false });
  });

  it("typing reaches the other members only; read cursors and reactions are acknowledged and broadcast", async () => {
    const w = await world();
    const dm = (await openDm(srv.ctx, w.ann, [w.bo.memberId])).channel;
    const [ann, bo] = [await w.sock(w.ann), await w.sock(w.bo)];
    await ack(ann.s, "team:typing", { channel_id: dm.id, typing: true });
    const t = await bo.rec.waitFor("team:typing");
    expect(t).toMatchObject({ channel_id: dm.id, typing: true, member_id: w.ann.memberId, name: "Ann" });
    await sleep(60);
    expect(ann.rec.of("team:typing")).toEqual([]);
    const m = (await ack(ann.s, "team:message:send", { channel_id: dm.id, content: "ping" })).message;
    await bo.rec.waitFor("team:message:new");
    expect(await ack(bo.s, "team:read", { channel_id: dm.id, message_id: m.id })).toMatchObject({ ok: true, moved: true });
    expect(await ann.rec.waitFor("team:read")).toMatchObject({ channel_id: dm.id, member_id: w.bo.memberId, seq: 1 });
    expect(await ack(bo.s, "team:reaction", { message_id: m.id, emoji: "👍" })).toMatchObject({ ok: true, added: true });
    expect(await ann.rec.waitFor("team:reaction")).toMatchObject({ message_id: m.id, reactions: [{ emoji: "👍", count: 1, member_ids: [w.bo.memberId] }] });
  });

  it("a role without team_chat:use gets PERMISSION_DENIED on every team event", async () => {
    const w = await world();
    const role = await createRole(srv.ctx, w.owner, { name: "No chat", base_role: "agent", permissions: ["conversations:read"] });
    await setMemberRole(srv.ctx, w.owner, w.bo.memberId, role.id);
    const bo = await srv.team(w.wsId, actorFromRow(await getMember(srv.ctx, w.wsId, w.bo.memberId)));
    for (const [ev, p] of [["team:message:send", { channel_id: "x", content: "a" }], ["team:typing", { channel_id: "x", typing: true }], ["team:read", { channel_id: "x" }], ["team:reaction", { message_id: "x", emoji: "👍" }]] as const) {
      expect(await ack(bo, ev, p), ev).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    }
  });

  it("floods are limited per event with RATE_LIMITED and a retry hint", async () => {
    const s2 = await startServer({ SOCKET_RATE_BURST: "6", SOCKET_RATE_PER_SEC: "1", WS_STRIKE_LIMIT: "1000" });
    try {
      const { wsId, owner } = await s2.seedWorkspace(s2.ctx, "Flood");
      const ch = await createChannel(s2.ctx, owner, { name: "spam" });
      const sock = await s2.team(wsId, owner);
      const acks = [] as { ok: boolean; error?: { code: string } }[];
      for (let i = 0; i < 8; i++) acks.push(await ack(sock, "team:message:send", { channel_id: ch.id, content: `m${i}` }));
      expect(acks.slice(0, 3).every((a) => a.ok)).toBe(true);
      expect(acks.some((a) => a.error?.code === "RATE_LIMITED")).toBe(true);
    } finally {
      await s2.close();
    }
  });
});
