import { describe, expect, it } from "vitest";
import { fullApp } from "./helpers.js";

/** DEFAULT_AI_AGENTS: a workspace created by registering starts with Aria and vb switched on, so the first visitor message is answered. */
async function registered(env: Record<string, string>) {
  const f = await fullApp(env);
  const reg = await f.http.post("/api/auth/register", { email: "new.owner@example.test", password: "correct-horse-1", name: "New Owner", workspace_name: "New Co" });
  expect(reg.status).toBe(201);
  return { ...f, ownerToken: reg.body.token as string };
}

describe("default AI agents of a new workspace", () => {
  it("registering creates Aria then vb, both on, with their bundled pictures and the AI label, and the first 'hello' is answered by Aria", async () => {
    const w = await registered({ DEFAULT_AI_AGENTS: "true" });
    const agents = await w.http.get("/api/agents", w.ownerToken);
    expect(agents.body.data.map((a: { name: string; enabled: boolean }) => [a.name, a.enabled])).toEqual([
      ["Aria", true],
      ["vb", true],
    ]);
    expect(agents.body.data[0]).toMatchObject({ avatar_url: "/avatars/aria.webp", disclosure_label: "AI assistant", autonomy: "auto_answer", department_ids: [] });
    expect(agents.body.data[1]).toMatchObject({ avatar_url: "/avatars/vb.webp", disclosure_label: "AI assistant" });
    // a visitor on that workspace's widget says hello
    const tok = await w.http.post("/api/tokens", { domain: "shop.example.com" }, w.ownerToken);
    const h = { "x-api-key": tok.body.token as string, origin: "https://shop.example.com", "x-device-id": "device-aaaa-0001" };
    const s = await w.http.post("/public/sessions", {}, undefined, h);
    const vh = { "x-support-session": s.body.session_token as string, "x-device-id": "device-aaaa-0001", origin: "https://shop.example.com" };
    const room = await w.http.post("/public/rooms", {}, undefined, vh);
    expect((await w.http.post(`/public/rooms/${room.body.room.id}/messages`, { content: "hello" }, undefined, vh)).status).toBeLessThan(300);
    await w.ctx.background.settle();
    const turn = await w.ctx.db.get<{ agent_id: string }>("SELECT agent_id FROM ai_turns ORDER BY created_at, id LIMIT 1");
    expect(turn!.agent_id).toBe(agents.body.data[0].id);
    const bot = await w.ctx.db.all<{ meta: string }>("SELECT meta FROM messages WHERE room_id = ? AND sender_type = 'bot'", room.body.room.id);
    expect(bot.some((m) => JSON.parse(m.meta).ai)).toBe(true);
  });

  it("is off with DEFAULT_AI_AGENTS=false: a new workspace has no agents", async () => {
    const w = await registered({ DEFAULT_AI_AGENTS: "false" });
    expect((await w.http.get("/api/agents", w.ownerToken)).body.data).toEqual([]);
  });
});
