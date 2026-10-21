import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { assignRoom, setStatus, snoozeRoom, wakeRoom } from "../src/services/rooms.js";
import { postSystemMessage, VISITOR_SYSTEM_SUBTYPES } from "../src/services/messageStore.js";
import { sendAgentMessage } from "../src/services/messages.js";
import type { RoomRow } from "../src/services/roomStore.js";
import { ALL_EVENTS, ack, recorder, sleep, startServer } from "./rt-helpers.js";
import { addMemberRaw, client } from "./helpers.js";

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "40", SOCKET_RATE_PER_SEC: "1000" });
});
afterAll(async () => {
  await srv.close();
});

/** Every kind of system line the server writes today, plus one it does not know yet (unknown must be internal). */
const INTERNAL_SUBTYPES = ["assignee", "status", "snooze", "snooze_ended", "sms_consent", "priority", "mention", "ai_triage", "some_future_kind"];

async function world() {
  const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
  const v = await srv.visitor(wsId);
  const agent = await srv.team(wsId, owner);
  const vis = await srv.connect(wsId, v.auth);
  const visRec = recorder(vis, ALL_EVENTS);
  const agentRec = recorder(agent, ALL_EVENTS);
  const created = await ack(vis, "room:create", {});
  const roomId = created.room.id as string;
  const room = async () => (await srv.ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ?", roomId))!;
  const app = client(createApp(srv.ctx));
  const vh = { "x-support-session": v.secret, "x-device-id": "device-rt-0001", origin: `https://${v.domain}` };
  const visitorMessages = async () => (await app.get(`/public/rooms/${roomId}/messages?limit=50`, undefined, vh)).body as { data: any[]; room: any };
  const teamMessages = async () => (await app.get(`/api/rooms/${roomId}/messages?limit=50`, await (await import("./helpers.js")).tokenFor(srv.ctx, owner))).body.data as any[];
  return { wsId, owner, v, vis, visRec, agent, agentRec, roomId, room, app, vh, visitorMessages, teamMessages };
}

describe("what a visitor is shown of the team's internal work", () => {
  it("never receives assignment, status, snooze, consent or unknown system lines (REST and socket), but the team still does", async () => {
    const w = await world();
    const mate = await addMemberRaw(srv.ctx, w.wsId, { name: "Sam Support", role: "agent" });
    await assignRoom(srv.ctx, w.owner, w.roomId, { member_ids: [mate.memberId] } as never).catch(async () => {
      const { setAssignees } = await import("../src/services/rooms.js");
      await setAssignees(srv.ctx, await w.room(), [mate.memberId], "Olivia Owner");
    });
    await setStatus(srv.ctx, w.owner, w.roomId, "closed");
    await setStatus(srv.ctx, w.owner, w.roomId, "open");
    await snoozeRoom(srv.ctx, w.owner, w.roomId, new Date(srv.ctx.clock().getTime() + 3600_000).toISOString());
    srv.ctx.clockCtl.advance(2 * 3600_000);
    const r = await w.room();
    await wakeRoom(srv.ctx, r);
    for (const sub of INTERNAL_SUBTYPES) await postSystemMessage(srv.ctx, w.roomId, w.wsId, `internal ${sub} line naming Olivia Owner`, { sub_type: sub });
    await sendAgentMessage(srv.ctx, w.owner, w.roomId, { kind: "note", source: "dm", content: "note about the customer" });
    await sendAgentMessage(srv.ctx, w.owner, w.roomId, { kind: "text", source: "dm", content: "Hello from the team" });
    await sleep(120);

    // team views keep every line (regression: agents must still see them)
    const team = await w.teamMessages();
    expect(team.filter((m) => m.kind === "system").map((m) => m.meta.sub_type)).toEqual(expect.arrayContaining(["assignee", "status", "snooze", "snooze_ended", ...INTERNAL_SUBTYPES.slice(4)]));
    expect(team.some((m) => m.kind === "note")).toBe(true);

    // visitor REST
    const page = await w.visitorMessages();
    const texts = JSON.stringify(page.data);
    expect(texts).not.toContain("internal ");
    expect(texts).not.toContain("assigned");
    expect(texts).not.toContain("closed the conversation");
    expect(texts).not.toContain("note about the customer");
    expect(page.data.filter((m) => m.kind === "system").every((m) => (VISITOR_SYSTEM_SUBTYPES as readonly string[]).includes(m.meta.sub_type))).toBe(true);
    expect(page.data.some((m) => m.content === "Hello from the team")).toBe(true);

    // visitor socket
    const live = w.visRec.of("message:new");
    expect(live.some((p) => p.message.kind === "system" && !(VISITOR_SYSTEM_SUBTYPES as readonly string[]).includes(p.message.meta.sub_type))).toBe(false);
    expect(JSON.stringify(live)).not.toContain("internal ");
    expect(JSON.stringify(live)).not.toContain("assigned");
    expect(JSON.stringify(live)).not.toContain("note about the customer");
    expect(w.visRec.of("message:updated").length).toBe(0);
    // the team socket did get them
    expect(w.agentRec.of("message:new").some((p) => p.message.kind === "system" && p.message.meta.sub_type === "status")).toBe(true);
  });

  it("still shows customer-facing system lines (conversation started, payments)", async () => {
    const w = await world();
    await postSystemMessage(srv.ctx, w.roomId, w.wsId, "Payment received: $25.00 (Deposit)", { sub_type: "payment", payment_request_id: "pay_1" });
    await sleep(80);
    const page = await w.visitorMessages();
    expect(page.data.map((m) => m.meta.sub_type).filter(Boolean)).toEqual(expect.arrayContaining(["payment"]));
    expect(w.visRec.of("message:new").some((p) => p.message.meta.sub_type === "payment")).toBe(true);
  });

  it("pagination is unaffected by hidden lines (a page of 3 is 3 visible messages)", async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await postSystemMessage(srv.ctx, w.roomId, w.wsId, `hidden ${i}`, { sub_type: "assignee" });
    for (let i = 0; i < 4; i++) await sendAgentMessage(srv.ctx, w.owner, w.roomId, { kind: "text", source: "dm", content: `visible ${i}` });
    const r = await w.app.get(`/public/rooms/${w.roomId}/messages?limit=3`, undefined, w.vh);
    expect(r.body.data).toHaveLength(3);
    expect(r.body.data.map((m: any) => m.content)).toEqual(["visible 1", "visible 2", "visible 3"]);
    expect(r.body.pagination.has_more_before).toBe(true);
  });

  it("the closed state is stated by the server, not read from a visible close line", async () => {
    const w = await world();
    await sendAgentMessage(srv.ctx, w.owner, w.roomId, { kind: "text", source: "dm", content: "Anything else?" });
    await setStatus(srv.ctx, w.owner, w.roomId, "closed");
    await sleep(80);
    const upd = w.visRec.of("room:updated").at(-1);
    expect(upd.room).toMatchObject({ id: w.roomId, status: "closed", closed_marker: { id: expect.any(String), seq: expect.any(Number) } });
    const page = await w.visitorMessages();
    expect(page.room).toMatchObject({ status: "closed", closed_marker: { id: upd.room.closed_marker.id } });
    expect(page.data.some((m) => m.meta?.sub_type === "status")).toBe(false);
    const rooms = await w.app.get("/public/rooms", undefined, w.vh);
    expect(rooms.body.data[0].closed_marker.id).toBe(upd.room.closed_marker.id);
    // the visitor writes again: the conversation is live, no marker
    await ack(w.vis, "message:send", { room_id: w.roomId, kind: "text", source: "dm", content: "one more thing", client_msg_id: "rt-reopen-0001" });
    expect((await w.visitorMessages()).room).toMatchObject({ status: "open", closed_marker: null });
    // last_message in the room list never quotes an internal line
    expect(rooms.body.data[0].last_message.sender_type).not.toBe("system");
  });
});
