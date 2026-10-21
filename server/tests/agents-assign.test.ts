import { describe, expect, it } from "vitest";
import { createAgent, AgentBodySchema, updateAgent } from "../src/agents/config.js";
import { addMemberRaw, tokenFor } from "./helpers.js";
import { agentWorld, botSays, say, ticketOf } from "./agent-helpers.js";

/** POST /api/tickets/:id/assign-agent: a person gives a ticket to a chosen AI agent from the inbox's assign menu. */
describe("assign a ticket to an AI agent", () => {
  it("an unanswered ticket from before the agent was on: assigning answers the waiting message at once", async () => {
    const w = await agentWorld({ agent: { enabled: false } });
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    // only the workspace welcome line so far: nothing answered the question
    expect((await botSays(w, v.roomId)).filter((m) => !m.meta.welcome)).toHaveLength(0);
    await updateAgent(w.ctx, w.owner, w.agent.id, { enabled: true });
    const t = await ticketOf(w, v.roomId);
    const r = await w.http.post(`/api/tickets/${t.id}/assign-agent`, { agent_id: w.agent.id }, w.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "bot_handling", handler: `bot:${w.agent.id}` });
    await w.ctx.background.settle();
    const said = await botSays(w, v.roomId);
    expect(said.some((m) => /Reset password/.test(m.text))).toBe(true);
    const line = await w.ctx.db.get<{ content_text: string; meta: string }>("SELECT content_text, meta FROM messages WHERE room_id = ? AND kind = 'system' ORDER BY seq DESC LIMIT 1", v.roomId);
    expect(line!.content_text).toBe("Aria (AI assistant) is helping you now");
    expect(JSON.parse(line!.meta).sub_type).toBe("handed_back");
    const audit = await w.ctx.db.get<{ action: string }>("SELECT action FROM audit_log WHERE action = 'ticket.assign_agent'");
    expect(audit).toBeTruthy();
  });

  it("from a person to a chosen agent outside its departments: people are unassigned and that agent (not the first one) answers next", async () => {
    const w = await agentWorld();
    const vb = await createAgent(w.ctx, w.owner, AgentBodySchema.parse({ name: "vb", enabled: true, department_ids: [w.billing.id] }));
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    const t = await ticketOf(w, v.roomId);
    const ann = await tokenFor(w.ctx, w.ann);
    expect((await w.http.post(`/api/tickets/${t.id}/claim`, {}, ann)).status).toBe(200);
    const r = await w.http.post(`/api/tickets/${t.id}/assign-agent`, { agent_id: vb.id }, ann);
    expect(r.status).toBe(200);
    expect(r.body.handler).toBe(`bot:${vb.id}`);
    expect(await w.ctx.db.all("SELECT member_id FROM room_assignees WHERE room_id = ?", v.roomId)).toHaveLength(0);
    await say(w, v, "What are your opening hours?");
    const turn = await w.ctx.db.get<{ agent_id: string }>("SELECT agent_id FROM ai_turns WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", t.id);
    expect(turn!.agent_id).toBe(vb.id);
  });

  it("refuses an agent that is off, an ended ticket, someone else's ticket for the agent role, and other workspaces", async () => {
    const w = await agentWorld();
    const off = await createAgent(w.ctx, w.owner, AgentBodySchema.parse({ name: "Off", enabled: false }));
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    const t = await ticketOf(w, v.roomId);
    expect((await w.http.post(`/api/tickets/${t.id}/assign-agent`, { agent_id: off.id }, w.token)).body.error.code).toBe("AGENT_OFF");
    expect((await w.http.post(`/api/tickets/${t.id}/assign-agent`, { agent_id: "agt_nope" }, w.token)).status).toBe(404);
    const ann = await tokenFor(w.ctx, w.ann);
    await w.http.post(`/api/tickets/${t.id}/claim`, {}, ann);
    const other = await addMemberRaw(w.ctx, w.wsId, { name: "Cy Other" });
    const cy = await tokenFor(w.ctx, other);
    const denied = await w.http.post(`/api/tickets/${t.id}/assign-agent`, { agent_id: w.agent.id }, cy);
    expect([403, 404]).toContain(denied.status);
    const foreign = await agentWorld();
    expect((await foreign.http.post(`/api/tickets/${t.id}/assign-agent`, { agent_id: w.agent.id }, foreign.token)).status).toBe(404);
    await w.http.post(`/api/tickets/${t.id}/resolve`, {}, w.token);
    expect((await w.http.post(`/api/tickets/${t.id}/assign-agent`, { agent_id: w.agent.id }, w.token)).body.error.code).toBe("TICKET_ENDED");
  });
});

describe("the agents an assign menu can offer", () => {
  it("lists only agents that are on, with no settings, to someone who may change tickets but not manage agents", async () => {
    const w = await agentWorld();
    await createAgent(w.ctx, w.owner, AgentBodySchema.parse({ name: "Off", enabled: false }));
    const ann = await tokenFor(w.ctx, w.ann);
    const r = await w.http.get("/api/ai-agents/available", ann);
    expect(r.status).toBe(200);
    expect(r.body.data.map((a: { name: string }) => a.name)).toEqual(["Aria"]);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(["avatar_url", "department_ids", "disclosure_label", "id", "name"]);
    expect((await w.http.get("/api/agents", ann)).status).toBe(403);
  });
});
