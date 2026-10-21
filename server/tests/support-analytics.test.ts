import AjvPkg from "ajv";
import formatsPkg from "ajv-formats";
import { describe, expect, it } from "vitest";
import { SCHEMAS } from "../src/analytics/schemas.js";
import { resolveTicket } from "../src/services/tickets.js";
import { agentSays, newId, tokenFor } from "./helpers.js";
import { agentWorld, say, ticketOf, type AgentWorld } from "./agent-helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: any = (AjvPkg as any).default ?? AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (formatsPkg as any).default ?? formatsPkg;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = (name: string, data: unknown) => {
  const v = ajv.compile(SCHEMAS[name]!);
  if (!v(data)) throw new Error(`${name} does not match its schema: ${JSON.stringify(v.errors)} for ${JSON.stringify(data).slice(0, 400)}`);
};

const q = "from=2026-03-01&to=2026-03-10";
const nd = (t: string) => t.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** three conversations: one the AI resolves, one a person resolves after waiting, one handed over for lack of an answer; plus three calls and thumbs */
async function seeded() {
  const w: AgentWorld = await agentWorld();
  const key = await w.http.post("/api/v1/api-keys", { name: "BI", scopes: ["analytics:read", "analytics:export"] }, w.token);
  const auth = { authorization: `Bearer ${key.body.key}` };
  const visitor = (n: number) => w.visitor({ name: `Person ${n}`, email: `person${n}@example.test` }, `device-sa-${n}000`);

  const a = await visitor(1);
  await say(w, a, "How do I reset my password?");
  await say(w, a, "thanks, that solved it");
  await w.http.post(`/public/rooms/${a.roomId}/ticket-csat`, { score: 5 }, undefined, a.headers);
  const botMsg = await w.ctx.db.get<{ id: string }>("SELECT id FROM messages WHERE room_id = ? AND sender_type = 'bot' AND meta LIKE '%\"ai\":true%' ORDER BY seq LIMIT 1", a.roomId);
  await w.http.post(`/public/rooms/${a.roomId}/messages/${botMsg!.id}/feedback`, { rating: 1 }, undefined, a.headers);
  await w.http.post(`/api/messages/${botMsg!.id}/feedback?room_id=${a.roomId}`, { rating: -1 }, w.token);

  const b = await visitor(2);
  await w.http.post(`/public/rooms/${b.roomId}/request-human`, {}, undefined, b.headers);
  const tb = await ticketOf(w, b.roomId);
  w.ctx.clockCtl.advance(300_000);
  await agentSays(w.ctx, w.ann, b.roomId, "Hi, Ann here");
  w.ctx.clockCtl.advance(600_000);
  await resolveTicket(w.ctx, w.ann, tb.id);
  await w.http.post(`/public/rooms/${b.roomId}/ticket-csat`, { score: 3 }, undefined, b.headers);

  const c = await visitor(3);
  await say(w, c, "my frobnicator makes a zorbling noise");
  await say(w, c, "it started after the glimmer update");

  const tc = await ticketOf(w, c.roomId);
  const ins = (state: string, transport: string, kind: string, dur: number | null, reason: string | null) =>
    w.ctx.db.run("INSERT INTO calls(id, workspace_id, room_id, ticket_id, contact_id, transport, kind, state, initiated_by, created_at, answered_at, ended_at, duration_s, end_reason, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)", newId("call"), w.wsId, b.roomId, tb.id, tb.contact_id, transport, kind, state, w.ann.memberId, w.ctx.clock().toISOString(), dur, reason, w.ctx.clock().toISOString());
  void tc;
  await ins("ended", "webrtc", "video", 120, "completed");
  await ins("missed", "webrtc", "voice", null, "timeout");
  await ins("ended", "phone", "voice", 60, "completed");
  return { ...w, auth, rooms: { a, b, c } };
}

describe("support analytics", () => {
  it("the overview counts tickets, containment, handoffs and reasons, waiting time, ratings by handler, departments, AI agents and calls", async () => {
    const w = await seeded();
    const r = await w.http.get(`/api/v1/analytics/support?${q}`, undefined, w.auth);
    expect(r.status).toBe(200);
    validate("support", r.body);
    expect(r.body.tickets).toMatchObject({ opened: 3, resolved: 2, containment_rate: 0.5 });
    expect(r.body.tickets.by_resolution).toMatchObject({ bot_resolved: 1, human_resolved: 1 });
    expect(r.body.tickets.handoff_rate).toBeCloseTo(2 / 3, 3);
    expect(r.body.tickets.handoff_reasons).toEqual(expect.arrayContaining([{ reason: "customer_requested_human", count: 1 }, { reason: "no_answer", count: 1 }]));
    expect(r.body.tickets.wait_for_human_p50_s).toBe(300);
    expect(r.body.tickets.csat).toEqual({ bot_avg: 5, bot_count: 1, human_avg: 3, human_count: 1 });
    expect(r.body.by_department.reduce((n: number, d: { tickets: number }) => n + d.tickets, 0)).toBe(3);
    expect(r.body.ai_agents).toHaveLength(1);
    expect(r.body.ai_agents[0]).toMatchObject({ helpful: 1, not_helpful: 1 });
    expect(r.body.ai_agents[0].turns).toBeGreaterThanOrEqual(3);
    expect(r.body.calls).toMatchObject({ total: 3, answered: 2, missed: 1, total_duration_s: 180, avg_duration_s: 90, by_transport: { webrtc: 2, phone: 1 }, by_kind: { voice: 2, video: 1 } });
    // an agent is a keyed hash, never an id
    expect(JSON.stringify(r.body)).not.toContain(w.agent.id);
  });

  it("an empty period is valid: nulls, zeros, empty lists", async () => {
    const w = await seeded();
    const r = await w.http.get("/api/v1/analytics/support?from=2025-01-01&to=2025-01-10", undefined, w.auth);
    validate("support", r.body);
    expect(r.body.tickets).toMatchObject({ opened: 0, containment_rate: null, handoff_rate: null, wait_for_human_p50_s: null, handoff_reasons: [] });
    expect(r.body.calls).toMatchObject({ total: 0, avg_duration_s: null });
  });

  it("exports tickets: schema valid, ordered, resumable, keyed people, no free text", async () => {
    const w = await seeded();
    const first = await w.app.request(`/api/v1/analytics/export/tickets?${q}&limit=2`, { headers: w.auth });
    expect(first.headers.get("content-type")).toContain("application/x-ndjson");
    const next = first.headers.get("x-next-cursor");
    expect(next).toBeTruthy();
    const l1 = nd(await first.text());
    const second = await w.app.request(`/api/v1/analytics/export/tickets?${q}&limit=2&cursor=${encodeURIComponent(next!)}`, { headers: w.auth });
    expect(second.headers.get("x-next-cursor")).toBeNull();
    const all = [...l1, ...nd(await second.text())];
    expect(all).toHaveLength(3);
    for (const l of all) validate("export-tickets-line", l);
    expect(all.map((l) => l.created_at)).toEqual([...all.map((l) => l.created_at)].sort());
    expect(new Set(all.map((l) => l.number)).size).toBe(3);
    const byRes = Object.fromEntries(all.map((l) => [l.resolution ?? "none", l]));
    expect(byRes.bot_resolved).toMatchObject({ handler_type: "bot", csat: 5, calls: 0 });
    expect(byRes.bot_resolved.bot_turns).toBeGreaterThanOrEqual(2);
    expect(byRes.human_resolved).toMatchObject({ handler_type: "human", wait_for_human_s: 300, csat: 3, calls: 3, handoff_reason: "customer_requested_human" });
    const blob = JSON.stringify(all);
    expect(blob).not.toMatch(/person\d@example|Person \d|reset my password|frobnicator|Ann Support/);
    expect(all.every((l) => /^[0-9a-f]{64}$/.test(l.contact_key))).toBe(true);
    expect((await w.app.request(`/api/v1/analytics/export/tickets?${q}&cursor=garbage`, { headers: w.auth })).status).toBe(400);
  });

  it("exports calls: schema valid, no numbers or names", async () => {
    const w = await seeded();
    const r = await w.app.request(`/api/v1/analytics/export/calls?${q}`, { headers: w.auth });
    const lines = nd(await r.text());
    expect(lines).toHaveLength(3);
    for (const l of lines) validate("export-calls-line", l);
    expect(lines.map((l) => l.transport).sort()).toEqual(["phone", "webrtc", "webrtc"]);
    expect(JSON.stringify(lines)).not.toMatch(/\+1415|Ann/);
    expect(new Set(lines.map((l) => l.agent_key)).size).toBe(1);
  });

  it("messages-meta gains ticket_id additively and still validates", async () => {
    const w = await seeded();
    const lines = nd(await (await w.app.request(`/api/v1/analytics/export/messages-meta?${q}`, { headers: w.auth })).text());
    for (const l of lines) validate("export-messages-meta-line", l);
    expect(lines.some((l) => typeof l.ticket_id === "string")).toBe(true);
  });

  it("scopes, workspace isolation and the dashboard route", async () => {
    const w = await seeded();
    const readOnly = await w.http.post("/api/v1/api-keys", { name: "ro", scopes: ["analytics:read"] }, await tokenFor(w.ctx, w.owner));
    const ro = { authorization: `Bearer ${readOnly.body.key}` };
    expect((await w.app.request(`/api/v1/analytics/export/tickets?${q}`, { headers: ro })).status).toBe(403);
    expect((await w.app.request(`/api/v1/analytics/export/calls?${q}`, { headers: ro })).status).toBe(403);
    expect((await w.app.request(`/api/v1/analytics/support?${q}`, { headers: ro })).status).toBe(200);
    // another workspace's key sees none of this
    const other = await agentWorld();
    const ok = await other.http.post("/api/v1/api-keys", { name: "o", scopes: ["analytics:read", "analytics:export"] }, other.token);
    const r = await other.app.request(`/api/v1/analytics/support?${q}`, { headers: { authorization: `Bearer ${ok.body.key}` } });
    expect((await r.json()).tickets.opened).toBe(0);
    expect(nd(await (await other.app.request(`/api/v1/analytics/export/tickets?${q}`, { headers: { authorization: `Bearer ${ok.body.key}` } })).text())).toHaveLength(0);
    // the in-app route needs analytics:read; an agent role does not have it
    // (the test clock moved on: fresh tokens)
    expect((await w.http.get(`/api/analytics/support?${q}`, await tokenFor(w.ctx, w.owner))).status).toBe(200);
    expect((await w.http.get(`/api/analytics/support?${q}`, await tokenFor(w.ctx, w.ann))).status).toBe(403);
    expect(Object.keys((await w.http.get("/api/v1/analytics/schema", undefined, w.auth)).body.schemas)).toEqual(expect.arrayContaining(["support", "export-tickets-line", "export-calls-line"]));
  });
});
