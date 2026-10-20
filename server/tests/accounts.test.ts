import { describe, expect, it } from "vitest";
import type { FakeEmailProvider } from "../src/providers/fake.js";
import { hotp, base32Decode, totpStep } from "../src/util/totp.js";
import { fullApp, makeCtx, type TestCtx } from "./helpers.js";
import { createApp } from "../src/app.js";
import { client } from "./helpers.js";

const code = (secret: string, ctx: TestCtx, offset = 0) => hotp(base32Decode(secret), totpStep(ctx.clock().getTime()) + offset);
const emails = (ctx: TestCtx) => (ctx.email as unknown as FakeEmailProvider).sent;

async function signedUp(env: Record<string, string> = {}) {
  const ctx = await makeCtx({ TRUST_PROXY: "true", ...env });
  const app = createApp(ctx);
  const http = client(app);
  const reg = await http.post("/api/auth/register", { email: "owner@acme.test", password: "correct-horse-1", name: "Olive Owner", workspace_name: "Acme" });
  expect(reg.status).toBe(201);
  return { ctx, app, http, reg: reg.body };
}

describe("sessions and refresh-token rotation", () => {
  it("login returns a short-lived access token and a refresh token; refresh rotates both", async () => {
    const { http, reg, ctx } = await signedUp();
    expect(reg.refresh_token).toMatch(/^[\w-]{40,}$/);
    expect(reg.expires_in).toBe(900);
    const r1 = await http.post("/api/auth/refresh", { refresh_token: reg.refresh_token });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(reg.refresh_token);
    expect((await http.get("/api/auth/me", r1.body.token)).status).toBe(200);
    // only a hash is stored
    const rows = await ctx.db.all<{ token_hash: string }>("SELECT token_hash FROM refresh_tokens");
    expect(rows.every((r) => r.token_hash !== reg.refresh_token && r.token_hash.length === 64)).toBe(true);
  });

  it("reusing an already-used refresh token ends the whole session and is audited (theft detection)", async () => {
    const { http, reg, ctx } = await signedUp();
    const r1 = await http.post("/api/auth/refresh", { refresh_token: reg.refresh_token });
    expect(r1.status).toBe(200);
    // the thief (or a buggy client) presents the OLD token
    const reuse = await http.post("/api/auth/refresh", { refresh_token: reg.refresh_token });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("REFRESH_REUSED");
    // the legitimate newest token and its access token are dead too
    expect((await http.post("/api/auth/refresh", { refresh_token: r1.body.refresh_token })).body.error.code).toBe("SESSION_REVOKED");
    expect((await http.get("/api/auth/me", r1.body.token)).body.error.code).toBe("SESSION_REVOKED");
    const audit = await ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action = 'auth.refresh_reuse_detected'");
    expect(audit).toHaveLength(1);
  });

  it("two refreshes racing with the same token: exactly one wins, the other kills the session", async () => {
    const { http, reg } = await signedUp();
    const [a, b] = await Promise.all([http.post("/api/auth/refresh", { refresh_token: reg.refresh_token }), http.post("/api/auth/refresh", { refresh_token: reg.refresh_token })]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it("refresh tokens and sessions expire; an unknown token is refused", async () => {
    const { http, reg, ctx } = await signedUp();
    expect((await http.post("/api/auth/refresh", { refresh_token: "x".repeat(43) })).body.error.code).toBe("INVALID_REFRESH");
    ctx.clockCtl.advance(31 * 86400_000);
    expect((await http.post("/api/auth/refresh", { refresh_token: reg.refresh_token })).body.error.code).toBe("SESSION_EXPIRED");
  });

  it("logout revokes the session at once; sessions are listed and individually revocable", async () => {
    const { http, reg } = await signedUp();
    const second = await http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    const list = await http.get("/api/auth/sessions", reg.token);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect((await http.del(`/api/auth/sessions/${other.id}`, reg.token)).status).toBe(204);
    expect((await http.get("/api/auth/me", second.body.token)).status).toBe(401);
    expect((await http.call("POST", "/api/auth/logout", { json: { refresh_token: reg.refresh_token } })).status).toBe(204);
    expect((await http.get("/api/auth/me", reg.token)).status).toBe(401);
  });

  it("changing the password revokes every other session but keeps this one", async () => {
    const { http, reg } = await signedUp();
    const other = await http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    expect((await http.post("/api/auth/password/change", { current_password: "wrong-wrong-1", new_password: "brand-new-pass-1" }, reg.token)).status).toBe(401);
    expect((await http.post("/api/auth/password/change", { current_password: "correct-horse-1", new_password: "brand-new-pass-1" }, reg.token)).status).toBe(200);
    expect((await http.get("/api/auth/me", other.body.token)).status).toBe(401);
    expect((await http.get("/api/auth/me", reg.token)).status).toBe(200);
    expect((await http.post("/api/auth/login", { email: "owner@acme.test", password: "brand-new-pass-1" })).status).toBe(200);
  });
});

describe("password reset", () => {
  it("emails a single-use, expiring link; never reveals whether the account exists; ends all sessions", async () => {
    const { http, ctx, reg } = await signedUp();
    const unknown = await http.post("/api/auth/password/forgot", { email: "ghost@acme.test" });
    const known = await http.post("/api/auth/password/forgot", { email: "owner@acme.test" });
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(emails(ctx).filter((e) => e.to === "ghost@acme.test")).toHaveLength(0);
    const mail = emails(ctx).find((e) => e.to === "owner@acme.test")!;
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    const hashInDb = await ctx.db.get<{ token_hash: string }>("SELECT token_hash FROM password_resets");
    expect(hashInDb!.token_hash).not.toContain(token);
    expect((await http.post("/api/auth/password/reset", { token, password: "short" })).status).toBe(400);
    expect((await http.post("/api/auth/password/reset", { token, password: "a-brand-new-password" })).status).toBe(200);
    expect((await http.post("/api/auth/password/reset", { token, password: "another-password-1" })).body.error.code).toBe("INVALID_RESET_TOKEN"); // single use
    expect((await http.get("/api/auth/me", reg.token)).status).toBe(401); // old session gone
    expect((await http.post("/api/auth/login", { email: "owner@acme.test", password: "a-brand-new-password" })).status).toBe(200);
  });

  it("links expire after an hour; requests per address are limited", async () => {
    const { http, ctx } = await signedUp();
    await http.post("/api/auth/password/forgot", { email: "owner@acme.test" });
    const token = /token=([\w-]+)/.exec(emails(ctx).at(-1)!.text)![1]!;
    ctx.clockCtl.advance(61 * 60_000);
    expect((await http.post("/api/auth/password/reset", { token, password: "a-brand-new-password" })).body.error.code).toBe("INVALID_RESET_TOKEN");
    if (ctx.ratelimit.storeKind === "memory") {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await http.post("/api/auth/password/forgot", { email: "spam@acme.test" }, undefined, { "x-forwarded-for": `198.51.100.${i + 1}` })).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
    }
  });
});

describe("two-factor authentication (TOTP)", () => {
  async function withMfa() {
    const s = await signedUp();
    const setup = await s.http.post("/api/auth/mfa/setup", {}, s.reg.token);
    expect(setup.body.otpauth_url).toMatch(/^otpauth:\/\/totp\/Conversations:owner%40acme\.test\?secret=[A-Z2-7]+/);
    const secret = setup.body.secret as string;
    s.ctx.clockCtl.advance(30_000); // a fresh step so the enabling code is not the one login uses later
    const enable = await s.http.post("/api/auth/mfa/enable", { code: code(secret, s.ctx) }, s.reg.token);
    expect(enable.status).toBe(200);
    expect(enable.body.recovery_codes).toHaveLength(10);
    return { ...s, secret, recovery: enable.body.recovery_codes as string[] };
  }

  it("matches the RFC 6238 test vector", () => {
    const secret = Buffer.from("12345678901234567890");
    expect(hotp(secret, Math.floor(59 / 30), 6)).toBe("287082");
    expect(hotp(secret, Math.floor(1111111109 / 30), 6)).toBe("081804");
  });

  it("requires the second step after the password; wrong codes are refused; a code works once", async () => {
    const { http, ctx, secret } = await withMfa();
    const first = await http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    expect(first.body.mfa_required).toBe(true);
    expect(first.body.token).toBeUndefined();
    ctx.clockCtl.advance(30_000);
    const wrong = await http.post("/api/auth/mfa/verify", { mfa_token: first.body.mfa_token, code: "000000" });
    expect(wrong.status).toBe(401);
    const good = code(secret, ctx);
    const ok = await http.post("/api/auth/mfa/verify", { mfa_token: first.body.mfa_token, code: good });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    // replay of the same code in the same step: refused
    const again = await http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    const replay = await http.post("/api/auth/mfa/verify", { mfa_token: again.body.mfa_token, code: good });
    expect(replay.status).toBe(401);
  });

  it("recovery codes work exactly once", async () => {
    const { http, recovery } = await withMfa();
    const login = () => http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    expect((await http.post("/api/auth/mfa/verify", { mfa_token: (await login()).body.mfa_token, code: recovery[0]! })).status).toBe(200);
    expect((await http.post("/api/auth/mfa/verify", { mfa_token: (await login()).body.mfa_token, code: recovery[0]! })).status).toBe(401);
    expect((await http.post("/api/auth/mfa/verify", { mfa_token: (await login()).body.mfa_token, code: recovery[1]!.toUpperCase() })).status).toBe(200);
  });

  it("five wrong codes lock the second step even with the right code afterwards", async () => {
    const { http, ctx, secret } = await withMfa();
    const first = await http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    for (let i = 0; i < 5; i++) expect((await http.post("/api/auth/mfa/verify", { mfa_token: first.body.mfa_token, code: "123456" }, undefined, { "x-forwarded-for": `203.0.113.${i + 1}` })).status).toBe(401);
    ctx.clockCtl.advance(30_000);
    const locked = await http.post("/api/auth/mfa/verify", { mfa_token: first.body.mfa_token, code: code(secret, ctx) }, undefined, { "x-forwarded-for": "203.0.113.99" });
    expect(locked.status).toBe(429);
  });

  it("the secret is encrypted at rest; disabling needs the password and a code", async () => {
    const { http, ctx, secret, reg } = await withMfa();
    const row = await ctx.db.get<{ totp_secret: string }>("SELECT totp_secret FROM users WHERE email = 'owner@acme.test'");
    expect(row!.totp_secret).not.toContain(secret);
    ctx.clockCtl.advance(30_000);
    expect((await http.post("/api/auth/mfa/disable", { password: "wrong-pass-123", code: code(secret, ctx) }, reg.token)).status).toBe(401);
    expect((await http.post("/api/auth/mfa/disable", { password: "correct-horse-1", code: code(secret, ctx) }, reg.token)).status).toBe(200);
    const login = await http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    expect(login.body.token).toBeTruthy();
  });

  it("an expired or foreign challenge token is refused", async () => {
    const { http, ctx, secret } = await withMfa();
    const first = await http.post("/api/auth/login", { email: "owner@acme.test", password: "correct-horse-1" });
    ctx.clockCtl.advance(6 * 60_000);
    expect((await http.post("/api/auth/mfa/verify", { mfa_token: first.body.mfa_token, code: code(secret, ctx) })).body.error.code).toBe("MFA_TOKEN_INVALID");
    expect((await http.post("/api/auth/mfa/verify", { mfa_token: "x".repeat(60), code: "123456" })).status).toBe(401);
  });
});

describe("invitations", () => {
  async function team() {
    const f = await fullApp();
    return f;
  }

  it("an invited person joins with exactly the invited role; the link is single use", async () => {
    const { ctx, http, token, wsId } = await team();
    const inv = await http.post("/api/invitations", { email: "New.Person@Example.test", role_id: "role_viewer" }, token);
    expect(inv.status).toBe(201);
    const mail = emails(ctx).find((e) => e.to === "new.person@example.test")!;
    expect(mail.subject).toContain("invited you");
    const t = /token=([\w-]+)/.exec(mail.text)![1]!;
    const info = await http.get(`/api/auth/invitations/${t}`);
    expect(info.body).toMatchObject({ email: "new.person@example.test", has_account: false });
    const accepted = await http.post("/api/auth/invitations/accept", { token: t, name: "Nia Newcomer", password: "welcome-pass-1" });
    expect(accepted.status).toBe(201);
    expect(accepted.body.member.role).toBe("viewer");
    expect(accepted.body.workspace.id).toBe(wsId);
    expect((await http.get("/api/rooms", accepted.body.token)).status).toBe(200);
    expect((await http.post("/api/rooms/bulk", { room_ids: ["x"], action: "close" }, accepted.body.token)).status).toBe(403);
    expect((await http.post("/api/auth/invitations/accept", { token: t, password: "welcome-pass-1" })).body.error.code).toBe("INVALID_INVITATION");
  });

  it("existing users must prove their password; a wrong one does not burn the invitation", async () => {
    const { ctx, http, token, wsId } = await team();
    const { hashPassword } = await import("../src/util/crypto.js");
    await ctx.db.run("INSERT INTO users(id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)", "usr_existing", "existing@example.test", await hashPassword("existing-pass-1"), "Eve Existing", ctx.clock().toISOString());
    await http.post("/api/invitations", { email: "existing@example.test", role_id: "role_agent" }, token);
    const t = /token=([\w-]+)/.exec(emails(ctx).find((e) => e.to === "existing@example.test")!.text)![1]!;
    expect((await http.get(`/api/auth/invitations/${t}`)).body.has_account).toBe(true);
    expect((await http.post("/api/auth/invitations/accept", { token: t, password: "not-her-password" })).status).toBe(401);
    const ok = await http.post("/api/auth/invitations/accept", { token: t, password: "existing-pass-1" });
    expect(ok.status).toBe(201);
    expect(ok.body.user.id).toBe("usr_existing");
    expect(ok.body.workspace.id).toBe(wsId);
  });

  it("expire after seven days, can be revoked, and cannot be duplicated while pending", async () => {
    const { ctx, http, token } = await team();
    const a = await http.post("/api/invitations", { email: "a@example.test", role_id: "role_agent" }, token);
    expect((await http.post("/api/invitations", { email: "a@example.test", role_id: "role_agent" }, token)).body.error.code).toBe("ALREADY_INVITED");
    expect((await http.get("/api/invitations", token)).body.data).toHaveLength(1);
    expect((await http.del(`/api/invitations/${a.body.id}`, token)).status).toBe(204);
    const t1 = /token=([\w-]+)/.exec(emails(ctx).at(-1)!.text)![1]!;
    expect((await http.post("/api/auth/invitations/accept", { token: t1, password: "welcome-pass-1" })).body.error.code).toBe("INVALID_INVITATION");
    await http.post("/api/invitations", { email: "b@example.test", role_id: "role_agent" }, token);
    const t2 = /token=([\w-]+)/.exec(emails(ctx).at(-1)!.text)![1]!;
    ctx.clockCtl.advance(8 * 86400_000);
    expect((await http.post("/api/auth/invitations/accept", { token: t2, password: "welcome-pass-1" })).body.error.code).toBe("INVALID_INVITATION");
  });

  it("only seats with members:manage can invite, and nobody can invite above their own permissions", async () => {
    const { ctx, http, wsId, token } = await team();
    const { addMemberRaw, tokenFor } = await import("./helpers.js");
    const agent = await addMemberRaw(ctx, wsId, { name: "Ann Agent", role: "agent" });
    const mgr = await addMemberRaw(ctx, wsId, { name: "Mia Manager", role: "manager" });
    expect((await http.post("/api/invitations", { email: "x@example.test", role_id: "role_agent" }, await tokenFor(ctx, agent))).status).toBe(403);
    const esc = await http.post("/api/invitations", { email: "x@example.test", role_id: "role_owner" }, await tokenFor(ctx, mgr));
    expect(esc.status).toBe(403);
    expect((await http.post("/api/invitations", { email: "x@example.test", role_id: "role_manager" }, token)).status).toBe(201);
  });
});
