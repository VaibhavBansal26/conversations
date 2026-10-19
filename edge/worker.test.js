// Run with: node --test edge/   (no dependencies; Workers globals are faked)
import test from "node:test";
import assert from "node:assert/strict";
import worker, { cacheKeyFor, toOrigin } from "./worker.js";

const env = { ORIGIN: "https://origin.test", EDGE_SECRET: "s3cret" };
const req = (path, init = {}) => new Request(`https://chat.example.com${path}`, init);

test("widget.js is cacheable; config only with key+origin; sessions and other paths never", () => {
  assert.equal(cacheKeyFor(req("/widget.js")).ttl, 300);
  assert.equal(cacheKeyFor(req("/public/widget/config")), null);
  const k1 = cacheKeyFor(req("/public/widget/config", { headers: { "x-api-key": "a", origin: "https://a.com" } }));
  const k2 = cacheKeyFor(req("/public/widget/config", { headers: { "x-api-key": "a", origin: "https://b.com" } }));
  assert.notEqual(k1.key, k2.key, "different Origin must not share a cache entry");
  assert.equal(cacheKeyFor(req("/public/widget/config", { headers: { "x-api-key": "a", origin: "https://a.com", "x-support-session": "t" } })), null);
  assert.equal(cacheKeyFor(req("/widget.js", { headers: { authorization: "Bearer x" } })), null);
  assert.equal(cacheKeyFor(req("/api/rooms")), null);
  assert.equal(cacheKeyFor(req("/widget.js", { method: "POST", body: "x" })), null);
});

test("origin request always carries our edge secret, overriding any client-supplied one", () => {
  const out = toOrigin(req("/api/x?y=1", { headers: { "x-edge-secret": "forged", "cf-connecting-ip": "1.2.3.4" } }), env);
  assert.equal(out.url, "https://origin.test/api/x?y=1");
  assert.equal(out.headers.get("x-edge-secret"), "s3cret");
});

test("cache hit skips the origin; miss fills the cache; non-200 is not cached", async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async (r) => store.get(r.url)?.clone(), put: async (r, res) => void store.set(r.url, res) } };
  let calls = 0;
  let status = 200;
  globalThis.fetch = async () => (calls++, new Response("js", { status }));
  const ctx = { waitUntil: (p) => p };
  const a = await worker.fetch(req("/widget.js"), env, ctx);
  assert.equal(a.headers.get("x-edge-cache"), "MISS");
  await new Promise((r) => setTimeout(r, 0));
  const b = await worker.fetch(req("/widget.js"), env, ctx);
  assert.equal(await b.text(), "js");
  assert.equal(calls, 1);
  store.clear();
  status = 429;
  await worker.fetch(req("/widget.js"), env, ctx);
  await worker.fetch(req("/widget.js"), env, ctx);
  assert.equal(calls, 3);
});
