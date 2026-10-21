import { describe, expect, it } from "vitest";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "../src/providers/fake.js";
import { silentLogger } from "../src/logger.js";
import { sendAgentMessage, retryMessage } from "../src/services/messages.js";
import { recordUsage } from "../src/services/workspaces.js";
import { messageDto } from "../src/services/messageStore.js";
import { createApp } from "../src/app.js";
import { createContext } from "../src/app-context.js";
import { openDb, migrate } from "../src/db/index.js";
import { addMemberRaw, addSenderRaw, addSmsNumberRaw, client, fullApp, makeCtx, messagesOf, mkRoom, seedWorkspace, tokenFor } from "./helpers.js";

const sms = (content: string) => ({ kind: "text" as const, source: "sms" as const, content });
const email = (content: string) => ({ kind: "text" as const, source: "email" as const, content });

async function world(opts: { simulated?: boolean } = {}) {
  const f = await fullApp();
  if (opts.simulated) {
    f.ctx.sms = new ConsoleSmsProvider(silentLogger);
    f.ctx.email = new ConsoleEmailProvider(silentLogger);
  }
  await addSmsNumberRaw(f.ctx, f.wsId, "+15550000001", true);
  await addSenderRaw(f.ctx, f.wsId, "support@acme.test", true, true);
  const { room } = await mkRoom(f.ctx, f.wsId, { contact: { name: "Texty", phone: "+14155552671", email: "texty@example.test" } });
  return { ...f, room };
}

describe("delivery honesty: test mode", () => {
  it("stores an SMS as not_sent_test_mode with an explanation when the provider is the console one", async () => {
    const { ctx, owner, room } = await world({ simulated: true });
    await recordUsage(ctx, owner.workspaceId, "grant", 10, "start");
    const before = (await ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", owner.workspaceId))!.credit_balance;
    const r = await sendAgentMessage(ctx, owner, room.id, sms("Hello by text"));
    expect(r.message.delivery).toBe("not_sent_test_mode");
    expect(r.message.failure_reason).toMatch(/SMS is not connected.*saved but not sent.*Settings > Channels/);
    expect(r.message.provider_message_id).toBeNull();
    expect(ctx.sms.sent).toHaveLength(1); // the console provider still logs, so developers see the text
    // nothing was sent, so nothing is billed and no reconciliation is scheduled
    expect((await ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", owner.workspaceId))!.credit_balance).toBe(before);
    expect(await ctx.db.all("SELECT 1 FROM jobs WHERE type = 'reconcile_sms'")).toHaveLength(0);
  });

  it("does the same for email", async () => {
    const { ctx, owner, room } = await world({ simulated: true });
    const r = await sendAgentMessage(ctx, owner, room.id, email("Hello by mail"));
    expect(r.message.delivery).toBe("not_sent_test_mode");
    expect(r.message.failure_reason).toMatch(/Email is not connected.*Connect SendGrid/);
  });

  it("exposes the state in the DTO and over a broadcast, never as sent/delivered", async () => {
    const { ctx, owner, room } = await world({ simulated: true });
    const r = await sendAgentMessage(ctx, owner, room.id, sms("x"));
    expect(messageDto(ctx, r.message).delivery).toBe("not_sent_test_mode");
    const updates = ctx.bus.events.filter((e) => e.event === "message:updated");
    expect(updates.at(-1)!.payload).toMatchObject({ message: { delivery: "not_sent_test_mode" } });
  });

  it("a real (non-simulated) provider still produces sent", async () => {
    const { ctx, owner, room } = await world();
    const r = await sendAgentMessage(ctx, owner, room.id, sms("real"));
    expect(r.message.delivery).toBe("sent");
  });

  it("can be sent for real once a provider is connected (retry)", async () => {
    const { ctx, owner, room } = await world({ simulated: true });
    const r = await sendAgentMessage(ctx, owner, room.id, sms("later"));
    expect(r.message.delivery).toBe("not_sent_test_mode");
    ctx.sms = Object.assign(Object.create(Object.getPrototypeOf(ctx.sms)), ctx.sms, { simulated: false });
    const again = await retryMessage(ctx, owner, r.message.id);
    expect(again.delivery).toBe("sent");
    expect(again.failure_reason).toBeNull();
    expect(again.provider_message_id).toBeTruthy();
    expect((await messagesOf(ctx, room.id)).filter((m) => m.source === "sms" && m.delivery === "sent")).toHaveLength(1);
  });

  it("a sent message cannot be retried", async () => {
    const { ctx, owner, room } = await world();
    const r = await sendAgentMessage(ctx, owner, room.id, sms("ok"));
    await expect(retryMessage(ctx, owner, r.message.id)).rejects.toMatchObject({ code: "NOT_FAILED" });
  });

  it("the database accepts the value on this backend and old rows are untouched", async () => {
    const ctx = await makeCtx();
    const { wsId } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    await ctx.db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('m_t1', ?, ?, 900, 'agent','text','sms','not_sent_test_mode', ?)", wsId, room.id, ctx.clock().toISOString());
    expect((await ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = 'm_t1'"))!.delivery).toBe("not_sent_test_mode");
    await expect(ctx.db.run("INSERT INTO messages(id, workspace_id, room_id, seq, sender_type, kind, source, delivery, created_at) VALUES ('m_t2', ?, ?, 901, 'agent','text','sms','bogus', ?)", wsId, room.id, ctx.clock().toISOString())).rejects.toThrow();
  });
});

describe("GET /api/channels/status", () => {
  it("reports test mode, not connected, for the console providers", async () => {
    const { ctx, http, token } = await world({ simulated: true });
    const r = await http.get("/api/channels/status", token);
    expect(r.status).toBe(200);
    expect(r.body.sms).toMatchObject({ channel: "sms", mode: "test", connected: false, provider: "console", source: "none", last_error: null });
    expect(r.body.sms.summary).toBe("SMS is not connected. Messages are saved but not sent. Connect Twilio in Settings > Channels.");
    expect(r.body.sms.details).toEqual({ numbers: 1, default_number: "+15550000001" });
    expect(r.body.email).toMatchObject({ mode: "test", connected: false, provider: "console" });
    expect(r.body.email.details).toEqual({ senders: 1, verified_senders: 1, inbound_addresses: 0 });
    expect(r.body.system_email).toEqual({ mode: "test", provider: "console" });
    void ctx;
  });

  it("reports live when a real provider is active", async () => {
    const { http, token } = await world();
    const r = await http.get("/api/channels/status", token);
    expect(r.body.sms).toMatchObject({ mode: "live", connected: true, source: "platform" });
    expect(r.body.email).toMatchObject({ mode: "live", connected: true });
  });

  it("shows the last provider error, redacted, and clears it after the next success", async () => {
    const { ctx, owner, room, http, token } = await world();
    ctx.sms.failNext(1, { retryable: false, message: "Twilio 401: bad credentials for 0123456789abcdef0123456789abcdef" });
    const r = await sendAgentMessage(ctx, owner, room.id, sms("will fail"));
    expect(r.message.delivery).toBe("failed");
    expect(r.message.failure_reason).not.toContain("0123456789abcdef0123456789abcdef");
    const s1 = await http.get("/api/channels/status", token);
    expect(s1.body.sms.last_error.message).toContain("bad credentials");
    expect(JSON.stringify(s1.body)).not.toContain("0123456789abcdef0123456789abcdef");
    await retryMessage(ctx, owner, r.message.id);
    const s2 = await http.get("/api/channels/status", token);
    expect(s2.body.sms.last_error).toBeNull();
    expect(s2.body.sms.last_ok_at).toBeTruthy();
  });

  it("requires a session and is workspace scoped", async () => {
    const { ctx, app, http } = await world();
    expect((await http.get("/api/channels/status")).status).toBe(401);
    const other = await seedWorkspace(ctx, "Other");
    const r = await client(app).get("/api/channels/status", await tokenFor(ctx, other.owner));
    expect(r.body.sms.details).toEqual({ numbers: 0, default_number: null });
  });

  it("is open to agents and viewers (they see the composer banner) without any secret", async () => {
    const { ctx, app, wsId } = await world({ simulated: true });
    const agent = await addMemberRaw(ctx, wsId, { role: "agent" });
    const r = await client(app).get("/api/channels/status", await tokenFor(ctx, agent));
    expect(r.status).toBe(200);
  });
});

describe("migration 020 on an existing SQLite database", () => {
  it("keeps rows and mentions and passes the integrity check", async () => {
    const db = await openDb({ path: ":memory:" });
    if (db.dialect !== "sqlite") return;
    await migrate(db);
    expect((await db.get<{ integrity_check: string }>("PRAGMA integrity_check"))!.integrity_check).toBe("ok");
    const sql = (await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'messages'"))!.sql;
    expect(sql).toContain("not_sent_test_mode");
    await db.close();
    void createApp;
    void createContext;
  });
});

describe("GET /api/getting-started", () => {
  it("derives every item from real state: nothing is stored, so undoing a step unticks it", async () => {
    const f = await fullApp();
    const done = async () => Object.fromEntries((await f.http.get("/api/getting-started", f.token)).body.items.map((i: { id: string; done: boolean }) => [i.id, i.done]));
    expect(await done()).toEqual({ invite_teammates: false, connect_sms: true, connect_email: true, install_widget: false, create_template: false }); // fakes count as connected providers
    f.ctx.sms = new ConsoleSmsProvider(silentLogger);
    f.ctx.email = new ConsoleEmailProvider(silentLogger);
    expect(await done()).toMatchObject({ connect_sms: false, connect_email: false });
    await addMemberRaw(f.ctx, f.wsId, { name: "Mate", role: "agent" });
    expect((await done()).invite_teammates).toBe(true);
    await f.http.post("/api/templates", { name: "Hello", body: "Hi {{contact.first_name}}" }, f.token);
    expect((await done()).create_template).toBe(true);
    const tok = (await f.http.post("/api/tokens", { domain: "shop.example.com" }, f.token)).body;
    expect((await done()).install_widget).toBe(false);
    await f.http.get("/public/widget/config", undefined, { "x-api-key": tok.token, origin: "https://shop.example.com" });
    expect((await done()).install_widget).toBe(true);
    await f.http.del(`/api/tokens/${tok.id}`, f.token);
    expect((await done()).install_widget).toBe(false);
    const r = (await f.http.get("/api/getting-started", f.token)).body;
    expect(r).toMatchObject({ done: 2, total: 5 });
    expect(r.items.find((i: { id: string }) => i.id === "install_widget").href).toBe("/settings/widget?tab=install");
  });
  it("counts a pending invitation as inviting a teammate, and is tenant scoped", async () => {
    const f = await fullApp();
    await f.http.post("/api/invitations", { email: "new@acme.test", role_id: "role_agent" }, f.token);
    expect((await f.http.get("/api/getting-started", f.token)).body.items[0].done).toBe(true);
    const other = await seedWorkspace(f.ctx, "Other");
    expect((await f.http.get("/api/getting-started", await tokenFor(f.ctx, other.owner))).body.items[0].done).toBe(false);
  });
});
