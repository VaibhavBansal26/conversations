import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/errors.js";
import { createMonitor, noopMonitor, validDsn } from "../src/monitoring/sentry.js";
import { scrubEvent, scrubPath, scrubString, shouldIgnore } from "../src/monitoring/scrub.js";
import { silentLogger } from "../src/logger.js";
import { createPlatformAdmin, adminLogin, adminMfaEnable, adminMfaSetup } from "../src/admin/auth.js";
import { base32Decode, hotp, totpStep } from "../src/util/totp.js";
import { client, fullApp, makeCtx, seedWorkspace, testConfig, tokenFor } from "./helpers.js";

const DSN = "https://publickey@o0.ingest.invalid/1";

/** A Sentry transport that keeps envelopes in memory: nothing here touches the network. */
function fakeTransport() {
  const items: { type: string; payload: any }[] = [];
  const factory = () => ({
    send: async (envelope: any) => {
      for (const [h, p] of envelope[1]) items.push({ type: h.type, payload: p });
      return {};
    },
    flush: async () => true,
  });
  return { items, factory, events: () => items.filter((i) => i.type === "event").map((i) => i.payload) };
}

describe("scrubString", () => {
  const cases: [string, string, string][] = [
    ["email", "failed for sam.person+tag@example.co.uk now", "sam.person"],
    ["phone", "sms to +1 (415) 555-2671 failed", "555-2671"],
    ["phone e164", "to +14155552671", "4155552671"],
    ["jwt", "bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123_-", "eyJhbGci"],
    ["bearer", "header Bearer abcdefghijklmnop1234", "abcdefghijklmnop"],
    ["basic", "header Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpw"],
    ["sendgrid", "key SG.abcdefghijkl.mnopqrstuvwxyz", "abcdefghijkl"],
    ["stripe", "key sk_live_abcdefghijklmnop and whsec_abcdefghijklmnop", "abcdefghijklmnop"],
    ["visitor token", "session ses_abcdefghijklmnop widget cvt_abcdefghijklmnop", "abcdefghijklmnop"],
    ["twilio sid", "account AC" + "0123456789abcdef".repeat(2), "0123456789abcdef"],
    ["hex secret", "auth token 0123456789abcdef0123456789abcdef0123", "0123456789abcdef"],
    ["query token", "GET /x?token=supersecretvalue&page=2", "supersecretvalue"],
  ];
  for (const [name, input, secret] of cases) {
    it(`redacts ${name}`, () => {
      const out = scrubString(input);
      expect(out).not.toContain(secret);
      expect(out.length).toBeGreaterThan(0);
    });
  }
  it("truncates long text", () => expect(scrubString("a ".repeat(2000), 100).length).toBeLessThanOrEqual(101));
  it("keeps ordinary text", () => expect(scrubString("Cannot read properties of undefined (reading 'seq')")).toBe("Cannot read properties of undefined (reading 'seq')"));
});

describe("scrubPath", () => {
  it("replaces ids and drops the query", () => {
    expect(scrubPath("/api/rooms/room_abcdef123456/messages?token=abc")).toBe("/api/rooms/:id/messages");
    expect(scrubPath("/api/members/42")).toBe("/api/members/:id");
  });
});

describe("scrubEvent (allow-list)", () => {
  const dirty = {
    event_id: "e1",
    level: "error",
    platform: "node",
    release: "abc123",
    environment: "production",
    server_name: "host.local",
    user: { id: "u1", email: "a@b.co", ip_address: "1.2.3.4", username: "sam" },
    request: {
      method: "POST",
      url: "https://app.example.com/api/rooms/room_abcdef123456/messages?token=ses_abcdefghijklmnop",
      query_string: "token=ses_abcdefghijklmnop",
      cookies: { refresh: "r-secret" },
      headers: { authorization: "Bearer abcdefghijklmnop1234", cookie: "refresh=r-secret", "x-api-key": "cvt_abcdefghijklmnop" },
      data: { content: "my card is 4242 4242 4242 4242", email: "sam@example.com", phone: "+14155552671", attachments: [{ name: "passport.pdf" }] },
    },
    extra: { body: "hello there", contact: { name: "Sam Person" } },
    breadcrumbs: [{ message: "POST /api/rooms with sam@example.com" }],
    contexts: { runtime: { name: "node", version: "22" }, device: { name: "laptop" }, os: { name: "mac" }, response: { headers: { "set-cookie": "x" } } },
    tags: { route: "/api/rooms/:id/messages", request_id: "req-1", workspace: "abcd", plan: "pro", email: "sam@example.com", authorization: "Bearer zzzzzzzzzzzzzz", custom: "nope" },
    exception: {
      values: [
        {
          type: "Error",
          value: "send to sam.person@example.com (+14155552671) failed: Bearer abcdefghijklmnop1234",
          stacktrace: { frames: [{ filename: "/Users/me/app/server/src/services/messages.ts", function: "send", lineno: 10, colno: 3, in_app: true, vars: { content: "secret text" }, context_line: "const body = secret", pre_context: ["x"], post_context: ["y"] }] },
        },
      ],
    },
  };
  const out = scrubEvent(dirty)!;
  const text = JSON.stringify(out);

  it("never carries request data, headers, cookies, query, user, extra, breadcrumbs or other contexts", () => {
    expect(out.request).toEqual({ method: "POST" });
    for (const k of ["user", "extra", "breadcrumbs", "server_name"]) expect(out).not.toHaveProperty(k);
    expect(Object.keys(out.contexts)).toEqual(["runtime"]);
  });
  it("contains none of the sensitive values anywhere", () => {
    for (const s of ["sam@example.com", "sam.person", "4155552671", "4242", "passport", "abcdefghijklmnop", "r-secret", "secret text", "Sam Person", "hello there", "const body", "1.2.3.4"]) {
      expect(text, s).not.toContain(s);
    }
  });
  it("keeps the allowed tags and drops the rest", () => {
    expect(out.tags).toEqual({ route: "/api/rooms/:id/messages", request_id: "req-1", workspace: "abcd", plan: "pro" });
  });
  it("keeps what is needed to debug: type, redacted message, frames without source or variables", () => {
    const ex = out.exception.values[0];
    expect(ex.type).toBe("Error");
    expect(ex.value).toContain("failed");
    expect(ex.stacktrace.frames[0]).toMatchObject({ function: "send", lineno: 10, in_app: true });
    expect(ex.stacktrace.frames[0].filename).toBe("/src/services/messages.ts");
    expect(ex.stacktrace.frames[0]).not.toHaveProperty("vars");
    expect(ex.stacktrace.frames[0]).not.toHaveProperty("context_line");
  });
  it("handles nested objects and arrays that sit in non-allowed fields by dropping them", () => {
    const o = scrubEvent({ extra: { a: [{ b: { email: "x@y.zz" } }] }, tags: { route: ["x@y.zz"] } } as never)!;
    expect(JSON.stringify(o)).not.toContain("x@y.zz");
  });
  it("transactions keep structure only: no span descriptions, data or urls", () => {
    const t = scrubEvent({ type: "transaction", transaction: "POST /api/rooms/:id/messages", start_timestamp: 1, timestamp: 2, spans: [{ span_id: "s", trace_id: "t", op: "db", description: "SELECT * FROM contacts WHERE email = 'a@b.co'", data: { "db.statement": "x" }, start_timestamp: 1, timestamp: 2 }] } as never)!;
    expect(JSON.stringify(t)).not.toMatch(/SELECT|a@b\.co|db\.statement/);
    expect((t as any).spans[0].op).toBe("db");
  });
});

describe("shouldIgnore", () => {
  it("ignores client errors, validation, rate limits, aborts and socket disconnects; keeps 5xx and unknown errors", () => {
    expect(shouldIgnore(new AppError(404, "NOT_FOUND", "x"))).toBe(true);
    expect(shouldIgnore(new AppError(400, "VALIDATION_ERROR", "x"))).toBe(true);
    expect(shouldIgnore(new AppError(429, "RATE_LIMITED", "x"))).toBe(true);
    expect(shouldIgnore(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(shouldIgnore(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(shouldIgnore(new Error("transport close"))).toBe(true);
    expect(shouldIgnore(new AppError(502, "BAD_GATEWAY", "x"))).toBe(false);
    expect(shouldIgnore(new Error("boom"))).toBe(false);
  });
});

describe("DSN handling", () => {
  it("validates DSN shape", () => {
    expect(validDsn(DSN)).toBe(true);
    for (const bad of [undefined, "", "nonsense", "https://host/1", "ftp://k@h/1", "https://k@h/notanumber"]) expect(validDsn(bad as never)).toBe(false);
  });
  it("without a DSN it is the no-op: nothing is loaded, nothing is sent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const m = createMonitor(testConfig(), silentLogger);
    expect(m).toBe(noopMonitor);
    expect(m.enabled).toBe(false);
    m.capture(new Error("boom"), { area: "http" });
    expect(await m.flush()).toBe(true);
    m.beginRequest("GET").finish("/x", 200);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("an invalid DSN does not crash and leaves monitoring off", async () => {
    const warn = vi.fn();
    const m = createMonitor(testConfig({ SENTRY_DSN: "not-a-dsn" }), { ...silentLogger, warn } as never);
    expect(m.enabled).toBe(false);
    expect(warn).toHaveBeenCalled();
    const ctx = await makeCtx({ SENTRY_DSN: "not-a-dsn" });
    expect(ctx.monitor.enabled).toBe(false);
  });
});

describe("with a DSN (fake transport)", () => {
  const t = fakeTransport();
  let closeSdk: (() => Promise<unknown>) | null = null;
  afterAll(async () => {
    await closeSdk?.();
  });

  async function boot() {
    const monitor = createMonitor(testConfig({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "test-env", SENTRY_RELEASE: "rel-1", SENTRY_TRACES_SAMPLE_RATE: "1" }), silentLogger, { transport: t.factory });
    await monitor.ready();
    const Sentry = await import("@sentry/node");
    closeSdk = () => Sentry.close(1000);
    const ctx = await makeCtx({}, { monitor });
    const app = createApp(ctx);
    app.get("/test-boom/:id", () => {
      throw new Error("kaboom for sam@example.com");
    });
    app.get("/test-503/:id", () => {
      throw new AppError(503, "UNAVAILABLE", "down");
    });
    return { ctx, app, monitor };
  }

  it("captures a 5xx with the route pattern, request id and hashed workspace; ignores 4xx; scrubs the message; sets release and environment", async () => {
    const { ctx, app, monitor } = await boot();
    const ws = await seedWorkspace(ctx, "Tagged");
    const token = await tokenFor(ctx, ws.owner);
    // a 4xx and a validation error first: neither may be reported
    expect((await client(app).get("/api/rooms/room_doesnotexist1", token)).status).toBe(404);
    expect((await client(app).post("/api/auth/login", { nope: true })).status).toBe(400);
    const res = await app.request("/test-boom/room_abcdef123456?token=ses_abcdefghijklmnop", { headers: { "x-request-id": "req-12345678", authorization: `Bearer ${token}` } });
    expect(res.status).toBe(500);
    await app.request("/test-503/room_abcdef123456");
    expect(await monitor.flush(2000)).toBe(true);
    const events = t.events();
    expect(events).toHaveLength(2);
    const e = events.find((x) => /kaboom/.test(JSON.stringify(x)))!;
    expect(e.tags).toMatchObject({ route: "/test-boom/:id", method: "GET", status: "500", area: "http", request_id: expect.any(String) });
    expect(e.release).toBe("rel-1");
    expect(e.environment).toBe("test-env");
    const text = JSON.stringify(events);
    for (const s of ["sam@example.com", "abcdefghijklmnop", ws.wsId, token, "room_abcdef123456"]) expect(text, s).not.toContain(s);
    expect(events.every((x: any) => !x.user && !x.breadcrumbs && !x.extra && x.request?.url === undefined)).toBe(true);
    // the workspace tag is a stable hash, not the id
    const tagged = events.filter((x: any) => x.tags.workspace);
    for (const x of tagged) expect(x.tags.workspace).toMatch(/^[0-9a-f]{16}$/);
  });

  it("captures job failures and socket handler errors with their own tags", async () => {
    const { ctx, monitor } = await boot();
    const before = t.events().length;
    ctx.monitor.capture(new Error("job exploded for +14155552671"), { area: "job", job_type: "send_sms" });
    ctx.monitor.capture(new Error("handler"), { area: "socket", event: "message:send", socket_id: "sock1" });
    ctx.monitor.capture(new AppError(429, "RATE_LIMITED", "slow down"), { area: "socket" });
    await monitor.flush(2000);
    const fresh = t.events().slice(before);
    expect(fresh).toHaveLength(2);
    expect(fresh[0].tags).toMatchObject({ area: "job", job_type: "send_sms" });
    expect(JSON.stringify(fresh)).not.toContain("4155552671");
    expect(fresh[1].tags).toMatchObject({ area: "socket", event: "message:send", socket_id: "sock1" });
  });

  it("sends sampled transactions named by route pattern without raw URLs", async () => {
    const { app, monitor } = await boot();
    await app.request("/healthz");
    await app.request("/test-503/room_abcdef123456");
    await monitor.flush(2000);
    const tx = t.items.filter((i) => i.type === "transaction").map((i) => i.payload);
    expect(tx.length).toBeGreaterThan(0);
    expect(JSON.stringify(tx)).not.toContain("room_abcdef123456");
    expect(tx.some((x: any) => x.transaction === "GET /test-503/:id")).toBe(true);
  });

  it("flush on shutdown resolves true", async () => {
    const { monitor } = await boot();
    monitor.capture(new Error("last words"), { area: "process" });
    expect(await monitor.flush(2000)).toBe(true);
    expect(JSON.stringify(t.events())).toContain("last words");
  });
});

describe("platform admin test action and runtime config", () => {
  const PW = "correct horse battery staple";
  async function superadminToken(ctx: Awaited<ReturnType<typeof makeCtx>>) {
    const email = `ops-${Math.random().toString(16).slice(2, 8)}@ops.test`;
    await createPlatformAdmin(ctx, { email, name: "Ops", password: PW, role: "superadmin" });
    const l = (await adminLogin(ctx, { email, password: PW })) as { mfa_token: string };
    const secret = (await adminMfaSetup(ctx, l.mfa_token)).secret;
    return (await adminMfaEnable(ctx, l.mfa_token, hotp(base32Decode(secret), totpStep(ctx.clock().getTime())))).token;
  }
  it("reports monitoring off when no DSN is set and needs an admin token", async () => {
    const f = await fullApp();
    expect((await f.http.post("/admin/api/monitoring/test", {})).status).toBe(401);
    expect((await f.http.post("/admin/api/monitoring/test", {}, f.token)).status).toBe(401); // a workspace session is not an admin token
    const r = await f.http.post("/admin/api/monitoring/test", {}, await superadminToken(f.ctx));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, delivered: false });
  });
  it("serves the web DSN at runtime, uncached, or null when unset", async () => {
    const off = await fullApp();
    const a = await off.app.request("/runtime-config.json");
    expect(await a.json()).toEqual({ sentry: null });
    expect(a.headers.get("cache-control")).toBe("no-store");
    const on = await fullApp({ SENTRY_DSN: "not-a-dsn" });
    expect(await (await on.app.request("/runtime-config.json")).json()).toEqual({ sentry: null });
    const web = await fullApp({ SENTRY_WEB_DSN: "https://webkey@o0.ingest.invalid/2", SENTRY_ENVIRONMENT: "staging", SENTRY_RELEASE: "r9", SENTRY_TRACES_SAMPLE_RATE: "0.2" });
    expect(await (await web.app.request("/runtime-config.json")).json()).toEqual({ sentry: { dsn: "https://webkey@o0.ingest.invalid/2", environment: "staging", release: "r9", tracesSampleRate: 0.2 } });
  });
});
