import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentWorld, say } from "./agent-helpers.js";
import { setSettings } from "./helpers.js";
import { updateAgent } from "../src/agents/config.js";
import { executeTool } from "../src/agents/tools.js";
import { liveTicketOf } from "../src/services/tickets.js";
import { getRoomRow } from "../src/services/roomStore.js";
import { agentDto } from "../src/agents/config.js";

/** load a browser script that exports through `module.exports` when there is a module */
const load = (f: string): { css: string } => {
  const m: { exports: { css: string } } = { exports: { css: "" } };
  new Function("module", read(f))(m);
  return m.exports;
};
const read = (f: string) => readFileSync(new URL(`../public/chat/${f}`, import.meta.url), "utf8");

describe("the hosted chat's stylesheet carries the call screens' CSS (its CSP forbids inline styles, so the widget's injected copy cannot be used)", () => {
  it("every rule of calls.js and aicall.js is in chat.css", () => {
    const css = read("chat.css");
    for (const file of ["calls.js", "aicall.js"]) {
      const own = load(file).css;
      for (const rule of own.split("\n")) expect(css, `${file}: ${rule.slice(0, 60)}`).toContain(rule);
    }
  });
});

describe("the assistant offers a call with itself", () => {
  it("offer_call with 'ai' posts a card whose Yes tells the visitor's browser to start the call; 'team' keeps asking for a person", async () => {
    const w = await agentWorld();
    await setSettings(w.ctx, w.wsId, { routing: { require_online: false }, calls: { browser: { enabled: true, voice: true, video: true }, ai: { enabled: true } } });
    await w.ctx.cache.invalidate(`settings:${w.wsId}`);
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    const room = await getRoomRow(w.ctx, w.wsId, v.roomId);
    const ticket = (await liveTicketOf(w.ctx, v.roomId))!;
    const agent = agentDto(w.agent);
    const r = await executeTool(w.ctx, { room, ticket, agent, action: { tool: "offer_call", kind: "voice", with: "ai" } });
    expect(r.ok).toBe(true);
    const card = (await w.ctx.db.all<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE room_id = ? AND sender_type = 'bot' ORDER BY seq DESC", v.roomId)).map((m) => ({ id: m.id, ...JSON.parse(m.meta) })).find((m) => m.card?.purpose === "ai_call")!;
    expect(card.card.options.map((o: { id: string }) => o.id)).toEqual(["yes", "no"]);
    const no = await w.http.post(`/public/rooms/${v.roomId}/quick-reply`, { message_id: card.id, option_id: "no" }, undefined, v.headers);
    expect(no.body.start_ai_call).toBeUndefined();
    // a second card, answered yes
    await executeTool(w.ctx, { room, ticket, agent, action: { tool: "offer_call", kind: "video", with: "ai" } });
    const c2 = (await w.ctx.db.all<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE room_id = ? AND sender_type = 'bot' ORDER BY seq DESC", v.roomId)).map((m) => ({ id: m.id, ...JSON.parse(m.meta) })).find((m) => m.card?.purpose === "ai_call" && !m.card.answered)!;
    const yes = await w.http.post(`/public/rooms/${v.roomId}/quick-reply`, { message_id: c2.id, option_id: "yes" }, undefined, v.headers);
    expect(yes.status).toBe(200);
    expect(yes.body.start_ai_call).toBe("video");
    // refused when the agent may not take AI calls or the workspace has them off
    await updateAgent(w.ctx, w.owner, w.agent.id, { allowed_actions: ["offer_call"] });
    const agent2 = agentDto((await w.ctx.db.get<any>("SELECT * FROM ai_agents WHERE id = ?", w.agent.id))!);
    expect((await executeTool(w.ctx, { room, ticket, agent: agent2, action: { tool: "offer_call", kind: "voice", with: "ai" } })).ok).toBe(false);
    await setSettings(w.ctx, w.wsId, { calls: { browser: { enabled: true }, ai: { enabled: false } } });
    await w.ctx.cache.invalidate(`settings:${w.wsId}`);
    expect((await executeTool(w.ctx, { room, ticket, agent, action: { tool: "offer_call", kind: "voice", with: "ai" } })).ok).toBe(false);
    const team = await executeTool(w.ctx, { room, ticket, agent, action: { tool: "offer_call", kind: "voice", with: "team" } });
    expect(team.ok).toBe(true);
  });
});
