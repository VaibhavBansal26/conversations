import { describe, expect, it } from "vitest";
import { POLICY_MAP } from "../src/ratelimit/policies.js";
import { fullApp } from "./helpers.js";

/**
 * How the analytics API's limits behave, as observed against the real app (docs/RATE-LIMITING.md, "Analytics API"). These pin the behaviour
 * that looked odd in the integration run: fewer than 10 export answers, Retry-After of 6 s next to a reset of 60 s, no escalation after two 429s.
 */
describe("analytics API rate limits", () => {
  async function keys(n: number) {
    const f = await fullApp();
    const out: Record<string, string>[] = [];
    for (let i = 0; i < n; i++) out.push({ authorization: `Bearer ${(await f.http.post("/api/v1/api-keys", { name: `k${i}`, scopes: ["analytics:read", "analytics:export"] }, f.token)).body.key}` });
    return { ...f, keys: out };
  }

  it("reads and exports have separate budgets per key: three reads do not reduce the ten export requests", async () => {
    const { app, keys: [k] } = await keys(1);
    for (let i = 0; i < 3; i++) expect((await app.request("/api/v1/analytics/overview", { headers: k })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k })).status, `export ${i + 1}`).toBe(200);
    const r = await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k });
    expect(r.status).toBe(429);
    expect((await r.json()).error.policy).toBe("analytics.export");
  });

  it("every export route of a key draws on the same 10 per minute (rooms and messages-meta together)", async () => {
    const { app, keys: [k] } = await keys(1);
    for (let i = 0; i < 4; i++) expect((await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k })).status).toBe(200);
    for (let i = 0; i < 6; i++) expect((await app.request("/api/v1/analytics/export/messages-meta?limit=5", { headers: k })).status).toBe(200);
    expect((await app.request("/api/v1/analytics/export/messages-meta?limit=5", { headers: k })).status).toBe(429);
  });

  it("the per-workspace quota is shared by all keys of the workspace, reads and exports alike, and names itself in the 429", async () => {
    const { app, keys: ks } = await keys(3);
    // 120 requests per minute for a free workspace: two keys spend it with reads (60 each), then the third key is out although it never made a call
    for (const k of ks.slice(0, 2)) for (let i = 0; i < 60; i++) expect((await app.request("/api/v1/analytics/overview", { headers: k })).status).toBe(200);
    const r = await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: ks[2]! });
    expect(r.status).toBe(429);
    expect((await r.json()).error.policy).toBe("analytics.workspace");
    expect(r.headers.get("ratelimit")).toMatch(/^"analytics\.workspace";r=0;t=\d+$/);
  });

  it("Retry-After is the time until the same request would succeed (one token: window / quota); X-RateLimit-Reset and RateLimit t are the time until the bucket is full again", async () => {
    const { app, keys: [k] } = await keys(1);
    for (let i = 0; i < 10; i++) await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k });
    const r = await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k });
    expect(r.status).toBe(429);
    const body = (await r.json()).error;
    expect(r.headers.get("retry-after")).toBe("6");
    expect(body.retry_after_s).toBe(6); // the same number in the body
    expect(r.headers.get("x-ratelimit-reset")).toBe("60");
    expect(r.headers.get("ratelimit")).toBe('"analytics.export";r=0;t=60');
    expect(r.headers.get("ratelimit-policy")).toBe('"analytics.export";q=10;w=60');
    expect(Number(r.headers.get("retry-after"))).toBeLessThanOrEqual(Number(r.headers.get("x-ratelimit-reset")));
  });

  it("two consecutive 429s do not escalate: the analytics policies have no penalty box, only the auth and webhook policies do", async () => {
    const { app, keys: [k] } = await keys(1);
    for (let i = 0; i < 10; i++) await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k });
    const a = await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k });
    const b = await app.request("/api/v1/analytics/export/rooms?limit=5", { headers: k });
    expect([a.status, b.status]).toEqual([429, 429]);
    expect(Number(b.headers.get("retry-after"))).toBeLessThanOrEqual(Number(a.headers.get("retry-after")));
    for (const id of ["analytics.read", "analytics.export", "analytics.workspace", "analytics.concurrency"]) expect(POLICY_MAP.get(id)!.penalty, id).toBeFalsy();
    for (const id of ["auth.login.ip", "auth.mfa.ip", "public.otp.verify"]) expect(POLICY_MAP.get(id)!.penalty, id).toBeTruthy();
  });
});
