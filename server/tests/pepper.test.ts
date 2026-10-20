import { createHash, createHmac, randomBytes } from "node:crypto";
import AjvPkg from "ajv";
import formatsPkg from "ajv-formats";
import { describe, expect, it } from "vitest";
import { pepperFingerprint, validatePepper } from "../src/analytics/pepperRules.js";
import { SCHEMAS } from "../src/analytics/schemas.js";
import { loadConfig } from "../src/config.js";
import { getPepper } from "../src/services/analytics.js";
import { dataKeys, decryptWithDataKey, encryptWithDataKey, parseDataKey } from "../src/util/dataCrypto.js";
import { encryptSecret } from "../src/util/totp.js";
import { addMemberRaw, fullApp, tokenFor } from "./helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: any = (AjvPkg as any).default ?? AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (formatsPkg as any).default ?? formatsPkg;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validShape = (body: unknown) => {
  const v = ajv.compile(SCHEMAS["identity-pepper"]!);
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
};

const hex = () => randomBytes(32).toString("hex");
const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("base64");
const V1 = "/api/v1/analytics/identity-pepper";
const ALIAS = "/api/analytics/identity-pepper";

describe("pepper rules", () => {
  it("accepts 32 random bytes as hex or base64 and any long random-looking string", () => {
    for (const ok of [hex(), randomBytes(32).toString("base64"), randomBytes(32).toString("base64url"), "correct-Horse_battery.staple/Zx9!qLm2#vB7kRt4", randomBytes(48).toString("hex")]) {
      expect(validatePepper(ok)).toBe(ok);
    }
  });
  it("refuses short, low-entropy, patterned, padded and non-string values with INVALID_PEPPER", () => {
    const bad: [unknown, RegExp][] = [
      [undefined, /string/],
      ["short", /at least 32/],
      [randomBytes(16).toString("hex"), /hex pepper must be at least 64/], // 32 characters but only 16 bytes
      ["a".repeat(64), /random enough/],
      ["abcd".repeat(16), /random enough/],
      ["0123456789abcdef".repeat(4), /random enough/],
      ["abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", /random enough/],
      [` ${hex()}`, /printable ASCII/],
      [`${hex()}\n`, /printable ASCII/],
      ["x".repeat(300), /at most 256/],
      [`enc2.${hex()}`, /enc2/],
    ];
    for (const [v, why] of bad) {
      try {
        validatePepper(v);
        throw new Error(`accepted ${String(v).slice(0, 20)}`);
      } catch (e) {
        expect((e as { code?: string }).code, String(e)).toBe("INVALID_PEPPER");
        expect((e as Error).message).toMatch(why);
      }
    }
  });
  it("the fingerprint is the first 8 hex characters of SHA-256 over the pepper", () => {
    const p = hex();
    expect(pepperFingerprint(p)).toBe(createHash("sha256").update(p).digest("hex").slice(0, 8));
    expect(pepperFingerprint(p)).toHaveLength(8);
  });
});

describe("pepper endpoints", () => {
  async function keyed(scopes: string[]) {
    const f = await fullApp();
    const created = await f.http.post("/api/v1/api-keys", { name: "k", scopes }, f.token);
    expect(created.status).toBe(201);
    return { ...f, key: created.body.key as string, bearer: { authorization: `Bearer ${created.body.key}` } };
  }

  it("one path, one shape: a session and a key with both scopes get the same document, with the fingerprint", async () => {
    const f = await keyed(["analytics:read", "analytics:export", "analytics_identity:manage"]);
    const session = await f.http.get(V1, f.token);
    const viaKey = await f.http.get(V1, undefined, f.bearer);
    const alias = await f.http.get(ALIAS, f.token);
    expect(session.status).toBe(200);
    for (const r of [session, viaKey, alias]) {
      validShape(r.body);
      expect(Object.keys(r.body).sort()).toEqual(["algorithm", "fingerprint", "pepper", "rotatedAt", "version"]);
      expect(r.body.algorithm).toBe("HMAC-SHA256");
      expect(r.body.fingerprint).toBe(pepperFingerprint(r.body.pepper));
    }
    expect(viaKey.body).toEqual(session.body);
    expect(alias.body).toEqual(session.body);
  });

  it("a key needs BOTH analytics:export and analytics_identity:manage, and can never change the pepper", async () => {
    const readOnly = await keyed(["analytics:read"]);
    expect((await readOnly.http.get(V1, undefined, readOnly.bearer)).body.error.code).toBe("INSUFFICIENT_SCOPE");
    const exportOnly = await keyed(["analytics:read", "analytics:export"]);
    expect((await exportOnly.http.get(V1, undefined, exportOnly.bearer)).body.error.code).toBe("INSUFFICIENT_SCOPE");
    const manageOnly = await keyed(["analytics:read", "analytics_identity:manage"]);
    expect((await manageOnly.http.get(V1, undefined, manageOnly.bearer)).body.error.code).toBe("INSUFFICIENT_SCOPE");
    const both = await keyed(["analytics:read", "analytics:export", "analytics_identity:manage"]);
    const put = await both.http.call("PUT", V1, { headers: both.bearer, json: { pepper: hex() } });
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe("SESSION_REQUIRED");
    expect((await both.http.call("POST", `${V1}/rotate`, { headers: both.bearer })).body.error.code).toBe("SESSION_REQUIRED");
  });

  it("a session needs the permission; an agent or a manager is refused, no credentials is a 401", async () => {
    const { ctx, http, wsId } = await fullApp();
    const agent = await tokenFor(ctx, await addMemberRaw(ctx, wsId, { role: "agent" }));
    const manager = await tokenFor(ctx, await addMemberRaw(ctx, wsId, { role: "manager" }));
    for (const t of [agent, manager]) {
      expect((await http.get(V1, t)).status).toBe(403);
      expect((await http.call("PUT", V1, { token: t, json: { pepper: hex() } })).status).toBe(403);
      expect((await http.get(ALIAS, t)).status).toBe(403);
    }
    expect((await http.get(V1)).status).toBe(401);
  });

  it("PUT imports a pepper: exports use it, version bumps, the same value is a no-op, the audit entry holds the fingerprint but never the pepper", async () => {
    const f = await keyed(["analytics:read", "analytics:export", "analytics_identity:manage"]);
    const { ctx, http, token } = f;
    const first = (await http.get(V1, token)).body;
    expect(first.version).toBe(1);
    const mine = randomBytes(32).toString("base64url");
    const set = await http.call("PUT", V1, { token, json: { pepper: mine, confirm: mine } });
    expect(set.status).toBe(200);
    validShape(set.body);
    expect(set.body).toMatchObject({ pepper: mine, version: 2, algorithm: "HMAC-SHA256", fingerprint: pepperFingerprint(mine) });
    expect((await http.get(ALIAS, token)).body.pepper).toBe(mine);
    // same value again: nothing changes
    const again = await http.call("PUT", V1, { token, json: { pepper: mine } });
    expect(again.body.version).toBe(2);
    expect(again.body.rotatedAt).toBe(set.body.rotatedAt);
    // the exports are keyed with it
    const { mkRoom } = await import("./helpers.js");
    await mkRoom(ctx, f.wsId, { contact: { name: "Pat", email: "pat@example.test" } });
    const now = ctx.clock().getTime();
    const range = `from=${new Date(now - 86400_000).toISOString()}&to=${new Date(now + 86400_000).toISOString()}`;
    const text = await (await f.app.request(`/api/v1/analytics/export/rooms?limit=50&${range}`, { headers: f.bearer })).text();
    const keys = text.trim().split("\n").map((l) => JSON.parse(l).contact_key);
    expect(keys).toContain(createHmac("sha256", mine).update("pat@example.test").digest("hex"));
    // audit: recorded, with the fingerprint and without the secret
    const audit = await ctx.db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit_log WHERE action LIKE 'analytics.pepper%'");
    expect(audit.map((a) => a.action)).toEqual(["analytics.pepper_set"]);
    expect(audit[0]!.detail).toContain(pepperFingerprint(mine));
    expect(JSON.stringify(audit)).not.toContain(mine);
    // and it is stored encrypted
    const row = await ctx.db.get<{ pepper_enc: string }>("SELECT pepper_enc FROM analytics_pepper");
    expect(row!.pepper_enc.startsWith("enc2.")).toBe(true);
    expect(row!.pepper_enc).not.toContain(mine);
  });

  it("PUT rejects bad input with a clean 400 and changes nothing", async () => {
    const { http, token } = await fullApp();
    const before = (await http.get(V1, token)).body;
    for (const body of [{}, { pepper: "tooshort" }, { pepper: "a".repeat(64) }, { pepper: randomBytes(16).toString("hex") }, { pepper: 42 }]) {
      const r = await http.call("PUT", V1, { token, json: body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const p = hex();
    const mismatch = await http.call("PUT", V1, { token, json: { pepper: p, confirm: hex() } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe("PEPPER_CONFIRM_MISMATCH");
    expect((await http.call("PUT", V1, { token, json: { pepper: "tooshort" } })).body.error.code).toBe("INVALID_PEPPER");
    expect((await http.get(V1, token)).body).toEqual(before);
  });

  it("rotate still generates a new random pepper, bumps the version and is audited", async () => {
    const { ctx, http, token } = await fullApp();
    const a = (await http.get(V1, token)).body;
    const r = await http.call("POST", `${V1}/rotate`, { token });
    expect(r.status).toBe(200);
    validShape(r.body);
    expect(r.body.pepper).not.toBe(a.pepper);
    expect(r.body.version).toBe(2);
    expect(r.body.fingerprint).toBe(pepperFingerprint(r.body.pepper));
    expect((await http.call("POST", "/api/analytics/identity-pepper/rotate", { token })).body.version).toBe(3); // the alias
    const n = await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'analytics.pepper_rotated'");
    expect(Number(n!.n)).toBe(2);
  });
});

describe("pepper encryption key", () => {
  it("DATA_ENCRYPTION_KEY: 64 hex or base64 of 32 bytes; anything else stops start-up", () => {
    expect(parseDataKey(KEY_A)?.length).toBe(32);
    expect(parseDataKey(KEY_B)?.length).toBe(32);
    expect(parseDataKey("short")).toBeNull();
    expect(() => loadConfig({ DATA_ENCRYPTION_KEY: "short" }, () => {})).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ DATA_ENCRYPTION_KEY: KEY_A, DATA_ENCRYPTION_KEY_PREVIOUS: "nope" }, () => {})).toThrow(/DATA_ENCRYPTION_KEY_PREVIOUS/);
    expect(loadConfig({ DATA_ENCRYPTION_KEY: KEY_A }, () => {}).DATA_ENCRYPTION_KEY).toBe(KEY_A);
  });

  it("warns when it is missing: derived in development, refused in production", () => {
    const warned: string[] = [];
    loadConfig({ NODE_ENV: "development" }, (m) => warned.push(m));
    expect(warned.join("\n")).toMatch(/DATA_ENCRYPTION_KEY not set: derived a development key/);
    const prod: string[] = [];
    loadConfig({ NODE_ENV: "production", JWT_SECRET: "x".repeat(32) }, (m) => prod.push(m));
    expect(prod.join("\n")).toMatch(/refused until it is configured/);
  });

  it("changing JWT_SECRET does not touch a pepper stored under DATA_ENCRYPTION_KEY", async () => {
    const f = await fullApp({ DATA_ENCRYPTION_KEY: KEY_A });
    const before = (await f.http.get(V1, f.token)).body;
    expect(before.pepper).toMatch(/^[0-9a-f]{64}$/);
    Object.assign(f.ctx.config, { JWT_SECRET: "a-completely-different-secret-value-1234" });
    // the session token was signed with the old secret, so ask the service directly (what the export path does)
    expect((await getPepper(f.ctx, f.wsId)).pepper).toBe(before.pepper);
  });

  it("a pepper written by the old code (JWT_SECRET-derived) is read once, re-encrypted under the data key, and survives a JWT_SECRET change afterwards", async () => {
    const f = await fullApp({ DATA_ENCRYPTION_KEY: KEY_A });
    const legacyPepper = hex();
    await f.ctx.db.run("DELETE FROM analytics_pepper");
    await f.ctx.db.run("INSERT INTO analytics_pepper(workspace_id, pepper_enc, version, rotated_at) VALUES (?,?,4,?)", f.wsId, encryptSecret(f.ctx.config.JWT_SECRET, legacyPepper), "2026-01-01T00:00:00.000Z");
    const got = await getPepper(f.ctx, f.wsId);
    expect(got).toMatchObject({ pepper: legacyPepper, version: 4, rotatedAt: "2026-01-01T00:00:00.000Z" }); // same value, version and date: the migration is invisible
    const row = await f.ctx.db.get<{ pepper_enc: string }>("SELECT pepper_enc FROM analytics_pepper");
    expect(row!.pepper_enc.startsWith("enc2.")).toBe(true);
    Object.assign(f.ctx.config, { JWT_SECRET: "a-completely-different-secret-value-1234" });
    expect((await getPepper(f.ctx, f.wsId)).pepper).toBe(legacyPepper);
  });

  it("rotating the data key: the previous key still decrypts and the row moves to the new key; without it the answer is 409 PEPPER_UNREADABLE, never a 500", async () => {
    const f = await fullApp({ DATA_ENCRYPTION_KEY: KEY_A });
    const pepper = (await f.http.get(V1, f.token)).body.pepper;
    Object.assign(f.ctx.config, { DATA_ENCRYPTION_KEY: KEY_B });
    // no previous key configured: the stored value is unreadable and says so
    const lost = await f.http.get(V1, f.token);
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe("PEPPER_UNREADABLE");
    expect(lost.body.error.message).not.toMatch(/Unsupported state|Decipher|auth tag/i);
    expect((await f.app.request("/api/v1/analytics/overview", { headers: {} })).status).toBe(401); // unrelated routes unaffected
    // with the previous key it is readable and gets re-encrypted
    Object.assign(f.ctx.config, { DATA_ENCRYPTION_KEY_PREVIOUS: KEY_A });
    expect((await f.http.get(V1, f.token)).body.pepper).toBe(pepper);
    Object.assign(f.ctx.config, { DATA_ENCRYPTION_KEY_PREVIOUS: undefined });
    expect((await f.http.get(V1, f.token)).body.pepper).toBe(pepper); // now under KEY_B alone
  });

  it("an unreadable pepper (a lost key) is recovered by setting a new one or rotating; exports answer 409 until then", async () => {
    const f = await fullApp({ DATA_ENCRYPTION_KEY: KEY_A });
    await f.http.get(V1, f.token);
    const created = await f.http.post("/api/v1/api-keys", { name: "k", scopes: ["analytics:read", "analytics:export"] }, f.token);
    const bearer = { authorization: `Bearer ${created.body.key}` };
    Object.assign(f.ctx.config, { DATA_ENCRYPTION_KEY: KEY_B });
    const exp = await f.app.request("/api/v1/analytics/export/rooms", { headers: bearer });
    expect(exp.status).toBe(409);
    expect((await exp.json()).error.code).toBe("PEPPER_UNREADABLE");
    expect((await f.http.get("/api/v1/analytics/overview", undefined, bearer)).status).toBe(409); // by-agent keys need the pepper too
    const mine = hex();
    expect((await f.http.call("PUT", V1, { token: f.token, json: { pepper: mine } })).body.pepper).toBe(mine);
    expect((await f.app.request("/api/v1/analytics/export/rooms", { headers: bearer })).status).toBe(200);
    // the same for rotate
    Object.assign(f.ctx.config, { DATA_ENCRYPTION_KEY: KEY_A });
    expect((await f.http.get(V1, f.token)).status).toBe(409);
    expect((await f.http.call("POST", `${V1}/rotate`, { token: f.token })).status).toBe(200);
  });

  it("production without DATA_ENCRYPTION_KEY refuses with a clear 503, and a ciphertext is bound to its workspace", async () => {
    const f = await fullApp({ DATA_ENCRYPTION_KEY: KEY_A });
    await f.http.get(V1, f.token);
    Object.assign(f.ctx.config, { DATA_ENCRYPTION_KEY: undefined, NODE_ENV: "production" });
    const r = await f.http.get(V1, f.token);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("DATA_ENCRYPTION_KEY_REQUIRED");
    expect(dataKeys({ NODE_ENV: "production", JWT_SECRET: "x".repeat(32) }).current).toBeNull();
    const c = { NODE_ENV: "test", JWT_SECRET: "x".repeat(32), DATA_ENCRYPTION_KEY: KEY_A };
    const blob = encryptWithDataKey(c, "secret-value", "pepper:ws_1");
    expect(decryptWithDataKey(c, blob, "pepper:ws_1")).toEqual({ plain: "secret-value", needsRewrite: false });
    expect(() => decryptWithDataKey(c, blob, "pepper:ws_2")).toThrow(/PEPPER_UNREADABLE|cannot be decrypted/);
  });
});
