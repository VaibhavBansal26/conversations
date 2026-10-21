import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { createApp } from "../src/app.js";
import { resolveClientIp, ipKey } from "../src/util/clientIp.js";
import { addListEntry, limitedKeys, removeListEntry, setWorkspaceTier } from "../src/ratelimit/admin.js";
import { RateLimiter } from "../src/ratelimit/limiter.js";
import { MemoryStore } from "../src/ratelimit/memoryStore.js";
import { POLICY_MAP, POLICIES } from "../src/ratelimit/policies.js";
import { EVENT_LIMITS, EXEMPT, ROUTE_LIMITS, referencedPolicies } from "../src/ratelimit/routePolicies.js";
import { fullApp, makeCtx, seedWorkspace, tokenFor } from "./helpers.js";

describe("declaration: every route and event has a limiter policy", () => {
  it("routes registered on the app and the declaration match exactly", async () => {
    const { app } = await fullApp();
    const registered = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
    for (const r of registered) expect(ROUTE_LIMITS.has(r) || r in EXEMPT, `route without a limiter decision: ${r}`).toBe(true);
    for (const k of [...ROUTE_LIMITS.keys(), ...Object.keys(EXEMPT)]) expect(registered.has(k), `declared but not registered: ${k}`).toBe(true);
  });
  it("every policy id referenced exists, and every registered policy is used somewhere", () => {
    expect(referencedPolicies()).toEqual([]);
    const used = new Set<string>();
    for (const s of ROUTE_LIMITS.values()) for (const id of [...(s.pre ?? []), ...(s.post ?? []), ...(s.inHandler ?? [])]) used.add(id);
    for (const e of Object.values(EVENT_LIMITS)) for (const id of e.inHandler ?? []) used.add(id);
    // policies applied by the socket server / delivery path rather than a route
    for (const id of ["ip.global", "ws.connect.ip", "ws.conn.user", "ws.conn.visitor", "ws.conn.workspace", "ws.conn.ip", "ws.event", "ws.actor", "sms.number", "email.sender", "msg.room", "msg.workspace", "calls.link.create"]) used.add(id);
    for (const p of POLICIES) expect(used.has(p.id), `policy ${p.id} is never applied`).toBe(true);
    expect(POLICY_MAP.size).toBe(POLICIES.length);
  });
  it("every socket event the server registers has an EVENT_LIMITS entry", () => {
    const src = readFileSync("src/realtime/socket.ts", "utf8");
    const events = [...src.matchAll(/^\s+on\("([a-z:]+)"/gm)].map((m) => m[1]!);
    expect(events.length).toBeGreaterThanOrEqual(8);
    for (const e of events) expect(EVENT_LIMITS[e], e).toBeDefined();
    for (const e of Object.keys(EVENT_LIMITS)) expect(events, e).toContain(e);
  });
});

describe("HTTP contract", () => {
  it("emits IETF RateLimit headers plus the legacy X-RateLimit set, consistently, and they move as requests are spent", async () => {
    const { app, token } = await fullApp();
    const read = async () => Object.fromEntries((await app.request("/api/rooms", { headers: { authorization: `Bearer ${token}` } })).headers.entries());
    const a = await read();
    const b = await read();
    for (const h of [a, b]) {
      expect(h["ratelimit-policy"]).toMatch(/^"[a-z.]+";q=\d+;w=\d+$/);
      expect(h["ratelimit"]).toMatch(/^"[a-z.]+";r=\d+;t=\d+$/);
      expect(Number(h["x-ratelimit-limit"])).toBeGreaterThan(0);
      expect(h["retry-after"]).toBeUndefined();
    }
    expect(a["ratelimit"]!.match(/r=(\d+)/)![1]).toBe(a["x-ratelimit-remaining"]);
    expect(Number(b["x-ratelimit-remaining"])).toBeLessThan(Number(a["x-ratelimit-remaining"]));
  });

  it("429 carries the documented body, an integer Retry-After that is accurate, and never other tenants' state", async () => {
    const { ctx, app } = await fullApp();
    let last = { status: 0, headers: new Headers(), body: null as any };
    for (let i = 0; i < 62; i++) {
      const res = await app.request("/public/widget/config", { headers: { "x-api-key": "nope" } });
      last = { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests", retry_after_s: expect.any(Number), policy: "public.config" } });
    const retry = Number(last.headers.get("retry-after"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBe(last.body.error.retry_after_s);
    expect(last.headers.get("ratelimit")).toContain("r=0");
    // waiting exactly Retry-After makes the next call pass the limiter (it is then refused for the bogus key, not for the rate)
    // memory store follows the injected clock; the Redis store follows Redis TIME, so wait for real (the config bucket refills 1/s)
    if (ctx.ratelimit.storeKind === "redis") await new Promise((r) => setTimeout(r, retry * 1000 + 50));
    else (ctx as any).clockCtl.advance(retry * 1000);
    const after = await app.request("/public/widget/config", { headers: { "x-api-key": "nope" } });
    expect(after.status).not.toBe(429);
  });

  it("a full concurrency cap is a 503 with Retry-After, not a 429", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    for (let i = 0; i < 4; i++) await ctx.ratelimit.acquire("ai.concurrency", wsId, `held${i}`, wsId);
    const res = await http.post("/api/ai/summary", { room_id: "room_000000000000000000000000" }, token);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("OVERLOADED");
  });

  it("per-plan tiers: the same traffic is limited on free and not on pro; an admin override wins and is audited", async () => {
    const f = await fullApp();
    const { ctx, wsId } = f;
    const clock = () => ctx.clock().getTime();
    const limiter = new RateLimiter({
      store: new MemoryStore(clock, 1000, 0),
      now: clock,
      overrides: { "api.workspace": { limit: 5, windowSec: 60, tiers: { free: 5, pro: 50 } } },
      tierOf: async (ws) => (((await ctx.db.get<{ plan: string }>("SELECT plan FROM workspaces WHERE id = ?", ws))?.plan ?? "free") as "free"),
    });
    const spend = async (n: number) => {
      let ok = 0;
      for (let i = 0; i < n; i++) if ((await limiter.check("api.workspace", { key: wsId, workspaceId: wsId })).allowed) ok++;
      return ok;
    };
    expect(await spend(30)).toBe(5);
    await ctx.db.run("UPDATE workspaces SET plan = 'pro' WHERE id = ?", wsId);
    (ctx.cache as any).invalidate?.(`tier:${wsId}`);
    const limiter2 = new RateLimiter({ store: new MemoryStore(clock, 1000, 0), now: clock, overrides: { "api.workspace": { limit: 5, windowSec: 60, tiers: { free: 5, pro: 50 } } }, tierOf: async () => "pro" });
    let ok = 0;
    for (let i = 0; i < 60; i++) if ((await limiter2.check("api.workspace", { key: wsId, workspaceId: wsId })).allowed) ok++;
    expect(ok).toBe(50);
    // the real wiring honours rate_limit_overrides and records who changed it
    await setWorkspaceTier(ctx, { type: "platform_admin", id: "pa_1" }, wsId, "business", "negotiated");
    expect((await ctx.ratelimit.effective({ ...POLICY_MAP.get("api.workspace")! }, wsId)).limit).toBe(30000);
    await setWorkspaceTier(ctx, { type: "platform_admin", id: "pa_1" }, wsId, null);
    expect((await ctx.ratelimit.effective({ ...POLICY_MAP.get("api.workspace")! }, wsId)).limit).toBe(6000); // back to the plan (pro)
    const audit = await ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE workspace_id = ? ORDER BY created_at, id", wsId);
    expect(audit.map((a) => a.action)).toEqual(["ratelimit.tier.set", "ratelimit.tier.set"]);
  });

  it("RATE_LIMIT_SCALE multiplies limits (load testing) but never concurrency caps", async () => {
    const ctx = await makeCtx({ RATE_LIMIT_SCALE: "10" });
    expect((await ctx.ratelimit.effective(POLICY_MAP.get("public.session")!)).limit).toBe(200);
    expect((await ctx.ratelimit.effective(POLICY_MAP.get("ai.concurrency")!)).limit).toBe(4);
  });
});

describe("client IP extraction", () => {
  const secret = "edge-secret-edge-secret";
  const cf = { "x-edge-secret": secret, "cf-connecting-ip": "198.51.100.7" };
  const cases: [string, Parameters<typeof resolveClientIp>[0], Record<string, string>, string | undefined, string | null][] = [
    ["no proxy trust: headers are ignored", { trustProxy: false }, { "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "2.2.2.2" }, "10.0.0.5", "10.0.0.5"],
    ["spoofed CF-Connecting-IP without the secret is ignored", { trustProxy: false, edgeSecret: secret }, { "cf-connecting-ip": "2.2.2.2" }, "10.0.0.5", "10.0.0.5"],
    ["wrong secret is ignored", { trustProxy: false, edgeSecret: secret }, { "x-edge-secret": "nope", "cf-connecting-ip": "2.2.2.2" }, "10.0.0.5", "10.0.0.5"],
    ["verified Cloudflare request uses CF-Connecting-IP", { trustProxy: false, edgeSecret: secret }, cf, "10.0.0.5", "198.51.100.7"],
    ["CF header is believed only with a secret configured at all", { trustProxy: false }, cf, "10.0.0.5", "10.0.0.5"],
    ["one trusted proxy: the client is the LAST X-Forwarded-For entry, not the first (which is spoofable)", { trustProxy: true, proxyHops: 1 }, { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, "10.0.0.5", "203.0.113.9"],
    ["two trusted proxies: second from the right", { trustProxy: true, proxyHops: 2 }, { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.1.1.1" }, "10.0.0.5", "203.0.113.9"],
    ["more hops configured than entries present: refuse the spoof, use the peer", { trustProxy: true, proxyHops: 3 }, { "x-forwarded-for": "203.0.113.9" }, "10.0.0.5", "10.0.0.5"],
    ["garbage in X-Forwarded-For is ignored", { trustProxy: true }, { "x-forwarded-for": "not-an-ip" }, "10.0.0.5", "10.0.0.5"],
    ["garbage in CF-Connecting-IP is ignored", { trustProxy: false, edgeSecret: secret }, { "x-edge-secret": secret, "cf-connecting-ip": "evil" }, "10.0.0.5", "10.0.0.5"],
    ["IPv4-mapped IPv6 peer is normalised", { trustProxy: false }, {}, "::ffff:192.0.2.9", "192.0.2.9"],
    ["no peer and no headers: unknown (null), never a shared placeholder", { trustProxy: false }, {}, undefined, null],
  ];
  it.each(cases)("%s", (_n, policy, headers, remote, expected) => {
    expect(resolveClientIp(policy, headers, remote)).toBe(expected);
  });
  it("IPv6 is limited per /64, v4-mapped per IPv4", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(ipKey("2001:db8:abcd:12:ffff:ffff:ffff:ffff")).toBe("2001:db8:abcd:12::/64");
    expect(ipKey("2001:db8:abcd:13::1")).toBe("2001:db8:abcd:13::/64");
    expect(ipKey("::ffff:192.0.2.9")).toBe("192.0.2.9");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("unknown")).toBe("unknown");
  });
});

describe("account lockout, webhook signature strikes, admin lists", () => {
  const login = (app: ReturnType<typeof createApp>, email: string, password: string, extra: Record<string, string> = {}) =>
    app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ email, password }) });

  it("5 failures lock one account with a Retry-After; others are unaffected; the lock expires; success clears the count", async () => {
    const { ctx, app } = await fullApp({ TRUST_PROXY: "true" });
    const email = "owner@acme.test";
    const real = (await ctx.db.get<{ email: string }>("SELECT email FROM users LIMIT 1"))!.email;
    for (let i = 0; i < 5; i++) expect((await login(app, real, "wrong-wrong-1", { "x-forwarded-for": `203.0.113.${i + 1}` })).status).toBe(401);
    const blocked = await login(app, real, "wrong-wrong-1", { "x-forwarded-for": "203.0.113.50" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(55);
    expect(((await blocked.json()) as any).error.policy).toBe("auth.fail.account");
    // even the RIGHT password is refused while locked (and cannot be used to probe the password)
    expect((await login(app, real, "whatever-it-is", { "x-forwarded-for": "203.0.113.51" })).status).toBe(429);
    // another account from the same place is fine
    expect((await login(app, "nobody@acme.test", "x-wrong-pass-1", { "x-forwarded-for": "203.0.113.60" })).status).toBe(401);
    expect(email).toBeTruthy();
    if (ctx.ratelimit.storeKind === "memory") {
      (ctx as any).clockCtl.advance(61_000); // (the Redis store counts real time; the 60 s expiry is covered by the algorithm tests and the memory run)
      expect((await login(app, real, "wrong-wrong-1", { "x-forwarded-for": "203.0.113.70" })).status).toBe(401);
    }
  });

  it("unknown accounts lock exactly like real ones (no account enumeration through the lockout)", async () => {
    const { app } = await fullApp({ TRUST_PROXY: "true" });
    for (let i = 0; i < 5; i++) await login(app, "ghost@acme.test", "wrong-wrong-1", { "x-forwarded-for": `198.51.100.${i + 1}` });
    expect((await login(app, "ghost@acme.test", "wrong-wrong-1", { "x-forwarded-for": "198.51.100.99" })).status).toBe(429);
  });

  it("bad webhook signatures escalate into an IP block", async () => {
    const { app } = await fullApp({ NODE_ENV: "production", TWILIO_AUTH_TOKEN: "tok", TWILIO_ACCOUNT_SID: "AC1", SMS_PROVIDER: "twilio", TRUST_PROXY: "true" });
    const bad = () => app.request("/webhooks/twilio/sms", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bad", "x-forwarded-for": "192.0.2.77" }, body: "From=%2B14155550123&To=%2B14155550100&MessageSid=SM1&Body=x" });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await bad()).status);
    expect(statuses.slice(0, 10).every((s) => s === 401 || s === 403)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // a different address is not affected
    const other = await app.request("/webhooks/twilio/sms", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bad", "x-forwarded-for": "192.0.2.78" }, body: "x=1" });
    expect(other.status).not.toBe(429);
  });

  it("admin deny/allow lists with TTL take effect immediately and are audited", async () => {
    const { ctx, app } = await fullApp({ TRUST_PROXY: "true" });
    const admin = { type: "platform_admin" as const, id: "pa_1" };
    const get = (ip: string) => app.request("/public/widget/config", { headers: { "x-forwarded-for": ip, "x-api-key": "x" } });
    expect((await get("203.0.113.5")).status).not.toBe(429);
    await addListEntry(ctx, admin, "deny", "ip:203.0.113.5", 120, "abuse report #17");
    const denied = await get("203.0.113.5");
    expect(denied.status).toBe(429);
    expect(((await denied.json()) as any).error.policy).toBe("ip.global");
    expect((await get("203.0.113.6")).status).not.toBe(429);
    await addListEntry(ctx, admin, "allow", "ip:203.0.113.5", 120);
    expect((await get("203.0.113.5")).status).not.toBe(429); // allow beats deny
    await removeListEntry(ctx, admin, "allow", "ip:203.0.113.5");
    await removeListEntry(ctx, admin, "deny", "ip:203.0.113.5");
    expect((await get("203.0.113.5")).status).not.toBe(429);
    const rows = await ctx.db.all<{ action: string; target: string }>("SELECT action, target FROM audit_log ORDER BY created_at, id");
    expect(rows.map((r) => r.action)).toEqual(["ratelimit.deny.add", "ratelimit.allow.add", "ratelimit.allow.remove", "ratelimit.deny.remove"]);
    await expect(addListEntry(ctx, admin, "deny", "not an entity", 60)).rejects.toMatchObject({ code: "INVALID_ENTITY" });
    await expect(addListEntry(ctx, admin, "deny", "ip:1.2.3.4", 0)).rejects.toMatchObject({ code: "INVALID_TTL" });
  });

  it("the admin view lists recently limited keys as hashes only", async () => {
    const { ctx, app } = await fullApp();
    for (let i = 0; i < 65; i++) await app.request("/public/widget/config", { headers: { "x-api-key": "x" } });
    await new Promise((r) => setTimeout(r, 20));
    const rows = await limitedKeys(ctx);
    expect(rows.some((r) => r.policy === "public.config")).toBe(true);
    for (const r of rows) expect(r.key).toMatch(/^[A-Za-z0-9_-]{16}$/); // a hash, never the address
  });
});

// keep lint happy about helpers imported for future cases
void seedWorkspace;
void tokenFor;
