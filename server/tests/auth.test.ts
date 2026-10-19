import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { addMemberRaw, client, fullApp, makeCtx, seedWorkspace, tokenFor } from "./helpers.js";
import { signAccessToken, verifyAccessToken } from "../src/services/auth.js";

describe("auth", () => {
  it("registers a workspace with an owner and returns a usable token", async () => {
    const { http } = await fullApp();
    const r = await http.post("/api/auth/register", { email: "Ann@Example.test", password: "password123", name: "Ann", workspace_name: "Org" });
    expect(r.status).toBe(201);
    expect(r.body.member.role).toBe("owner");
    expect(r.body.user.email).toBe("ann@example.test");
    const me = await http.get("/api/auth/me", r.body.token);
    expect(me.status).toBe(200);
    expect(me.body.workspace.name).toBe("Org");
  });

  it("rejects duplicate email, weak password and malformed bodies with the error envelope", async () => {
    const { http } = await fullApp();
    const body = { email: "a@example.test", password: "password123", name: "A", workspace_name: "O" };
    expect((await http.post("/api/auth/register", body)).status).toBe(201);
    const dup = await http.post("/api/auth/register", body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
    const weak = await http.post("/api/auth/register", { ...body, email: "b@example.test", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");
    const bad = await http.call("POST", "/api/auth/register", { raw: "{not json", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_JSON");
  });

  it("logs in with correct credentials only, without revealing which part was wrong", async () => {
    const { http } = await fullApp();
    await http.post("/api/auth/register", { email: "a@example.test", password: "password123", name: "A", workspace_name: "O" });
    const ok = await http.post("/api/auth/login", { email: "A@EXAMPLE.test", password: "password123" });
    expect(ok.status).toBe(200);
    const wrongPw = await http.post("/api/auth/login", { email: "a@example.test", password: "nope-nope" });
    const noUser = await http.post("/api/auth/login", { email: "ghost@example.test", password: "password123" });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body).toEqual(noUser.body);
  });

  it("rate limits login attempts per client", async () => {
    const { http } = await fullApp();
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await http.post("/api/auth/login", { email: "x@example.test", password: "wrong-wrong" })).status;
    expect(last).toBe(429);
  });

  it("requires a valid bearer token and rejects tampered, expired and foreign tokens", async () => {
    const { ctx, http, owner } = await fullApp();
    expect((await http.get("/api/members")).status).toBe(401);
    expect((await http.get("/api/members", "garbage")).status).toBe(401);
    const good = await tokenFor(ctx, owner);
    expect((await http.get("/api/members", good + "x")).status).toBe(401);
    ctx.clockCtl.advance((ctx.config.ACCESS_TOKEN_TTL_SECONDS + 5) * 1000);
    expect((await http.get("/api/members", good)).status).toBe(401);
    const other = makeCtx({ JWT_SECRET: "another-secret-another-secret-123" });
    await expect(verifyAccessToken(other, await signAccessToken(ctx, owner))).rejects.toThrow();
  });

  it("reads role from the database, not the token: a removed seat is locked out immediately", async () => {
    const { ctx, http, wsId, token } = await fullApp();
    const agent = await addMemberRaw(ctx, wsId, { name: "Gone" });
    const agentToken = await tokenFor(ctx, agent);
    expect((await http.get("/api/members", agentToken)).status).toBe(200);
    expect((await http.del(`/api/members/${agent.memberId}`, token)).status).toBe(204);
    expect((await http.get("/api/members", agentToken)).status).toBe(401);
  });

  it("returns 404 (not 403) for resources of another workspace", async () => {
    const { ctx, http, token } = await fullApp();
    const other = await seedWorkspace(ctx, "Other");
    const otherToken = await tokenFor(ctx, other.owner);
    const c = await http.post("/api/contacts", { name: "Mine", email: "mine@example.test" }, token);
    const inbox = await http.post("/api/inboxes", { name: "Support" }, token);
    const tpl = await http.post("/api/templates", { name: "Hello", body: "Hi" }, token);
    const room = await http.post("/api/rooms", { contact_id: c.body.id }, token);
    for (const path of [`/api/contacts/${c.body.id}`, `/api/inboxes/${inbox.body.id}`, `/api/rooms/${room.body.room.id}`, `/api/rooms/${room.body.room.id}/messages`]) {
      const res = await http.get(path, otherToken);
      expect(res.status, path).toBe(404);
    }
    expect((await http.patch(`/api/contacts/${c.body.id}`, { name: "x" }, otherToken)).status).toBe(404);
    expect((await http.del(`/api/templates/${tpl.body.id}`, otherToken)).status).toBe(404);
    expect((await http.post(`/api/rooms/${room.body.room.id}/messages`, { content: "hi" }, otherToken)).status).toBe(404);
    expect((await http.get("/api/contacts", otherToken)).body.data).toEqual([]);
  });

  it("enforces roles on member management", async () => {
    const { ctx, http, wsId, token } = await fullApp();
    const manager = await addMemberRaw(ctx, wsId, { name: "Mia", role: "manager" });
    const agent = await addMemberRaw(ctx, wsId, { name: "Abe" });
    const mt = await tokenFor(ctx, manager);
    const at = await tokenFor(ctx, agent);
    expect((await http.post("/api/members", { email: "n@example.test", name: "N", password: "password123", role: "agent" }, at)).status).toBe(403);
    expect((await http.post("/api/members", { email: "n@example.test", name: "N", password: "password123", role: "manager" }, mt)).status).toBe(403);
    expect((await http.post("/api/members", { email: "n@example.test", name: "N", password: "password123", role: "agent" }, mt)).status).toBe(201);
    expect((await http.patch(`/api/members/${agent.memberId}`, { role: "manager" }, mt)).status).toBe(403);
    expect((await http.patch(`/api/members/${agent.memberId}`, { role: "manager" }, token)).status).toBe(200);
    // an agent may change their own availability but not their role
    expect((await http.patch("/api/members/me", { availability: "away" }, at)).body.availability).toBe("away");
    expect((await http.patch(`/api/members/${agent.memberId}`, { role: "owner" }, at)).status).toBe(403);
  });

  it("never lets the last owner be demoted or removed", async () => {
    const { http, owner, token } = await fullApp();
    expect((await http.patch(`/api/members/${owner.memberId}`, { role: "agent" }, token)).body.error.code).toBe("LAST_OWNER");
    expect((await http.del(`/api/members/${owner.memberId}`, token)).body.error.code).toBe("LAST_OWNER");
  });

  it("supports members who belong to several workspaces via workspace_id at login", async () => {
    const { ctx, http } = await fullApp();
    const a = await http.post("/api/auth/register", { email: "multi@example.test", password: "password123", name: "M", workspace_name: "One" });
    const second = await seedWorkspace(ctx, "Two");
    await http.post("/api/members", { email: "multi@example.test", name: "M", role: "agent" }, await tokenFor(ctx, second.owner));
    const login = await http.post("/api/auth/login", { email: "multi@example.test", password: "password123", workspace_id: second.wsId });
    expect(login.body.workspace.id).toBe(second.wsId);
    expect(login.body.workspaces).toHaveLength(2);
    expect(a.body.workspace.id).not.toBe(second.wsId);
    expect((await http.post("/api/auth/login", { email: "multi@example.test", password: "password123", workspace_id: "ws_000000000000000000000000" })).status).toBe(401);
  });
});

describe("config", () => {
  it("generates a dev secret with a warning but requires one in production", () => {
    const warnings: string[] = [];
    const dev = loadConfig({ NODE_ENV: "development" }, (m) => warnings.push(m));
    expect(dev.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(warnings[0]).toMatch(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
  });
  it("validates env and provider prerequisites", () => {
    expect(() => loadConfig({ PORT: "abc" }, () => {})).toThrow(/Invalid environment/);
    expect(() => loadConfig({ SMS_PROVIDER: "twilio" }, () => {})).toThrow(/TWILIO/);
    expect(() => loadConfig({ EMAIL_PROVIDER: "sendgrid" }, () => {})).toThrow(/SENDGRID/);
    expect(() => loadConfig({ SOCKET_ADAPTER: "redis" }, () => {})).toThrow(/REDIS_URL/);
    expect(loadConfig({ CORS_ORIGINS: "http://a.test, http://b.test" }, () => {}).corsOrigins).toEqual(["http://a.test", "http://b.test"]);
  });
});

describe("http hardening", () => {
  it("sends security headers, health endpoints, JSON 404 and body limits", async () => {
    const ctx = makeCtx({ BODY_LIMIT_BYTES: "200" });
    const app = createApp(ctx);
    const http = client(app);
    const health = await app.request("/healthz");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await http.get("/readyz")).body.status).toBe("ready");
    expect((await http.get("/nope")).body.error.code).toBe("NOT_FOUND");
    const big = await http.post("/api/auth/register", { email: "a@example.test", password: "x".repeat(500), name: "A", workspace_name: "O" });
    expect(big.status).toBe(413);
  });
  it("applies the CORS allow-list to the team API", async () => {
    const ctx = makeCtx({ CORS_ORIGINS: "http://allowed.test" });
    const app = createApp(ctx);
    const ok = await app.request("/api/auth/login", { method: "OPTIONS", headers: { origin: "http://allowed.test", "access-control-request-method": "POST" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
    const no = await app.request("/api/auth/login", { method: "OPTIONS", headers: { origin: "http://evil.test", "access-control-request-method": "POST" } });
    expect(no.headers.get("access-control-allow-origin")).not.toBe("http://evil.test");
  });
});
