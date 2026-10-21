import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importJWK, jwtVerify, decodeProtectedHeader } from "jose";
import { b64u, encryptPayload, generateVapidKeys, validVapid, vapidAuthorization } from "../src/push/webpush.js";
import { endpointAllowed, notifyPush } from "../src/push/service.js";
import { jobHandlers } from "../src/jobs/scheduler.js";
import { runDueJobs } from "../src/jobs/queue.js";
import { notifyContactMessage, notifyTicket } from "../src/services/notifications.js";
import { findMember, memberScope, updateMember } from "../src/services/members.js";
import { addMemberRaw, contactSays, fullApp, mkRoom, roomRow, setSettings, tokenFor } from "./helpers.js";

/* ---------- a fake push service: a real HTTP server that decrypts what it receives with the browser's private key ---------- */
const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const e = createECDH("prime256v1");
  e.setPrivateKey(uaPrivate);
  const uaPublic = e.getPublicKey();
  const prkKey = hmac(authSecret, e.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(pt[pt.length - 1]).toBe(2); // last-record delimiter
  return pt.subarray(0, pt.length - 1).toString();
}
interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  payload: any;
}
let fake: Server;
let fakeUrl = "";
const received: Received[] = [];
const statusFor = new Map<string, number>();
const browsers = new Map<string, { priv: Buffer; auth: Buffer }>();
/** a browser's subscription to the fake push service */
function browser(name: string) {
  const e = createECDH("prime256v1");
  e.generateKeys();
  const auth = randomBytes(16);
  browsers.set(name, { priv: e.getPrivateKey(), auth });
  return { endpoint: `${fakeUrl}/push/${name}`, keys: { p256dh: b64u.enc(e.getPublicKey()), auth: b64u.enc(auth) } };
}
beforeAll(async () => {
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const name = req.url!.split("/").pop()!;
      const b = browsers.get(name);
      const status = statusFor.get(name) ?? 201;
      if (b && status < 300) received.push({ path: req.url!, headers: req.headers, payload: JSON.parse(decrypt(Buffer.concat(chunks), b.priv, b.auth)) });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => fake.close(() => r())));

const VAPID = () => {
  const k = generateVapidKeys();
  return { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "mailto:ops@example.test", PUSH_ALLOWED_HOSTS: "127.0.0.1" };
};
const runJobs = async (ctx: any) => {
  for (let i = 0; i < 5; i++) await runDueJobs(ctx, jobHandlers);
};

describe("the protocol", () => {
  it("encrypts exactly like the worked example of RFC 8291 section 5", () => {
    const body = encryptPayload(Buffer.from("When I grow up, I want to be a watermelon"), "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg", {
      salt: b64u.dec("DGv6ra1nlYgDCS1FRnbzlw"),
      serverPrivateKey: b64u.dec("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
    });
    expect(b64u.enc(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    // and the browser side of the same example decrypts it
    expect(decrypt(body, b64u.dec("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), b64u.dec("BTBZMqHH6r4Tts7J_aSIgg"))).toBe("When I grow up, I want to be a watermelon");
  });
  it("a fresh random salt and key every time; refuses bad keys and oversize payloads", () => {
    const b = { ...browser("x").keys };
    const one = encryptPayload(Buffer.from("hi"), b.p256dh, b.auth);
    const two = encryptPayload(Buffer.from("hi"), b.p256dh, b.auth);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(() => encryptPayload(Buffer.from("hi"), b64u.enc(randomBytes(33)), b.auth)).toThrow(/uncompressed/);
    expect(() => encryptPayload(Buffer.from("hi"), b.p256dh, b64u.enc(randomBytes(8)))).toThrow(/16 bytes/);
    expect(() => encryptPayload(Buffer.alloc(5000), b.p256dh, b.auth)).toThrow(/too large/);
  });
  it("VAPID: an ES256 JWT for the push service's origin, valid at most 12 hours, verifiable with the public key", async () => {
    const k = { ...generateVapidKeys(), subject: "mailto:ops@example.test" };
    expect(validVapid(k)).toBe(true);
    expect(validVapid({ ...k, publicKey: generateVapidKeys().publicKey })).toBe(false);
    expect(validVapid({ ...k, subject: "ops@example.test" })).toBe(false);
    const now = new Date("2026-10-21T10:00:00Z");
    const h = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", k, now);
    const [, t, kk] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(kk).toBe(k.publicKey);
    expect(decodeProtectedHeader(t!)).toMatchObject({ alg: "ES256", typ: "JWT" });
    const pub = b64u.dec(k.publicKey);
    const key = await importJWK({ kty: "EC", crv: "P-256", x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33)) }, "ES256");
    const { payload } = await jwtVerify(t!, key, { currentDate: now, audience: "https://fcm.googleapis.com" });
    expect(payload.sub).toBe("mailto:ops@example.test");
    expect(payload.exp! - now.getTime() / 1000).toBeLessThanOrEqual(12 * 3600);
  });
});

describe("devices", () => {
  it("off without VAPID keys: the config says why and subscribing is refused", async () => {
    const f = await fullApp();
    expect((await f.http.call("GET", "/api/push/config", { token: f.token })).body).toMatchObject({ enabled: false, public_key: null, reason: "not_configured" });
    expect((await f.http.call("POST", "/api/push/subscriptions", { token: f.token, json: { subscription: browser("a") } })).body.error.code).toBe("PUSH_NOT_CONFIGURED");
    const bad = await fullApp({ VAPID_PUBLIC_KEY: generateVapidKeys().publicKey, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey, VAPID_SUBJECT: "mailto:a@b.test" });
    expect((await bad.http.call("GET", "/api/push/config", { token: bad.token })).body).toMatchObject({ enabled: false, reason: "invalid_keys" });
  });

  it("subscribe, list (the push service host only, never the endpoint), change events, test, delete; only your own devices", async () => {
    const env = VAPID();
    const f = await fullApp(env);
    const cfg = (await f.http.call("GET", "/api/push/config", { token: f.token })).body;
    expect(cfg).toMatchObject({ enabled: true, public_key: env.VAPID_PUBLIC_KEY, events: ["missed_call", "assigned", "message"] });
    const sub = browser("laptop");
    const made = await f.http.call("POST", "/api/push/subscriptions", { token: f.token, json: { subscription: sub, label: "Work laptop" }, headers: { "user-agent": "TestBrowser/1" } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ label: "Work laptop", push_service: new URL(fakeUrl).host, events: ["missed_call", "assigned", "message"], user_agent: "TestBrowser/1" });
    const list = await f.http.call("GET", "/api/push/subscriptions", { token: f.token });
    expect(JSON.stringify(list.body)).not.toContain("/push/laptop");
    expect(JSON.stringify(list.body)).not.toContain(sub.keys.auth);
    expect(list.body.config.previews).toBe(false);
    // the same browser again updates, it does not duplicate
    await f.http.call("POST", "/api/push/subscriptions", { token: f.token, json: { subscription: sub, label: "Laptop" } });
    expect((await f.http.call("GET", "/api/push/subscriptions", { token: f.token })).body.data).toHaveLength(1);
    const id = made.body.id;
    expect((await f.http.call("PATCH", `/api/push/subscriptions/${id}`, { token: f.token, json: { events: ["missed_call"] } })).body.events).toEqual(["missed_call"]);
    // test: the fake push service decrypts it
    const t = await f.http.call("POST", `/api/push/subscriptions/${id}/test`, { token: f.token });
    expect(t.body.result).toBe("sent");
    const got = received.filter((r) => r.path.endsWith("/laptop")).pop()!;
    expect(got.payload).toMatchObject({ title: "Test notification", url: "/settings/notifications", tag: "test" });
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(String(got.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    // another member, and another workspace, cannot see, test or delete it
    const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann" });
    const annTok = await tokenFor(f.ctx, ann);
    expect((await f.http.call("GET", "/api/push/subscriptions", { token: annTok })).body.data).toEqual([]);
    for (const [m, p] of [["POST", `/api/push/subscriptions/${id}/test`], ["DELETE", `/api/push/subscriptions/${id}`], ["PATCH", `/api/push/subscriptions/${id}`]] as const) expect((await f.http.call(m, p, { token: annTok, json: m === "PATCH" ? { label: "x" } : undefined })).status).toBe(404);
    expect((await f.http.call("DELETE", `/api/push/subscriptions/${id}`, { token: f.token })).status).toBe(200);
    expect((await f.http.call("GET", "/api/push/subscriptions", { token: f.token })).body.data).toEqual([]);
    const audit = (await f.ctx.db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit_log WHERE target = ?", id));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["push.subscribed", "push.unsubscribed"]));
    expect(JSON.stringify(audit)).not.toContain("/push/laptop");
  });

  it("refuses endpoints that are not push services (internal addresses, plain http elsewhere, credentials in the URL) and bad keys", async () => {
    const f = await fullApp({ ...VAPID(), PUSH_ALLOWED_HOSTS: "" });
    for (const endpoint of ["http://169.254.169.254/latest/meta-data", "https://evil.example.test/push", "http://fcm.googleapis.com/fcm/send/x", "https://user:pw@fcm.googleapis.com/x", "https://localhost/x"]) {
      const r = await f.http.call("POST", "/api/push/subscriptions", { token: f.token, json: { subscription: { ...browser("z"), endpoint } } });
      expect(r.body.error.code, endpoint).toBe("PUSH_ENDPOINT_NOT_ALLOWED");
    }
    expect(endpointAllowed(f.ctx, "https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(endpointAllowed(f.ctx, "https://web.push.apple.com/QAB")).toBe(true);
    expect(endpointAllowed(f.ctx, "https://db5p.notify.windows.com/w/?token=1")).toBe(true);
    expect(endpointAllowed(f.ctx, "https://notify.windows.com.evil.test/")).toBe(false);
    const g = await fullApp(VAPID());
    const bad = await g.http.call("POST", "/api/push/subscriptions", { token: g.token, json: { subscription: { endpoint: `${fakeUrl}/push/q`, keys: { p256dh: b64u.enc(randomBytes(65)), auth: b64u.enc(randomBytes(16)) } } } });
    expect(bad.body.error.code).toBe("INVALID_SUBSCRIPTION");
  });

  it("a subscription that expired (404 or 410) is removed; failures are counted and five in a row disable the device; the test button is rate-limited", async () => {
    const f = await fullApp(VAPID());
    const s1 = (await f.http.call("POST", "/api/push/subscriptions", { token: f.token, json: { subscription: browser("gone") } })).body;
    statusFor.set("gone", 410);
    expect((await f.http.call("POST", `/api/push/subscriptions/${s1.id}/test`, { token: f.token })).body.result).toBe("gone");
    expect(await f.ctx.db.get("SELECT 1 FROM push_subscriptions WHERE id = ?", s1.id)).toBeUndefined();
    const s2 = (await f.http.call("POST", "/api/push/subscriptions", { token: f.token, json: { subscription: browser("flaky") } })).body;
    statusFor.set("flaky", 400);
    for (let i = 0; i < 4; i++) await f.http.call("POST", `/api/push/subscriptions/${s2.id}/test`, { token: f.token });
    expect((await f.http.call("POST", `/api/push/subscriptions/${s2.id}/test`, { token: f.token })).status).toBe(429); // 5 tests in 10 minutes
    await notifyPush(f.ctx, (await findMember(f.ctx, f.wsId, f.owner.memberId))!, "missed_call", { title: "Missed call", body: "x", url: "/", tag: "call-z" });
    await runJobs(f.ctx);
    const row = await f.ctx.db.get<any>("SELECT failures, last_error, disabled_at FROM push_subscriptions WHERE id = ?", s2.id);
    expect(row).toMatchObject({ failures: 5, last_error: "http_400" });
    expect(row.disabled_at).not.toBeNull();
    expect(await notifyPush(f.ctx, (await findMember(f.ctx, f.wsId, f.owner.memberId))!, "missed_call", { title: "x", body: "x", url: "/", tag: "call-y" })).toBe(0); // a disabled device gets nothing
  });
});

describe("what is pushed, to whom, when", () => {
  async function world(over: Record<string, string> = {}) {
    const f = await fullApp({ ...VAPID(), ...over });
    const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann", email: "ann@acme.test" });
    const annTok = await tokenFor(f.ctx, ann);
    const name = `ann-${Math.random().toString(16).slice(2, 8)}`;
    const sub = (await f.http.call("POST", "/api/push/subscriptions", { token: annTok, json: { subscription: browser(name) } })).body;
    const mine = () => received.filter((r) => r.path.endsWith(`/${name}`));
    return { ...f, ann, annTok, sub, mine };
  }

  it("a customer message in a conversation assigned to me: pushed only while the app is closed, with no message text unless previews are on", async () => {
    const w = await world();
    const { room } = await mkRoom(w.ctx, w.wsId, { assignees: [w.ann] });
    // app open: nothing
    await w.ctx.presence.connect(memberScope(w.wsId), w.ann.memberId, "sock-ann");
    await notifyContactMessage(w.ctx, await roomRow(w.ctx, room.id), await contactSays(w.ctx, await roomRow(w.ctx, room.id), "My card number is 4111 and I am angry"));
    await runJobs(w.ctx);
    expect(w.mine()).toHaveLength(0);
    await w.ctx.presence.forceOffline(memberScope(w.wsId), w.ann.memberId);
    await notifyContactMessage(w.ctx, await roomRow(w.ctx, room.id), await contactSays(w.ctx, await roomRow(w.ctx, room.id), "Secret text that must not leave"));
    await runJobs(w.ctx);
    expect(w.mine()).toHaveLength(1);
    const p = w.mine()[0]!.payload;
    expect(p).toMatchObject({ title: "New customer message", url: `/inbox/${room.id}` });
    expect(JSON.stringify(p)).not.toContain("Secret");
    // previews on: the first words are included
    await setSettings(w.ctx, w.wsId, { push_message_previews: true });
    await w.ctx.cache.invalidate(`settings:${w.wsId}`);
    await notifyContactMessage(w.ctx, await roomRow(w.ctx, room.id), await contactSays(w.ctx, await roomRow(w.ctx, room.id), "Preview me please"));
    await runJobs(w.ctx);
    expect(JSON.stringify(w.mine().pop()!.payload)).toContain("Preview me please");
  });

  it("do-not-disturb and an unchosen event send nothing; an assignment is pushed with a link to the conversation", async () => {
    const w = await world();
    const { room } = await mkRoom(w.ctx, w.wsId, { assignees: [w.ann] });
    const m = (await findMember(w.ctx, w.wsId, w.ann.memberId))!;
    await updateMember(w.ctx, w.owner, w.ann.memberId, { dnd_until: new Date(w.ctx.clock().getTime() + 3600_000).toISOString() } as any);
    expect(await notifyPush(w.ctx, (await findMember(w.ctx, w.wsId, w.ann.memberId))!, "assigned", { title: "x", body: "y", url: "/", tag: "t1" })).toBe(0);
    await updateMember(w.ctx, w.owner, w.ann.memberId, { dnd_until: null } as any);
    await w.http.call("PATCH", `/api/push/subscriptions/${w.sub.id}`, { token: w.annTok, json: { events: ["missed_call"] } });
    expect(await notifyPush(w.ctx, m, "assigned", { title: "x", body: "y", url: "/", tag: "t2" })).toBe(0);
    await w.http.call("PATCH", `/api/push/subscriptions/${w.sub.id}`, { token: w.annTok, json: { events: ["assigned"] } });
    await notifyTicket(w.ctx, m, { type: "ticket_assigned", room: await roomRow(w.ctx, room.id), title: "Assigned to you: Refund for order 77", body: "x", email: false });
    await runJobs(w.ctx);
    expect(w.mine().pop()!.payload).toMatchObject({ title: "Assigned to you", url: `/inbox/${room.id}`, body: "A conversation was assigned to you." });
  });

  it("is rate-limited per member: a burst of messages is not a burst of notifications", async () => {
    const w = await world();
    const m = (await findMember(w.ctx, w.wsId, w.ann.memberId))!;
    let queued = 0;
    for (let i = 0; i < 40; i++) queued += await notifyPush(w.ctx, m, "assigned", { title: "x", body: "y", url: "/", tag: `burst-${i}` });
    expect(queued).toBe(30);
  });

  it("another workspace's member never receives this workspace's pushes, and a removed member's devices are cleaned up", async () => {
    const w = await world();
    const other = await fullApp(VAPID());
    const n = await notifyPush(other.ctx, (await findMember(other.ctx, other.wsId, other.owner.memberId))!, "assigned", { title: "x", body: "y", url: "/", tag: "iso" });
    expect(n).toBe(0);
    await w.ctx.db.run("UPDATE members SET removed_at = ? WHERE id = ?", w.ctx.clock().toISOString(), w.ann.memberId);
    await w.ctx.db.run("INSERT INTO jobs(id, type, payload, run_at, max_attempts, created_at, updated_at) VALUES ('job_x','push_send',?,?,3,?,?)", JSON.stringify({ subscription_id: w.sub.id, message: { title: "a", body: "b", url: "/", tag: "c" } }), w.ctx.clock().toISOString(), w.ctx.clock().toISOString(), w.ctx.clock().toISOString());
    await runJobs(w.ctx);
    expect(await w.ctx.db.get("SELECT 1 FROM push_subscriptions WHERE member_id = ?", w.ann.memberId)).toBeUndefined();
  });

  it("a push service that is down is retried by the queue, then succeeds", async () => {
    const w = await world();
    const name = w.sub.push_service && `retry-${Date.now()}`;
    const sub = (await w.http.call("POST", "/api/push/subscriptions", { token: w.annTok, json: { subscription: browser(name) } })).body;
    statusFor.set(name, 503);
    const m = (await findMember(w.ctx, w.wsId, w.ann.memberId))!;
    await notifyPush(w.ctx, m, "missed_call", { title: "Missed call", body: "Olivia called you.", url: "/team/x", tag: "call-1" });
    await runDueJobs(w.ctx, jobHandlers);
    expect((await w.ctx.db.get<any>("SELECT failures FROM push_subscriptions WHERE id = ?", sub.id)).failures).toBe(1);
    statusFor.delete(name);
    w.ctx.clockCtl.advance(10 * 60_000);
    await runJobs(w.ctx);
    expect(received.some((r) => r.path.endsWith(`/${name}`) && r.payload.title === "Missed call")).toBe(true);
  });
});
