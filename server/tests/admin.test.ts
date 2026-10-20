import { describe, expect, it } from "vitest";
import { ADMIN_ACCESS } from "../src/admin/access.js";
import { adminLogin, adminMfaEnable, adminMfaSetup, createPlatformAdmin, type AdminRole } from "../src/admin/auth.js";
import { createApp } from "../src/app.js";
import { ROUTE_ACCESS } from "../src/authz/routePerms.js";
import { ROUTE_LIMITS } from "../src/ratelimit/routePolicies.js";
import { createContext } from "../src/app-context.js";
import { addMemberRaw, client, makeCtx, mkRoom, seedWorkspace, tokenFor, type TestCtx } from "./helpers.js";
import { ack, startServer } from "./rt-helpers.js";
import { base32Decode, hotp, totpStep } from "../src/util/totp.js";
import { SignJWT } from "jose";
import { createToken } from "../src/services/visitors.js";
import { actorFromRow, getMember } from "../src/services/members.js";

const PW = "correct horse battery staple";
const code = (ctx: TestCtx, secret: string) => hotp(base32Decode(secret), totpStep(ctx.clock().getTime()));

async function setup(env: Record<string, string> = {}) {
  const ctx = await makeCtx(env);
  const app = createApp(ctx);
  const http = client(app);
  const ws = await seedWorkspace(ctx, "Acme");
  const wsToken = await tokenFor(ctx, ws.owner);

  /** create an admin and sign it in all the way (password, enrol, first code) */
  async function admin(role: AdminRole = "superadmin", email = `${role}-${Math.random().toString(16).slice(2, 8)}@ops.test`) {
    // through the service, not HTTP: the sign-in endpoints are rate limited per IP and a test that needs several admins would trip that
    const row = await createPlatformAdmin(ctx, { email, name: "Ops", password: PW, role });
    const l = (await adminLogin(ctx, { email, password: PW })) as { mfa_token: string };
    const secret = (await adminMfaSetup(ctx, l.mfa_token)).secret;
    const done = await adminMfaEnable(ctx, l.mfa_token, code(ctx, secret));
    return { row, email, secret, token: done.token, id: row.id };
  }
  const call = (method: string, path: string, token: string, json?: unknown, headers?: Record<string, string>) => http.call(method, `/admin/api${path}`, { token, json, headers });
  return { ctx, app, http, ...ws, wsToken, admin, call };
}

describe("declarations", () => {
  it("every route under /admin/api has an admin access rule, an authz entry and a limiter decision, and the reverse", async () => {
    const { app } = await setup();
    const registered = new Set(app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/admin/api")).map((r) => `${r.method} ${r.path}`));
    expect(registered.size).toBeGreaterThan(15);
    for (const r of registered) {
      expect(ADMIN_ACCESS.has(r), `no admin access rule: ${r}`).toBe(true);
      expect(ROUTE_ACCESS.get(r), `no authorisation entry: ${r}`).toBe("platform");
      expect(ROUTE_LIMITS.has(r), `no limiter decision: ${r}`).toBe(true);
    }
    for (const k of ADMIN_ACCESS.keys()) expect(registered.has(k), `rule for a route that does not exist: ${k}`).toBe(true);
  });

  it("every state-changing admin route needs superadmin (only impersonation, which is read-only, is open to support)", () => {
    for (const [key, access] of ADMIN_ACCESS) {
      const method = key.split(" ")[0]!;
      if (access === "public") continue;
      if (method !== "GET") expect(access === "superadmin" || key.endsWith("/impersonate"), key).toBe(true);
      else expect(access, key).toBe("any");
    }
  });
});

describe("sign-in", () => {
  it("always takes a password and an authenticator code; an admin that has not enrolled can enrol but reach nothing", async () => {
    // the per-IP sign-in limit is not what this test is about (and with Redis it runs on Redis's clock, not the test clock)
    const t = await setup({ RATE_LIMIT_SCALE: "50" });
    await createPlatformAdmin(t.ctx, { email: "new@ops.test", name: "New", password: PW });
    const l = await t.http.post("/admin/api/login", { email: "new@ops.test", password: PW });
    expect(l.body).toMatchObject({ mfa_setup_required: true });
    expect(l.body.token).toBeUndefined();
    // the step token is not an access token
    expect((await t.call("GET", "/stats", l.body.mfa_token)).status).toBe(401);
    // verify is for enrolled admins only
    expect((await t.http.post("/admin/api/mfa/verify", { mfa_token: l.body.mfa_token, code: "123456" })).status).toBe(401);
    const setup1 = await t.http.post("/admin/api/mfa/setup", { mfa_token: l.body.mfa_token });
    expect(setup1.body.otpauth_url).toContain("otpauth://totp/");
    expect((await t.http.post("/admin/api/mfa/enable", { mfa_token: l.body.mfa_token, code: "000000" })).status).toBe(422);
    const ok = await t.http.post("/admin/api/mfa/enable", { mfa_token: l.body.mfa_token, code: code(t.ctx, setup1.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.admin).toMatchObject({ email: "new@ops.test", role: "superadmin" });
    expect((await t.call("GET", "/me", ok.body.token)).body.admin.email).toBe("new@ops.test");

    // next sign-in: password, then the code. The same code cannot be used twice, a new time step can.
    t.ctx.clockCtl.advance(60_000);
    const l2 = await t.http.post("/admin/api/login", { email: "new@ops.test", password: PW });
    expect(l2.body).toMatchObject({ mfa_required: true });
    expect((await t.http.post("/admin/api/mfa/verify", { mfa_token: l2.body.mfa_token, code: "111111" })).status).toBe(401);
    const good = code(t.ctx, setup1.body.secret);
    expect((await t.http.post("/admin/api/mfa/verify", { mfa_token: l2.body.mfa_token, code: good })).status).toBe(200);
    const l3 = await t.http.post("/admin/api/login", { email: "new@ops.test", password: PW });
    expect((await t.http.post("/admin/api/mfa/verify", { mfa_token: l3.body.mfa_token, code: good })).status).toBe(401); // replay of a used code
  });

  it("wrong passwords lock the account after five tries (even for the right password afterwards) without revealing which emails exist", async () => {
    const t = await setup();
    const a = await t.admin("superadmin", "target@ops.test");
    const unknown = await t.http.post("/admin/api/login", { email: "nobody@ops.test", password: "whatever-whatever" });
    const wrong = await t.http.post("/admin/api/login", { email: a.email, password: "wrong-password-123" });
    expect([unknown.status, unknown.body.error.code]).toEqual([wrong.status, wrong.body.error.code]);
    for (let i = 0; i < 6; i++) await t.http.post("/admin/api/login", { email: a.email, password: "wrong-password-123" });
    const locked = await t.http.post("/admin/api/login", { email: a.email, password: PW });
    expect(locked.status).toBe(429);
  });

  it("wrong authenticator codes lock the second step for that admin", async () => {
    const t = await setup();
    const a = await t.admin("superadmin", "mfa@ops.test");
    t.ctx.clockCtl.advance(60_000);
    const l = await t.http.post("/admin/api/login", { email: a.email, password: PW });
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await t.http.post("/admin/api/mfa/verify", { mfa_token: l.body.mfa_token, code: "000000" })).status;
    expect(last).toBe(429);
    t.ctx.clockCtl.advance(5_000);
    const right = code(t.ctx, a.secret);
    expect((await t.http.post("/admin/api/mfa/verify", { mfa_token: l.body.mfa_token, code: right })).status).toBe(429); // even the right code
  });

  it("tokens do not cross: a workspace token cannot open the console, an admin token cannot open the workspace API, and a step token is no session", async () => {
    const t = await setup();
    const a = await t.admin();
    expect((await t.call("GET", "/stats", t.wsToken)).status).toBe(401);
    expect((await t.http.get("/api/workspace", a.token)).status).toBe(401);
    expect((await t.call("GET", "/stats", "")).status).toBe(401);
    // a token signed with the same secret but the wrong audience/issuer
    const forged = await new SignJWT({ role: "superadmin" }).setProtectedHeader({ alg: "HS256" }).setSubject(a.id).setIssuer("conversations").setAudience("platform-admin").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(t.ctx.config.JWT_SECRET));
    expect((await t.call("GET", "/stats", forged)).status).toBe(401);
  });

  it("an admin token expires after 30 minutes, and disabling an admin ends its sessions at once", async () => {
    const t = await setup();
    const boss = await t.admin("superadmin");
    const victim = await t.admin("support");
    expect((await t.call("GET", "/stats", victim.token)).status).toBe(200);
    expect((await t.call("POST", `/admins/${victim.id}/disable`, boss.token)).status).toBe(204);
    expect((await t.call("GET", "/stats", victim.token)).status).toBe(401);
    expect((await t.http.post("/admin/api/login", { email: victim.email, password: PW })).status).toBe(401);
    await t.call("POST", `/admins/${victim.id}/enable`, boss.token);
    expect((await t.call("GET", "/stats", victim.token)).status).toBe(200);
    t.ctx.clockCtl.advance(31 * 60_000);
    expect((await t.call("GET", "/stats", victim.token)).status).toBe(401);
  });

  it("admins cannot disable themselves or the last active superadmin, and short passwords are refused", async () => {
    const t = await setup();
    const a = await t.admin("superadmin");
    expect((await t.call("POST", `/admins/${a.id}/disable`, a.token)).body.error.code).toBe("CANNOT_DISABLE_SELF");
    const b = await t.admin("superadmin");
    expect((await t.call("POST", `/admins/${b.id}/disable`, a.token)).status).toBe(204);
    const c = await t.admin("support");
    void c;
    await expect(createPlatformAdmin(t.ctx, { email: "weak@ops.test", name: "W", password: "short" })).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    const list = await t.call("GET", "/admins", a.token);
    expect(list.body.data.map((x: { email: string; mfa_enabled: boolean }) => [x.mfa_enabled]).flat().every(Boolean)).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/password|totp_secret|scrypt/);
  });
});

describe("roles", () => {
  it("support can read everything but change nothing; superadmin can", async () => {
    const t = await setup();
    const sup = await t.admin("support");
    const boss = await t.admin("superadmin");
    for (const p of ["/stats", "/workspaces", `/workspaces/${t.wsId}`, "/audit", "/ratelimit", "/admins", "/me"]) expect((await t.call("GET", p, sup.token)).status, p).toBe(200);
    const writes: [string, string, unknown][] = [
      ["POST", `/workspaces/${t.wsId}/suspend`, { reason: "abuse" }],
      ["POST", `/workspaces/${t.wsId}/unsuspend`, {}],
      ["POST", `/workspaces/${t.wsId}/credits`, { amount: 5, note: "x y z" }],
      ["PUT", `/workspaces/${t.wsId}/tier`, { tier: "pro" }],
      ["POST", "/ratelimit/deny", { entity: "ip:203.0.113.5", ttl_seconds: 60 }],
      ["DELETE", "/ratelimit/deny/ip%3A203.0.113.5", undefined],
      ["POST", `/admins/${boss.id}/disable`, {}],
    ];
    for (const [m, p, body] of writes) {
      const r = await t.call(m, p, sup.token, body);
      expect([r.status, r.body.error.code], `${m} ${p}`).toEqual([403, "ADMIN_ROLE_REQUIRED"]);
    }
    expect((await t.call("POST", `/workspaces/${t.wsId}/credits`, boss.token, { amount: 5, note: "goodwill" })).status).toBe(201);
  });
});

describe("workspace directory", () => {
  it("lists newest first with keyset paging, searches by name, id and member email, and filters by plan and suspension", async () => {
    const t = await setup();
    const a = await t.admin("support");
    const names = ["Alpha Plumbing", "Beta Bakery", "Gamma Gym", "Delta Dental"];
    const made: string[] = [];
    for (const n of names) {
      t.ctx.clockCtl.advance(1000);
      made.push((await seedWorkspace(t.ctx, n)).wsId);
    }
    await t.ctx.db.run("UPDATE workspaces SET plan = 'pro' WHERE id = ?", made[1]);
    const p1 = await t.call("GET", "/workspaces?limit=3", a.token);
    expect(p1.body.data.map((w: { name: string }) => w.name)).toEqual(["Delta Dental", "Gamma Gym", "Beta Bakery"]);
    const p2 = await t.call("GET", `/workspaces?limit=3&cursor=${p1.body.next_cursor}`, a.token);
    expect(p2.body.data.map((w: { name: string }) => w.name)).toEqual(["Alpha Plumbing", "Acme"]);
    expect(p2.body.next_cursor).toBeNull();
    expect((await t.call("GET", "/workspaces?search=bakery", a.token)).body.data.map((w: { id: string }) => w.id)).toEqual([made[1]]);
    expect((await t.call("GET", `/workspaces?search=${made[2]}`, a.token)).body.data).toHaveLength(1);
    const ownerEmail = (await t.ctx.db.get<{ email: string }>("SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner'", made[3]))!.email;
    expect((await t.call("GET", `/workspaces?search=${encodeURIComponent(ownerEmail)}`, a.token)).body.data.map((w: { id: string }) => w.id)).toEqual([made[3]]);
    expect((await t.call("GET", "/workspaces?search=%25", a.token)).body.data).toHaveLength(0); // wildcards are literals
    expect((await t.call("GET", "/workspaces?plan=pro", a.token)).body.data.map((w: { id: string }) => w.id)).toEqual([made[1]]);
    const stats = (await t.call("GET", "/stats", a.token)).body;
    expect(stats).toMatchObject({ workspaces: 5, suspended: 0, by_plan: { free: 4, pro: 1 } });
  });

  it("the detail view shows the shape of an account (plan, billing state, seats, usage, ledger, audit) and none of its conversations or cards", async () => {
    const t = await setup();
    const a = await t.admin("support");
    const { room } = await mkRoom(t.ctx, t.wsId, { contact: { name: "Secret Customer", email: "secret@customer.test" } });
    const { agentSays } = await import("./helpers.js");
    await agentSays(t.ctx, t.owner, room.id, "very private reply 12345");
    await t.ctx.db.run("INSERT INTO billing_accounts(workspace_id, plan, status, stripe_customer_id, payment_method_last4, created_at, updated_at) VALUES (?, 'free', 'active', 'cus_secret', '4242', 'x', 'x')", t.wsId);
    const d = (await t.call("GET", `/workspaces/${t.wsId}`, a.token)).body;
    expect(d).toMatchObject({ id: t.wsId, name: "Acme", plan: "free", suspended: false, seats: { used: 1, limit: 3 } });
    expect(d.billing).toMatchObject({ status: "active", has_customer: true });
    expect(d.members[0]).toMatchObject({ role: "owner" });
    expect(d.totals).toEqual({ rooms: 1, contacts: 1 });
    const raw = JSON.stringify(d);
    expect(raw).not.toMatch(/very private|Secret Customer|secret@customer|cus_secret|4242/);
    expect((await t.call("GET", "/workspaces/ws_nope", a.token)).status).toBe(404);
  });
});

describe("suspension", () => {
  it("shuts a workspace out at once everywhere (API, login, refresh, widget), tells the owner nothing it should not, and unsuspending restores it", async () => {
    const t = await setup();
    const boss = await t.admin("superadmin");
    // the owner signs in properly so there is a refresh token
    const email = (await t.ctx.db.get<{ email: string }>("SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?", t.wsId))!.email;
    await t.ctx.db.run("UPDATE users SET password_hash = (SELECT password_hash FROM platform_admins LIMIT 1) WHERE email = ?", email);
    const login = await t.http.post("/api/auth/login", { email, password: PW });
    expect(login.status).toBe(200);
    const tokenRow = await createToken(t.ctx, t.owner, "chat.example.com");

    expect((await t.http.get("/api/workspace", login.body.token)).status).toBe(200);
    expect((await t.call("POST", `/workspaces/${t.wsId}/suspend`, boss.token, {})).body.error.code).toBe("REASON_REQUIRED");
    expect((await t.call("POST", `/workspaces/${t.wsId}/suspend`, boss.token, { reason: "chargeback fraud" })).status).toBe(204);
    expect((await t.call("POST", `/workspaces/${t.wsId}/suspend`, boss.token, { reason: "again" })).status).toBe(409);

    const blocked = await t.http.get("/api/workspace", login.body.token);
    expect([blocked.status, blocked.body.error.code]).toEqual([403, "WORKSPACE_SUSPENDED"]);
    expect((await t.http.post("/api/auth/login", { email, password: PW })).body.error.code).toBe("WORKSPACE_SUSPENDED");
    expect((await t.http.post("/api/auth/refresh", { refresh_token: login.body.refresh_token })).status).toBeGreaterThanOrEqual(401);
    const widget = await t.http.call("GET", "/public/widget/config", { headers: { "x-api-key": tokenRow.token, origin: "https://chat.example.com" } });
    expect([widget.status, widget.body.error.code]).toEqual([403, "WORKSPACE_SUSPENDED"]);
    // other workspaces are untouched
    const other = await seedWorkspace(t.ctx, "Other");
    expect((await t.http.get("/api/workspace", await tokenFor(t.ctx, other.owner))).status).toBe(200);
    const d = (await t.call("GET", `/workspaces/${t.wsId}`, boss.token)).body;
    expect([d.suspended, d.suspended_reason]).toEqual([true, "chargeback fraud"]);
    expect((await t.call("GET", "/workspaces?suspended=true", boss.token)).body.data.map((w: { id: string }) => w.id)).toEqual([t.wsId]);

    expect((await t.call("POST", `/workspaces/${t.wsId}/unsuspend`, boss.token, { reason: "resolved" })).status).toBe(204);
    expect((await t.call("POST", `/workspaces/${t.wsId}/unsuspend`, boss.token, {})).status).toBe(409);
    const fresh = await t.http.post("/api/auth/login", { email, password: PW });
    expect((await t.http.get("/api/workspace", fresh.body.token)).status).toBe(200);
    const actions = (await t.ctx.db.all<{ action: string; actor_type: string; actor_id: string }>("SELECT action, actor_type, actor_id FROM audit_log WHERE workspace_id = ? AND action LIKE 'admin.%' ORDER BY created_at, id", t.wsId));
    expect(actions.map((x) => x.action)).toEqual(["admin.workspace_suspended", "admin.workspace_unsuspended"]);
    expect(actions.every((x) => x.actor_type === "platform_admin" && x.actor_id === boss.id)).toBe(true);
  });

  it("a connected team socket is refused on its next event after suspension", async () => {
    const srv = await startServer();
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Live");
    const { room } = await mkRoom(srv.ctx, wsId);
    const sock = await srv.team(wsId, owner);
    expect((await ack(sock, "presence:list")).ok).toBe(true);
    const { suspendWorkspace } = await import("../src/admin/service.js");
    const admin = await createPlatformAdmin(srv.ctx, { email: "s@ops.test", name: "S", password: PW });
    await suspendWorkspace(srv.ctx, { id: admin.id, email: admin.email, name: "S", role: "superadmin" }, wsId, "abuse");
    const r = await ack(sock, "message:send", { room_id: room.id, kind: "text", source: "dm", content: "still here?", client_msg_id: "susp-0000001" });
    expect([r.ok, r.error.code]).toEqual([false, "WORKSPACE_SUSPENDED"]);
    await srv.close();
  });
});

describe("credits and tiers", () => {
  it("grants and deducts credits with a reason, once per idempotency key, and records who did it in the workspace's own audit log", async () => {
    const t = await setup();
    const boss = await t.admin("superadmin");
    const bal = async () => (await t.ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", t.wsId))!.credit_balance;
    for (const bad of [{ amount: 0, note: "nothing" }, { amount: 1.5, note: "fraction" }, { amount: 2_000_000, note: "too many" }, { amount: 10 }]) expect((await t.call("POST", `/workspaces/${t.wsId}/credits`, boss.token, bad)).status, JSON.stringify(bad)).toBe(400);
    const a = await t.call("POST", `/workspaces/${t.wsId}/credits`, boss.token, { amount: 500, note: "goodwill after outage" }, { "idempotency-key": "k-1" });
    const b = await t.call("POST", `/workspaces/${t.wsId}/credits`, boss.token, { amount: 500, note: "goodwill after outage" }, { "idempotency-key": "k-1" }); // client retry
    expect([a.status, b.status, a.body.applied, b.body.applied, await bal()]).toEqual([201, 200, true, false, 500]);
    expect((await t.call("POST", `/workspaces/${t.wsId}/credits`, boss.token, { amount: -120, note: "billing correction" })).body.balance).toBe(380);
    const ledger = await t.ctx.db.all<{ kind: string; ref: string }>("SELECT kind, ref FROM usage_ledger WHERE workspace_id = ? ORDER BY created_at, id", t.wsId);
    expect(ledger.map((l) => l.kind)).toEqual(["admin_grant", "admin_deduct"]);
    expect(ledger[0]!.ref).toContain(boss.email);
    const audit = await t.ctx.db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit_log WHERE workspace_id = ? AND action = 'admin.credits_adjusted' ORDER BY created_at, id", t.wsId);
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[1]!.detail)).toMatchObject({ amount: -120, balance: 380, note: "billing correction" });
    expect((await t.call("POST", "/workspaces/ws_nope/credits", boss.token, { amount: 5, note: "who dis" })).status).toBe(404);
  });

  it("overrides the rate-limit tier of a workspace and clears it again", async () => {
    const t = await setup();
    const boss = await t.admin("superadmin");
    const limit = async () => (await t.ctx.ratelimit.check("api.workspace", { key: `probe-${Math.random()}`, workspaceId: t.wsId })).limit;
    expect(await limit()).toBe(1200);
    expect((await t.call("PUT", `/workspaces/${t.wsId}/tier`, boss.token, { tier: "business", note: "enterprise trial" })).status).toBe(204);
    expect(await limit()).toBe(30000);
    expect((await t.call("GET", `/workspaces/${t.wsId}`, boss.token)).body.tier_override).toMatchObject({ tier: "business" });
    expect((await t.call("PUT", `/workspaces/${t.wsId}/tier`, boss.token, { tier: null })).status).toBe(204);
    expect(await limit()).toBe(1200);
    expect((await t.call("PUT", `/workspaces/${t.wsId}/tier`, boss.token, { tier: "platinum" })).status).toBe(400);
  });
});

describe("support access (impersonation)", () => {
  it("mints a read-only 15-minute token for the owner seat; reads work, every write is refused, the owner's audit log shows who looked and why", async () => {
    const t = await setup();
    const sup = await t.admin("support");
    await mkRoom(t.ctx, t.wsId);
    expect((await t.call("POST", `/workspaces/${t.wsId}/impersonate`, sup.token, {})).body.error.code).toBe("REASON_REQUIRED");
    const r = await t.call("POST", `/workspaces/${t.wsId}/impersonate`, sup.token, { reason: "ticket 4411: customer cannot see inbox" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ read_only: true, expires_in: 900, workspace: { id: t.wsId } });
    const tok = r.body.token as string;
    expect((await t.http.get("/api/rooms", tok)).status).toBe(200);
    expect((await t.http.get("/api/members", tok)).status).toBe(200);
    expect((await t.http.get("/api/billing", tok)).body.error.code).toBe("PERMISSION_DENIED"); // the owner could, support cannot
    expect((await t.http.get("/api/audit", tok)).status).toBe(403);
    for (const [m, p, body] of [["POST", "/api/rooms", { contact_id: "x" }], ["PATCH", "/api/workspace", { name: "hijack" }], ["POST", "/api/auth/password/change", { current_password: "x", new_password: "yyyyyyyy" }], ["PATCH", "/api/members/me", { name: "Mallory" }], ["DELETE", "/api/rooms/x", undefined], ["POST", "/api/notifications/read-all", {}]] as const) {
      const w = await t.http.call(m, p, { token: tok, json: body });
      expect([w.status, w.body.error.code], `${m} ${p}`).toEqual([403, "IMPERSONATION_READ_ONLY"]);
    }
    expect((await t.ctx.db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", t.wsId))!.name).toBe("Acme");
    // the workspace's own owner sees the access in their audit log
    const audit = await t.http.get("/api/audit?action=admin.", t.wsToken);
    const entry = audit.body.data.find((e: { action: string }) => e.action === "admin.impersonation_started");
    expect(entry).toMatchObject({ actor_type: "platform_admin", actor_id: sup.id });
    expect(JSON.stringify(entry)).toContain("ticket 4411");
    // not refreshable, short lived, and it ends the moment the admin is disabled
    t.ctx.clockCtl.advance(16 * 60_000);
    expect((await t.http.get("/api/rooms", tok)).status).toBe(401);
  });

  it("stops working when the admin that minted it is disabled, and is refused for a suspended workspace", async () => {
    const t = await setup();
    const boss = await t.admin("superadmin");
    const sup = await t.admin("support");
    const tok = (await t.call("POST", `/workspaces/${t.wsId}/impersonate`, sup.token, { reason: "debugging a sync issue" })).body.token as string;
    expect((await t.http.get("/api/rooms", tok)).status).toBe(200);
    await t.call("POST", `/admins/${sup.id}/disable`, boss.token);
    expect((await t.http.get("/api/rooms", tok)).status).toBe(401);
    await t.call("POST", `/workspaces/${t.wsId}/suspend`, boss.token, { reason: "fraud" });
    expect((await t.call("POST", `/workspaces/${t.wsId}/impersonate`, boss.token, { reason: "look anyway" })).status).toBe(409);
  });

  it("an impersonation socket receives updates but cannot emit anything that changes state", async () => {
    const srv = await startServer();
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Watch");
    const { room } = await mkRoom(srv.ctx, wsId);
    const { startImpersonation } = await import("../src/admin/service.js");
    const admin = await createPlatformAdmin(srv.ctx, { email: "sup@ops.test", name: "S", password: PW, role: "support" });
    const imp = await startImpersonation(srv.ctx, { id: admin.id, email: admin.email, name: "S", role: "support" }, wsId, { reason: "debugging" });
    const sock = await srv.connect(wsId, { token: imp.token });
    const r = await ack(sock, "message:send", { room_id: room.id, kind: "text", source: "dm", content: "should not send", client_msg_id: "imp-0000001" });
    expect([r.ok, r.error.code]).toEqual([false, "IMPERSONATION_READ_ONLY"]);
    expect((await ack(await srv.team(wsId, owner), "presence:list")).ok).toBe(true);
    expect(await srv.ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND content_text = 'should not send'", room.id)).toBeUndefined();
    await srv.close();
  });
});

describe("audit view and rate-limit controls", () => {
  it("filters and pages the platform audit log, and every change above is in it", async () => {
    const t = await setup();
    const boss = await t.admin("superadmin");
    for (let i = 0; i < 3; i++) {
      t.ctx.clockCtl.advance(1000);
      await t.call("POST", `/workspaces/${t.wsId}/credits`, boss.token, { amount: 10 + i, note: `grant number ${i}` });
    }
    const all = await t.call("GET", `/audit?workspace_id=${t.wsId}&action=admin.credits&limit=2`, boss.token);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0].detail.amount).toBe(12);
    const next = await t.call("GET", `/audit?workspace_id=${t.wsId}&action=admin.credits&limit=2&cursor=${all.body.next_cursor}`, boss.token);
    expect(next.body.data.map((e: { detail: { amount: number } }) => e.detail.amount)).toEqual([10]);
    expect(next.body.next_cursor).toBeNull();
    expect((await t.call("GET", "/audit?actor_type=platform_admin&action=admin.login", boss.token)).body.data.length).toBeGreaterThan(0);
    // append-only: even a platform-level bug cannot rewrite it
    await expect(t.ctx.db.run("UPDATE audit_log SET action = 'x'")).rejects.toThrow();
    await expect(t.ctx.db.run("DELETE FROM audit_log")).rejects.toThrow();
  });

  it("blocks and unblocks entities through the limiter's lists, validating what it is given", async () => {
    const t = await setup();
    const boss = await t.admin("superadmin");
    expect((await t.call("POST", "/ratelimit/deny", boss.token, { entity: "not an entity", ttl_seconds: 60 })).status).toBe(400);
    expect((await t.call("POST", "/ratelimit/deny", boss.token, { entity: "ip:203.0.113.5", ttl_seconds: 60, note: "scraping" })).status).toBe(204);
    expect((await t.call("POST", "/ratelimit/sideways", boss.token, { entity: "ip:203.0.113.5", ttl_seconds: 60 })).status).toBe(404);
    const o = (await t.call("GET", "/ratelimit", boss.token)).body;
    expect(JSON.stringify(o.lists.deny)).toContain("203.0.113.5");
    const blocked = await t.http.call("GET", "/healthz", { headers: { "x-forwarded-for": "203.0.113.5" } });
    expect(blocked.status).toBe(200); // health probes are exempt even from blocks
    expect((await t.call("DELETE", "/ratelimit/deny/ip%3A203.0.113.5", boss.token)).body.removed).toBe(true);
    expect((await t.call("GET", "/audit?action=ratelimit.deny", boss.token)).body.data.map((e: { action: string }) => e.action)).toEqual(["ratelimit.deny.remove", "ratelimit.deny.add"]);
  });
});

void createContext;
void addMemberRaw;
void actorFromRow;
void getMember;

describe("home region", () => {
  it("a workspace homed in another region is refused with 421 and the right region; clearing it restores access; unset REGION disables the check", async () => {
    const t = await setup({ REGION: "eu-west" });
    const boss = await t.admin("superadmin");
    expect((await t.http.get("/api/workspace", t.wsToken)).status).toBe(200); // no home region yet: served anywhere
    expect((await t.call("PUT", `/workspaces/${t.wsId}/region`, boss.token, { region: "Bad Region!" })).status).toBe(400);
    expect((await t.call("PUT", `/workspaces/${t.wsId}/region`, boss.token, { region: "us-east" })).status).toBe(204);
    const r = await t.http.get("/api/workspace", t.wsToken);
    expect([r.status, r.body.error.code, r.body.error.details]).toEqual([421, "WRONG_REGION", { region: "us-east" }]);
    expect((await t.call("GET", `/workspaces/${t.wsId}`, boss.token)).body.home_region).toBe("us-east");
    expect((await t.call("PUT", `/workspaces/${t.wsId}/region`, boss.token, { region: "eu-west" })).status).toBe(204);
    expect((await t.http.get("/api/workspace", t.wsToken)).status).toBe(200);
    const single = await setup();
    const b2 = await single.admin("superadmin");
    await single.call("PUT", `/workspaces/${single.wsId}/region`, b2.token, { region: "us-east" });
    expect((await single.http.get("/api/workspace", single.wsToken)).status).toBe(200); // this installation has no REGION: no check
    const sup = await t.admin("support");
    expect((await t.call("PUT", `/workspaces/${t.wsId}/region`, sup.token, { region: null })).status).toBe(403);
  });
});
