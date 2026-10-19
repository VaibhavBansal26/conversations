import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { addMemberRaw, client, fullApp, makeCtx, mkRoom, seedWorkspace, tokenFor } from "./helpers.js";
import { assignRoom } from "../src/services/rooms.js";

describe("workspace settings", () => {
  it("returns defaults, merges nested widget patches and validates values", async () => {
    const { http, token } = await fullApp();
    const w = await http.get("/api/workspace", token);
    expect(w.body.settings).toMatchObject({ default_region: "US", edit_window_seconds: 900, credits_enforced: false, ai_triage_enabled: false, ai_autoresponder_enabled: false, ai_redact_pii: false });
    expect(w.body.settings.widget).toMatchObject({ title: "Chat with us", primary_color: "#4f46e5", launcher_position: "right", chat_type: "live_chat", required_info: [] });
    const patched = await http.patch("/api/workspace", { name: "Renamed", settings: { default_region: "gb", widget: { title: "Hello", required_info: ["email"], office_hours: { enabled: true, timezone: "Europe/London", days: [{ day: 1, start: "08:30", end: "18:00" }] } } } }, token);
    expect(patched.body.name).toBe("Renamed");
    expect(patched.body.settings.default_region).toBe("GB");
    expect(patched.body.settings.widget).toMatchObject({ title: "Hello", primary_color: "#4f46e5", required_info: ["email"] });
    expect(patched.body.settings.widget.office_hours.days).toEqual([{ day: 1, start: "08:30", end: "18:00" }]);
    for (const bad of [{ widget: { primary_color: "red" } }, { widget: { office_hours: { days: [{ day: 9, start: "08:30", end: "18:00" }] } } }, { widget: { office_hours: { days: [{ day: 1, start: "8am", end: "18:00" }] } } }, { default_region: "USA" }, { edit_window_seconds: -1 }, { widget: { required_info: ["ssn"] } }, { ai_tone: "angry" }]) {
      expect((await http.patch("/api/workspace", { settings: bad }, token)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await http.get("/api/workspace", token)).body.settings.widget.title).toBe("Hello");
  });
  it("only managers change settings, and workspaces never see each other's", async () => {
    const { ctx, http, wsId } = await fullApp();
    const agent = await addMemberRaw(ctx, wsId, { name: "Ann" });
    const at = await tokenFor(ctx, agent);
    expect((await http.get("/api/workspace", at)).status).toBe(200);
    expect((await http.patch("/api/workspace", { name: "Hack" }, at)).status).toBe(403);
    const other = await seedWorkspace(ctx, "Other");
    expect((await http.get("/api/workspace", await tokenFor(ctx, other.owner))).body.name).toBe("Other");
  });
  it("tolerates corrupt stored settings by falling back to defaults", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    ctx.db.run("UPDATE workspaces SET settings = '{not json' WHERE id = ?", wsId);
    expect((await http.get("/api/workspace", token)).body.settings.default_region).toBe("US");
    ctx.db.run("UPDATE workspaces SET settings = ? WHERE id = ?", JSON.stringify({ widget: { primary_color: "bad" } }), wsId);
    expect((await http.get("/api/workspace", token)).body.settings.widget.primary_color).toBe("#4f46e5");
  });
});

describe("SMS numbers, senders and inbound addresses", () => {
  it("manages SMS numbers with a single default and frees locks on removal", async () => {
    const { ctx, http, token, wsId, owner } = await fullApp();
    const a = await http.post("/api/sms-numbers", { e164: "(415) 555-0100", label: "Main" }, token);
    expect(a.body).toMatchObject({ e164: "+14155550100", is_default: true });
    const b = await http.post("/api/sms-numbers", { e164: "+14155550101", is_default: true }, token);
    expect(b.body.is_default).toBe(true);
    expect((await http.get("/api/sms-numbers", token)).body.data.map((n: any) => [n.e164, n.is_default])).toEqual([["+14155550101", true], ["+14155550100", false]]);
    expect((await http.post("/api/sms-numbers", { e164: "+14155550100" }, token)).body.error.code).toBe("NUMBER_EXISTS");
    expect((await http.post("/api/sms-numbers", { e164: "12345" }, token)).body.error.code).toBe("INVALID_PHONE");
    // numbers are globally unique (inbound routing is by number)
    const other = await seedWorkspace(ctx, "Other");
    expect((await http.post("/api/sms-numbers", { e164: "+14155550100" }, await tokenFor(ctx, other.owner))).status).toBe(409);
    const { room } = mkRoom(ctx, wsId, { contact: { phone: "+14155552671" } });
    const { sendAgentMessage } = await import("../src/services/messages.js");
    await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "sms", content: "hi" });
    expect(ctx.db.all("SELECT 1 FROM message_locks")).toHaveLength(1);
    expect((await http.post(`/api/sms-numbers/${a.body.id}/default`, {}, token)).body.data[0].e164).toBe("+14155550100");
    // the message above went out from the then-default number b; removing b releases its lock
    expect((await http.del(`/api/sms-numbers/${b.body.id}`, token)).status).toBe(204);
    expect(ctx.db.all("SELECT 1 FROM message_locks")).toHaveLength(0);
    expect((await http.get("/api/sms-numbers", token)).body.data).toEqual([expect.objectContaining({ e164: "+14155550100", is_default: true })]);
    expect((await http.del(`/api/sms-numbers/${b.body.id}`, token)).status).toBe(404);
  });
  it("manages email senders (verification, default) and inbound addresses", async () => {
    const { http, token } = await fullApp();
    const s = await http.post("/api/email-senders", { address: "Support@Acme.test", display_name: "Acme" }, token);
    expect(s.body).toMatchObject({ address: "support@acme.test", verified: false, is_default: false });
    expect((await http.post("/api/email-senders", { address: "support@acme.test" }, token)).body.error.code).toBe("SENDER_EXISTS");
    expect((await http.patch(`/api/email-senders/${s.body.id}`, { verified: true, is_default: true }, token)).body).toMatchObject({ verified: true, is_default: true });
    expect((await http.post("/api/email-senders", { address: "nope" }, token)).status).toBe(400);
    expect((await http.del(`/api/email-senders/${s.body.id}`, token)).status).toBe(204);
    expect((await http.post("/api/inbound-addresses", { address: "Inbox@Parse.Acme.test" }, token)).body.address).toBe("inbox@parse.acme.test");
    expect((await http.post("/api/inbound-addresses", { address: "inbox@parse.acme.test" }, token)).body.error.code).toBe("ADDRESS_EXISTS");
    expect((await http.get("/api/inbound-addresses", token)).body.data).toHaveLength(1);
    expect((await http.del(`/api/inbound-addresses/${encodeURIComponent("inbox@parse.acme.test")}`, token)).status).toBe(204);
  });
  it("is manager-only", async () => {
    const { ctx, http, wsId } = await fullApp();
    const at = await tokenFor(ctx, await addMemberRaw(ctx, wsId, { name: "Ann" }));
    expect((await http.post("/api/sms-numbers", { e164: "+14155550100" }, at)).status).toBe(403);
    expect((await http.post("/api/email-senders", { address: "a@b.test" }, at)).status).toBe(403);
    expect((await http.post("/api/inbound-addresses", { address: "a@b.test" }, at)).status).toBe(403);
    expect((await http.post("/api/kb", { question: "How?", answer: "Like this" }, at)).status).toBe(403);
  });
});

describe("knowledge base", () => {
  it("CRUDs FAQ entries per workspace", async () => {
    const { ctx, http, token } = await fullApp();
    const k = await http.post("/api/kb", { question: "What are your hours?", answer: "9 to 5" }, token);
    expect(k.status).toBe(201);
    expect((await http.put(`/api/kb/${k.body.id}`, { question: "Opening hours?", answer: "9 to 6" }, token)).body.answer).toBe("9 to 6");
    expect((await http.get("/api/kb", token)).body.data).toHaveLength(1);
    expect((await http.post("/api/kb", { question: "x", answer: "y" }, token)).status).toBe(400);
    const other = await seedWorkspace(ctx, "Other");
    expect((await http.get("/api/kb", await tokenFor(ctx, other.owner))).body.data).toEqual([]);
    expect((await http.del(`/api/kb/${k.body.id}`, await tokenFor(ctx, other.owner))).status).toBe(404);
    expect((await http.del(`/api/kb/${k.body.id}`, token)).status).toBe(204);
  });
});

describe("members and presence endpoints", () => {
  it("adds seats (existing users reuse their login), updates preferences and DND, removes with reassignment", async () => {
    const { ctx, http, token, wsId, owner } = await fullApp();
    const added = await http.post("/api/members", { email: "new@example.test", name: "Newbie", password: "password123", role: "agent" }, token);
    expect(added.body).toMatchObject({ role: "agent", live_seat: true, inbox_visibility: "assigned_inbox", availability: "active" });
    expect((await http.post("/api/members", { email: "new@example.test", name: "Newbie", password: "password123" }, token)).body.error.code).toBe("ALREADY_MEMBER");
    expect((await http.post("/api/members", { email: "x@example.test", name: "X" }, token)).body.error.code).toBe("PASSWORD_REQUIRED");
    const login = await http.post("/api/auth/login", { email: "new@example.test", password: "password123" });
    expect(login.status).toBe(200);
    const me = await http.patch("/api/members/me", { availability: "away", dnd_until: "2099-01-01T00:00:00Z", notification_prefs: { assigned_to_your_team: false } }, login.body.token);
    expect(me.body).toMatchObject({ availability: "away", dnd_until: "2099-01-01T00:00:00Z" });
    expect(me.body.notification_prefs).toMatchObject({ assigned_to_your_team: false, assigned_to_you: true });
    expect((await http.patch("/api/members/me", { role: "owner" }, login.body.token)).status).toBe(200); // unknown/forbidden keys are stripped
    expect((await http.get("/api/members/me", login.body.token)).body.role).toBe("agent");
    const { room } = mkRoom(ctx, wsId);
    assignRoom(ctx, owner, room.id, { member_ids: [added.body.id] });
    expect((await http.del(`/api/members/${added.body.id}`, token)).status).toBe(204);
    expect(ctx.db.all("SELECT 1 FROM room_assignees WHERE room_id = ?", room.id)).toHaveLength(0);
    expect((await http.get("/api/members", token)).body.data).toHaveLength(1);
    // removed seats can be re-added and keep their user
    const back = await http.post("/api/members", { email: "new@example.test", name: "Newbie", role: "manager" }, token);
    expect(back).toMatchObject({ status: 201, body: { role: "manager", id: added.body.id } });
  });
  it("validates member patches", async () => {
    const { http, token, owner } = await fullApp();
    expect((await http.patch(`/api/members/${owner.memberId}`, { availability: "busy" }, token)).status).toBe(400);
    expect((await http.patch(`/api/members/${owner.memberId}`, { dnd_until: "tomorrow" }, token)).status).toBe(400);
    expect((await http.patch("/api/members/mem_nope", { availability: "away" }, token)).status).toBe(404);
  });
});

describe("static assets and widget delivery", () => {
  it("serves /widget.js and /widget-demo.html with the right types and CORS", async () => {
    const { app } = await fullApp();
    const js = await app.request("/widget.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("access-control-allow-origin")).toBe("*");
    expect(await js.text()).toContain("ConversationsWidget");
    const demo = await app.request("/widget-demo.html");
    expect(demo.headers.get("content-type")).toContain("text/html");
    expect(await demo.text()).toContain("widget.js");
  });
  it("serves a built web app with SPA fallback, without shadowing API or webhook paths", async () => {
    const dist = mkdtempSync(join(tmpdir(), "dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    const ctx = makeCtx({ WEB_DIST: dist });
    const app = createApp(ctx);
    const http = client(app);
    expect(await (await app.request("/inbox/room_1")).text()).toContain("<title>app</title>");
    const asset = await app.request("/assets/app.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect(await (await app.request("/%2e%2e/%2e%2e/etc/passwd")).text()).toBe("<!doctype html><title>app</title>"); // never reads outside dist
    expect((await http.get("/api/nope")).status).toBe(401); // the API is never shadowed by the SPA
    expect((await http.get("/webhooks/nope")).body.error.code).toBe("NOT_FOUND");
    expect((await http.get("/public/nope")).status).toBe(401);
  });
});
