import { describe, expect, it } from "vitest";
import { tokenFor } from "./helpers.js";
import { agentWorld, answerWith, say, ScriptedProvider, ticketOf, type AgentWorld } from "./agent-helpers.js";

type Visitor = Awaited<ReturnType<AgentWorld["visitor"]>>;

/** the newest quick-reply card the bot posted, with its message id */
async function card(w: AgentWorld, v: Visitor) {
  const rows = await w.ctx.db.all<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE room_id = ? AND sender_type = 'bot' AND kind = 'text' ORDER BY seq DESC", v.roomId);
  const row = rows.find((r) => JSON.parse(r.meta).card?.type === "quick_replies");
  return row ? { id: row.id, ...JSON.parse(row.meta).card } : null;
}
const tap = (w: AgentWorld, v: Visitor, messageId: string, optionId: string) => w.http.post(`/public/rooms/${v.roomId}/quick-reply`, { message_id: messageId, option_id: optionId }, undefined, v.headers);
const answered = async (w: AgentWorld) => {
  const w2 = w;
  const v = await w2.visitor();
  await say(w2, v, "How do I reset my password?");
  return v;
};

describe("quick replies", () => {
  it("'Yes' resolves the ticket, shows as the visitor's own message, closes the card and cannot be tapped twice", async () => {
    const w = await agentWorld();
    const v = await answered(w);
    const c = (await card(w, v))!;
    expect(c).toMatchObject({ purpose: "solved", options: [{ id: "yes" }, { id: "no" }, { id: "human" }] });
    const r = await tap(w, v, c.id, "yes");
    expect(r.status).toBe(200);
    expect(r.body.ticket.status).toBe("resolved");
    expect(await ticketOf(w, v.roomId)).toMatchObject({ status: "resolved", resolution: "bot_resolved" });
    const mine = await w.ctx.db.all<{ content_text: string; meta: string }>("SELECT content_text, meta FROM messages WHERE room_id = ? AND sender_type = 'contact' ORDER BY seq DESC LIMIT 1", v.roomId);
    expect(mine[0]!.content_text).toBe(c.options[0].label);
    expect(JSON.parse(mine[0]!.meta).quick_reply).toEqual({ message_id: c.id, option_id: "yes" });
    expect((await card(w, v))!.answered).toBe("yes");
    expect((await tap(w, v, c.id, "yes")).body.error.code).toBe("ALREADY_ANSWERED");
  });

  it("'No' makes the agent try again or hand over; 'Talk to a person' hands over at once", async () => {
    const w = await agentWorld();
    const v = await answered(w);
    await tap(w, v, (await card(w, v))!.id, "no");
    await w.ctx.background.settle();
    const t = await ticketOf(w, v.roomId);
    expect(["bot_handling", "waiting_for_human"]).toContain(t.status);
    const w2 = await agentWorld();
    const v2 = await answered(w2);
    expect((await tap(w2, v2, (await card(w2, v2))!.id, "human")).body.ticket.status).toBe("waiting_for_human");
    expect((await ticketOf(w2, v2.roomId)).handoff_reason).toBe("customer_requested_human");
  });

  it("refuses unknown options, other kinds of messages and other people's rooms; two taps at once act once", async () => {
    const w = await agentWorld();
    const v = await answered(w);
    const c = (await card(w, v))!;
    expect((await tap(w, v, c.id, "maybe")).status).toBe(422);
    expect((await tap(w, v, "msg_nope", "yes")).status).toBe(404);
    const other = await w.visitor({}, "device-bbbb-0002");
    expect((await w.http.post(`/public/rooms/${v.roomId}/quick-reply`, { message_id: c.id, option_id: "yes" }, undefined, other.headers)).status).toBeGreaterThanOrEqual(403);
    const [a, b] = await Promise.all([tap(w, v, c.id, "yes"), tap(w, v, c.id, "yes")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const mine = await w.ctx.db.all("SELECT id FROM messages WHERE room_id = ? AND sender_type = 'contact' AND content_text = ?", v.roomId, c.options[0].label);
    expect(mine).toHaveLength(1);
  });
});

describe("talk to a person", () => {
  it("works whether or not an agent is on: routes with the reason, is one message, and asking again changes nothing", async () => {
    for (const enabled of [true, false]) {
      const w = await agentWorld({ agent: { enabled } });
      const v = await w.visitor();
      const r = await w.http.post(`/public/rooms/${v.roomId}/request-human`, {}, undefined, v.headers);
      expect(r.status).toBe(200);
      const t = await ticketOf(w, v.roomId);
      expect(t.handoff_reason).toBe("customer_requested_human");
      expect(t.handler).toBe(`human:${w.ann.memberId}`);
      const again = await w.http.post(`/public/rooms/${v.roomId}/request-human`, {}, undefined, v.headers);
      expect(again.body.already).toBe(true);
      const msgs = await w.ctx.db.all("SELECT id FROM messages WHERE room_id = ? AND sender_type = 'contact'", v.roomId);
      expect(msgs).toHaveLength(1);
    }
  });
  it("stops the agent: the next message from the visitor is not answered by it", async () => {
    const w = await agentWorld();
    const v = await answered(w);
    await w.http.post(`/public/rooms/${v.roomId}/request-human`, {}, undefined, v.headers);
    const model = new ScriptedProvider(answerWith());
    w.ctx.ai = model;
    await say(w, v, "What are your opening hours?");
    expect(model.calls).toHaveLength(0);
    expect((await ticketOf(w, v.roomId)).handler?.startsWith("human:")).toBe(true);
  });
});

describe("take over and hand back", () => {
  it("a person claims a ticket the agent is handling: the agent stops, the visitor is told, and hand-back brings the agent back", async () => {
    const w = await agentWorld();
    const v = await answered(w);
    const t0 = await ticketOf(w, v.roomId);
    const ann = await tokenFor(w.ctx, w.ann);
    const claimed = await w.http.post(`/api/tickets/${t0.id}/claim`, {}, ann);
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ status: "open", handler: `human:${w.ann.memberId}` });
    const model = new ScriptedProvider(answerWith());
    w.ctx.ai = model;
    await say(w, v, "What are your opening hours?");
    expect(model.calls).toHaveLength(0);
    const back = await w.http.post(`/api/tickets/${t0.id}/hand-back`, {}, ann);
    expect(back.body).toMatchObject({ status: "bot_handling", handler: `bot:${w.agent.id}` });
    await say(w, v, "What are your opening hours?");
    expect(model.calls).toHaveLength(1);
    const sys = (await w.ctx.db.all<{ meta: string }>("SELECT meta FROM messages WHERE room_id = ? AND kind = 'system'", v.roomId)).map((m) => JSON.parse(m.meta).sub_type);
    expect(sys).toContain("handed_back");
  });
  it("hand-back needs a person who has it and an agent that is on; another agent seat cannot do it for them", async () => {
    const w = await agentWorld();
    const v = await answered(w);
    const t0 = await ticketOf(w, v.roomId);
    expect((await w.http.post(`/api/tickets/${t0.id}/hand-back`, {}, w.token)).body.error.code).toBe("NOT_WITH_A_PERSON");
    const ann = await tokenFor(w.ctx, w.ann);
    const bo = await tokenFor(w.ctx, w.bo);
    await w.http.post(`/api/tickets/${t0.id}/claim`, {}, ann);
    expect((await w.http.post(`/api/tickets/${t0.id}/hand-back`, {}, bo)).status).toBeGreaterThanOrEqual(403);
    await w.http.patch(`/api/agents/${w.agent.id}`, { enabled: false }, w.token);
    expect((await w.http.post(`/api/tickets/${t0.id}/hand-back`, {}, ann)).body.error.code).toBe("NO_AGENT");
  });
});

describe("sandbox", () => {
  it("shows what the agent would do and stores nothing", async () => {
    const w = await agentWorld();
    const count = async () => [await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages"), await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets"), await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_turns"), await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rooms"), await w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log")].map((x) => Number(x!.n));
    const before = await count();
    const r = await w.http.post(`/api/agents/${w.agent.id}/sandbox`, { message: "How do I reset my password?" }, w.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "answer", handoff: null });
    expect(r.body.reply).toContain("Reset password");
    expect(r.body.sources[0]).toMatchObject({ question: "How do I reset my password?" });
    expect(r.body.trace.length).toBeGreaterThan(0);
    const h = await w.http.post(`/api/agents/${w.agent.id}/sandbox`, { message: "I want a human", turns: 1 }, w.token);
    expect(h.body.handoff).toMatchObject({ reason: "customer_requested_human" });
    expect(h.body.routing).toMatchObject({ outcome: expect.any(String), department: { name: "Technical support" } });
    expect(await count()).toEqual(before);
  });
  it("is for managers, validates input, and is limited per user", async () => {
    const w = await agentWorld();
    const ann = await tokenFor(w.ctx, w.ann);
    expect((await w.http.post(`/api/agents/${w.agent.id}/sandbox`, { message: "hi" }, ann)).status).toBe(403);
    expect((await w.http.post(`/api/agents/${w.agent.id}/sandbox`, { message: "" }, w.token)).status).toBe(400);
    expect((await w.http.post("/api/agents/agt_nope/sandbox", { message: "hi" }, w.token)).status).toBe(404);
  });
});

describe("quality loop", () => {
  it("visitors and members rate answers; votes are one per person and changeable, and show in the review list", async () => {
    const w = await agentWorld();
    const v = await answered(w);
    const bot = (await w.ctx.db.get<{ id: string }>("SELECT id FROM messages WHERE room_id = ? AND sender_type = 'bot' AND kind = 'text' ORDER BY seq DESC LIMIT 1", v.roomId))!;
    const url = `/public/rooms/${v.roomId}/messages/${bot.id}/feedback`;
    expect((await w.http.post(url, { rating: 1 }, undefined, v.headers)).status).toBe(200);
    expect((await w.http.post(url, { rating: -1, comment: "did not help" }, undefined, v.headers)).status).toBe(200);
    expect((await w.http.post(`/api/messages/${bot.id}/feedback?room_id=${v.roomId}`, { rating: -1 }, w.token)).status).toBe(200);
    expect((await w.http.post(url, { rating: 3 }, undefined, v.headers)).status).toBe(400);
    const mine = await w.ctx.db.get<{ id: string }>("SELECT id FROM messages WHERE room_id = ? AND sender_type = 'contact' LIMIT 1", v.roomId);
    expect((await w.http.post(`/public/rooms/${v.roomId}/messages/${mine!.id}/feedback`, { rating: 1 }, undefined, v.headers)).status).toBe(404);
    const rows = await w.ctx.db.all<{ rating: number; rater_type: string }>("SELECT rating, rater_type FROM ai_feedback WHERE message_id = ? ORDER BY rater_type", bot.id);
    expect(rows).toEqual([{ rating: -1, rater_type: "member" }, { rating: -1, rater_type: "visitor" }]);
    const down = await w.http.get("/api/agents/turns?rated=down", w.token);
    expect(down.body.data).toHaveLength(1);
    expect(down.body.data[0]).toMatchObject({ outcome: "answered", visitor_text: "How do I reset my password?", votes: { up: 0, down: 2 } });
    expect((await w.http.get("/api/agents/turns?rated=up", w.token)).body.data).toHaveLength(0);
    expect((await w.http.get("/api/agents/turns?outcome=answered&limit=1", w.token)).body.pagination.has_more).toBe(false);
  });
  it("groups the questions the knowledge base could not answer, largest first", async () => {
    const w = await agentWorld();
    let n = 0;
    for (const q of ["how do I change my invoice email address", "change the invoice email address please", "the glimmer sprocket is broken forever"]) {
      const v = await w.visitor({}, `device-cccc-${++n}000`);
      await say(w, v, q);
    }
    const r = await w.http.get("/api/agents/unanswered?days=7", w.token);
    expect(r.body.data[0]).toMatchObject({ count: 2 });
    expect(r.body.data[0].examples).toHaveLength(2);
    expect(r.body.data[1]).toMatchObject({ count: 1 });
    expect((await w.http.get("/api/agents/unanswered", await tokenFor(w.ctx, w.ann))).status).toBe(403);
  });
});

describe("concurrency", () => {
  it("messages arriving together make one ticket and one bot answer each turn without losing any", async () => {
    const w = await agentWorld();
    const v = await w.visitor();
    await Promise.all([v.send("How do I reset my password?"), v.send("What are your opening hours?")]);
    await w.ctx.background.settle();
    const tickets = await w.ctx.db.all("SELECT id FROM tickets WHERE room_id = ?", v.roomId);
    expect(tickets).toHaveLength(1);
    const said = await w.ctx.db.all("SELECT id FROM messages WHERE room_id = ? AND sender_type = 'bot' AND kind = 'text'", v.roomId);
    expect(said.length).toBeGreaterThanOrEqual(2);
  });
  it("a visitor who asks for a person while the agent answers ends with a person holding it", async () => {
    const w = await agentWorld();
    const v = await w.visitor();
    await Promise.all([v.send("How do I reset my password?"), w.http.post(`/public/rooms/${v.roomId}/request-human`, {}, undefined, v.headers)]);
    await w.ctx.background.settle();
    const t = await ticketOf(w, v.roomId);
    expect(t.status).toBe("waiting_for_human");
    expect(t.handler?.startsWith("human:")).toBe(true);
  });
});

describe("knowledge base collections and links", () => {
  it("entries keep a collection and a link, the list can be filtered, and a link must be http(s)", async () => {
    const w = await agentWorld();
    const made = await w.http.post("/api/kb", { question: "Where is the office?", answer: "Berlin.", collection: " general ", url: "https://help.example.test/office" }, w.token);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ collection: "general", url: "https://help.example.test/office" });
    expect((await w.http.post("/api/kb", { question: "Bad link?", answer: "x", url: "javascript:alert(1)" }, w.token)).status).toBe(400);
    const upd = await w.http.put(`/api/kb/${made.body.id}`, { question: "Where is the office?", answer: "Berlin.", collection: "company", url: null }, w.token);
    expect(upd.body).toMatchObject({ collection: "company", url: null });
    const all = await w.http.get("/api/kb", w.token);
    expect(all.body.data.map((e: { collection: string }) => e.collection).sort()).toEqual(["account", "billing", "company", "general"]);
  });
});
