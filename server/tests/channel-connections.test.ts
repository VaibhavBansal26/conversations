import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sendAgentMessage } from "../src/services/messages.js";
import { twilioSignature } from "../src/webhooks/signatures.js";
import { createApp } from "../src/app.js";
import type { Logger } from "../src/logger.js";
import { addMemberRaw, client, fullApp, makeCtx, mkRoom, seedWorkspace, setSettings, tokenFor, addSmsNumberRaw, addSenderRaw, messagesOf, type TestCtx } from "./helpers.js";

const SID = "AC" + "a1".repeat(16);
const TOKEN = "0123456789abcdef0123456789abcdef".replace(/0123/, "9f3a");
const SG_KEY = "SG.abcdefghijklmnop.qrstuvwxyz0123456789";
const BASE = "http://localhost:3000";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
type Handler = (c: Call) => Response | Promise<Response>;

/** Every provider call of the workspace connections goes through ctx.providers.fetchImpl: nothing in these tests can reach the network. */
function mockProviders(ctx: TestCtx, handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  ctx.providers.baseUrls = { twilio: "https://twilio.test", sendgrid: "https://sg.test" };
  ctx.providers.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { method: init?.method ?? "GET", url, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})), body: String(init?.body ?? "") };
    calls.push(call);
    const key = Object.keys(handlers).find((k) => {
      const [m, p] = k.split(" ") as [string, string];
      return m === call.method && url.includes(p);
    });
    if (!key) throw new Error(`unexpected provider call ${call.method} ${url}`);
    return await handlers[key]!(call);
  }) as typeof fetch;
  return calls;
}

const twilioOk: Record<string, Handler> = {
  [`GET /Accounts/${SID}.json`]: () => json(200, { sid: SID, friendly_name: "Acme Twilio", status: "active", type: "Full" }),
  [`GET /IncomingPhoneNumbers.json`]: () =>
    json(200, { incoming_phone_numbers: [{ sid: "PN1", phone_number: "+15550000001", friendly_name: "Main", capabilities: { sms: true } }, { sid: "PN2", phone_number: "+15550000002", friendly_name: "Voice only", capabilities: { sms: false } }] }),
  [`POST /Messages.json`]: () => json(201, { sid: "SM_OUT_1", status: "queued" }),
};

async function world(extraEnv: Record<string, string> = {}) {
  const f = await fullApp(extraEnv);
  const calls = mockProviders(f.ctx, { ...twilioOk });
  const put = (path: string, body: unknown, token = f.token) => f.http.put(path, body, token);
  return { ...f, calls, put };
}
const connectTwilio = (w: Awaited<ReturnType<typeof world>>) => w.put("/api/channels/sms/connection", { account_sid: SID, auth_token: TOKEN });

describe("connecting Twilio", () => {
  it("stores credentials encrypted and answers with masked hints only", async () => {
    const w = await world();
    const r = await connectTwilio(w);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ channel: "sms", provider: "twilio", status: "pending", masked: { account_sid: `AC…${SID.slice(-4)}`, auth_token: `…${TOKEN.slice(-4)}` } });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SID);
    const row = (await w.ctx.db.get<{ credentials_enc: string; meta: string }>("SELECT credentials_enc, meta FROM channel_connections"))!;
    expect(row.credentials_enc.startsWith("enc2.")).toBe(true);
    expect(row.credentials_enc + row.meta).not.toContain(TOKEN);
    const list = await w.http.get("/api/channels/connections", w.token);
    expect(JSON.stringify(list.body)).not.toContain(TOKEN);
    expect(list.body.sms.webhooks.sms).toMatch(new RegExp(`^${BASE}/webhooks/c/wh_[\\w-]+/twilio/sms$`));
    expect(list.body.sms.webhooks.status).toMatch(/\/twilio\/status$/);
  });

  it("validates the shape before storing anything", async () => {
    const w = await world();
    expect((await w.put("/api/channels/sms/connection", { account_sid: "nope", auth_token: TOKEN })).status).toBe(400);
    expect((await w.put("/api/channels/sms/connection", { account_sid: SID, auth_token: "x" })).status).toBe(400);
    expect((await w.put("/api/channels/sms/connection", { account_sid: SID, auth_token: TOKEN, api_key_sid: "SK" + "b2".repeat(16) })).status).toBe(422);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM channel_connections")).toEqual({ n: 0 });
  });

  it("refuses sends until the credentials are verified, and never falls back to the platform provider", async () => {
    const w = await world();
    await addSmsNumberRaw(w.ctx, w.wsId, "+15550000001", true);
    const { room } = await mkRoom(w.ctx, w.wsId, { contact: { name: "T", phone: "+14155552671" } });
    await connectTwilio(w);
    const r = await sendAgentMessage(w.ctx, w.owner, room.id, { kind: "text", source: "sms", content: "hi" });
    expect(r.message.delivery).toBe("failed");
    expect(r.message.failure_reason).toMatch(/not usable for this workspace.*not been verified/);
    expect(w.ctx.sms.sent).toHaveLength(0); // the platform's fake provider was not used
    expect(w.calls.filter((c) => c.url.includes("/Messages.json"))).toHaveLength(0);
    const st = await w.http.get("/api/channels/status", w.token);
    expect(st.body.sms).toMatchObject({ mode: "attention", connected: false, source: "workspace" });
  });
});

describe("verifying Twilio credentials", () => {
  it("makes read-only calls, marks the connection verified, and warns about trial accounts", async () => {
    const w = await world();
    mockProviders(w.ctx, { ...twilioOk, [`GET /Accounts/${SID}.json`]: () => json(200, { sid: SID, friendly_name: "Trialco", status: "active", type: "Trial" }) });
    await connectTwilio(w);
    const r = await w.http.post("/api/channels/sms/verify", {}, w.token);
    expect(r.status).toBe(200);
    expect(r.body.connection).toMatchObject({ status: "verified", account: { friendly_name: "Trialco", type: "Trial", status: "active" } });
    expect(r.body.warnings.join(" ")).toMatch(/trial account/i);
    const st = await w.http.get("/api/channels/status", w.token);
    expect(st.body.sms).toMatchObject({ mode: "live", connected: true, provider: "twilio", source: "workspace" });
  });

  it("uses Basic auth with the account SID and token (or the API key when given)", async () => {
    const w = await world();
    const calls = mockProviders(w.ctx, { ...twilioOk });
    await connectTwilio(w);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    expect(calls[0]!.headers.Authorization).toBe("Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"));
    expect(calls[0]!.method).toBe("GET");
    const SK = "SK" + "c3".repeat(16);
    await w.put("/api/channels/sms/connection", { account_sid: SID, auth_token: TOKEN, api_key_sid: SK, api_key_secret: "secretsecretsecret1234" });
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    expect(calls.at(-1)!.headers.Authorization).toBe("Basic " + Buffer.from(`${SK}:secretsecretsecret1234`).toString("base64"));
  });

  it("maps bad credentials to a fix-it message and stops sending", async () => {
    const w = await world();
    mockProviders(w.ctx, { [`GET /Accounts/${SID}.json`]: () => json(401, { code: 20003, message: "Authenticate", status: 401 }) });
    await connectTwilio(w);
    const r = await w.http.post("/api/channels/sms/verify", {}, w.token);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: "CHANNEL_AUTH_FAILED" });
    expect(r.body.error.message).toMatch(/Account SID \/ Auth Token/);
    const st = await w.http.get("/api/channels/status", w.token);
    expect(st.body.sms.mode).toBe("attention");
    expect(st.body.sms.summary).toMatch(/rejected the saved credentials/);
  });

  it("a suspended account is not accepted", async () => {
    const w = await world();
    mockProviders(w.ctx, { [`GET /Accounts/${SID}.json`]: () => json(200, { sid: SID, friendly_name: "X", status: "suspended", type: "Full" }) });
    await connectTwilio(w);
    const r = await w.http.post("/api/channels/sms/verify", {}, w.token);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("CHANNEL_ACCOUNT_SUSPENDED");
  });

  it("a timeout or outage says nothing about the credentials: status is unchanged and the error is a 502", async () => {
    const w = await world();
    await connectTwilio(w);
    mockProviders(w.ctx, twilioOk);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    mockProviders(w.ctx, {
      [`GET /Accounts/${SID}.json`]: () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
    });
    const r = await w.http.post("/api/channels/sms/verify", {}, w.token);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("CHANNEL_TIMEOUT");
    expect((await w.http.get("/api/channels/connections", w.token)).body.sms.status).toBe("verified");
  });

  it("rejects a malformed answer, and maps 429 and 5xx", async () => {
    const w = await world();
    await connectTwilio(w);
    mockProviders(w.ctx, { [`GET /Accounts/${SID}.json`]: () => json(200, { unexpected: true }) });
    expect((await w.http.post("/api/channels/sms/verify", {}, w.token)).body.error.code).toBe("CHANNEL_MALFORMED_RESPONSE");
    mockProviders(w.ctx, { [`GET /Accounts/${SID}.json`]: () => json(429, { code: 20429, message: "Too many requests" }) });
    const lim = await w.http.post("/api/channels/sms/verify", {}, w.token);
    expect(lim.status).toBe(429);
    expect(lim.body.error.code).toBe("CHANNEL_RATE_LIMITED");
    mockProviders(w.ctx, { [`GET /Accounts/${SID}.json`]: () => json(503, {}) });
    expect((await w.http.post("/api/channels/sms/verify", {}, w.token)).status).toBe(502);
  });
});

describe("sending through the workspace's own Twilio account", () => {
  async function ready() {
    const w = await world();
    await connectTwilio(w);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    await addSmsNumberRaw(w.ctx, w.wsId, "+15550000001", true);
    const { room } = await mkRoom(w.ctx, w.wsId, { contact: { name: "T", phone: "+14155552671" } });
    return { ...w, room };
  }

  it("sends with the workspace credentials and its own status callback, not the platform's", async () => {
    const w = await ready();
    const r = await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "hello" });
    expect(r.message).toMatchObject({ delivery: "sent", provider_message_id: "SM_OUT_1" });
    const send = w.calls.find((c) => c.url.includes("/Messages.json"))!;
    expect(send.url).toBe(`https://twilio.test/2010-04-01/Accounts/${SID}/Messages.json`);
    const hook = (await w.http.get("/api/channels/connections", w.token)).body.sms.webhooks.status as string;
    expect(send.body).toContain(encodeURIComponent(hook));
    expect(w.ctx.sms.sent).toHaveLength(0);
  });

  it.each([
    [400, 21608, "trial", "trial_restriction", false],
    [400, 21211, "invalid", "invalid_recipient", false],
    [402, undefined, "Insufficient funds", "insufficient_funds", false],
    [429, 20429, "slow", "rate_limited", true],
    [503, undefined, "down", "provider_error", true],
  ])("maps Twilio %i/%s to %s", async (status, code, message, mapped, retryable) => {
    const w = await ready();
    mockProviders(w.ctx, { ...twilioOk, "POST /Messages.json": () => json(status as number, { code, message }) });
    const r = await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "x" });
    expect(r.message.delivery).toBe("failed");
    const st = await w.http.get("/api/channels/status", w.token);
    expect(st.body.sms.last_error.code).toBe(mapped);
    const jobs = await w.ctx.db.all("SELECT 1 FROM jobs WHERE type = 'send_retry'");
    expect(jobs.length > 0).toBe(retryable);
  });

  it("a send that Twilio answers with 401 disables the connection until it is verified again", async () => {
    const w = await ready();
    mockProviders(w.ctx, { ...twilioOk, "POST /Messages.json": () => json(401, { code: 20003, message: "Authenticate" }) });
    await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "x" });
    expect((await w.http.get("/api/channels/connections", w.token)).body.sms.status).toBe("error");
    mockProviders(w.ctx, twilioOk);
    const again = await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "y" });
    expect(again.message.delivery).toBe("failed");
    expect(w.calls.length).toBeGreaterThan(0);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    const ok = await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "z" });
    expect(ok.message.delivery).toBe("sent");
  });

  it("fails closed when the stored credentials cannot be decrypted (key changed)", async () => {
    const w = await ready();
    (w.ctx.config as { JWT_SECRET: string }).JWT_SECRET = "another-secret-another-secret-another-secret";
    await w.ctx.providers.invalidate(w.wsId);
    const r = await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "x" });
    expect(r.message.delivery).toBe("failed");
    expect(r.message.failure_reason).toMatch(/cannot be decrypted/);
    expect(w.ctx.sms.sent).toHaveLength(0);
  });

  it("replacing credentials takes effect immediately (cache invalidated) and needs a fresh verification", async () => {
    const w = await ready();
    const T2 = "f".repeat(32);
    await w.put("/api/channels/sms/connection", { account_sid: SID, auth_token: T2 });
    const blocked = await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "x" });
    expect(blocked.message.delivery).toBe("failed");
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    const calls = mockProviders(w.ctx, twilioOk);
    await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "y" });
    expect(calls.find((c) => c.url.includes("/Messages.json"))!.headers.Authorization).toBe("Basic " + Buffer.from(`${SID}:${T2}`).toString("base64"));
  });

  it("disconnecting deletes the credentials and returns the workspace to the platform default", async () => {
    const w = await ready();
    expect((await w.http.call("DELETE", "/api/channels/sms/connection", { token: w.token })).status).toBe(204);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM channel_connections")).toEqual({ n: 0 });
    const r = await sendAgentMessage(w.ctx, w.owner, w.room.id, { kind: "text", source: "sms", content: "after" });
    expect(r.message.delivery).toBe("sent");
    expect(w.ctx.sms.sent).toHaveLength(1);
  });
});

describe("importing and owning numbers", () => {
  async function verified() {
    const w = await world();
    await connectTwilio(w);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    return w;
  }
  it("lists the account's numbers and imports only SMS-capable ones that Twilio lists", async () => {
    const w = await verified();
    const list = await w.http.get("/api/channels/sms/numbers", w.token);
    expect(list.body.data.map((n: { e164: string }) => n.e164)).toEqual(["+15550000001", "+15550000002"]);
    const r = await w.http.post("/api/channels/sms/numbers/import", { e164s: ["+15550000001", "+15550000002", "+15559999999"] }, w.token);
    expect(r.body.imported).toEqual(["+15550000001"]);
    expect(r.body.skipped).toEqual(
      expect.arrayContaining([
        { e164: "+15550000002", reason: "this number cannot send SMS" },
        { e164: "+15559999999", reason: "not on your Twilio account" },
      ]),
    );
    const again = await w.http.post("/api/channels/sms/numbers/import", { e164s: ["+15550000001"] }, w.token);
    expect(again.body.skipped).toEqual([{ e164: "+15550000001", reason: "already added" }]);
  });

  it("refuses to add by hand a number that is not on the connected account", async () => {
    const w = await world();
    mockProviders(w.ctx, { ...twilioOk, "GET /IncomingPhoneNumbers.json": () => json(200, { incoming_phone_numbers: [{ sid: "PN9", phone_number: "+14155552671", friendly_name: "Main", capabilities: { sms: true } }] }) });
    await connectTwilio(w);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    const r = await w.http.post("/api/sms-numbers", { e164: "+442071838750" }, w.token);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("NUMBER_NOT_OWNED");
    expect((await w.http.post("/api/sms-numbers", { e164: "(415) 555-2671" }, w.token)).status).toBe(201);
  });

  it("a number registered by another workspace is reported as already in use, never imported", async () => {
    const w = await verified();
    const other = await seedWorkspace(w.ctx, "Other");
    await addSmsNumberRaw(w.ctx, other.wsId, "+15550000001");
    const r = await w.http.post("/api/channels/sms/numbers/import", { e164s: ["+15550000001"] }, w.token);
    expect(r.body.imported).toEqual([]);
    expect(r.body.skipped[0].reason).toBe("already in use");
  });
});

describe("inbound Twilio webhooks per workspace", () => {
  async function two() {
    const w = await world();
    await connectTwilio(w);
    const hookA = ((await w.http.get("/api/channels/connections", w.token)).body.sms.webhooks.sms as string).replace(BASE, "");
    await addSmsNumberRaw(w.ctx, w.wsId, "+15550000001", true);
    // a second workspace with its own account
    const b = await seedWorkspace(w.ctx, "Beta");
    const tokB = await tokenFor(w.ctx, b.owner);
    const TOKEN_B = "b".repeat(32);
    await w.http.put("/api/channels/sms/connection", { account_sid: "AC" + "bb".repeat(16), auth_token: TOKEN_B }, tokB);
    const hookB = ((await w.http.get("/api/channels/connections", tokB)).body.sms.webhooks.sms as string).replace(BASE, "");
    await addSmsNumberRaw(w.ctx, b.wsId, "+15550000009", true);
    const post = (path: string, params: Record<string, string>, signWith: string | null) =>
      w.http.call("POST", path, {
        raw: new URLSearchParams(params).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", ...(signWith ? { "x-twilio-signature": twilioSignature(signWith, BASE + path, params) } : {}) },
      });
    return { ...w, hookA, hookB, TOKEN_B, post, b, tokB };
  }
  const sms = (to: string, sid = "SMW1") => ({ From: "+14155552671", To: to, Body: "hello there", MessageSid: sid });

  it("accepts a request signed with the workspace's own token and lands it in that workspace", async () => {
    const w = await two();
    const r = await w.post(w.hookA, sms("+15550000001"), TOKEN);
    expect(r.status).toBe(200);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM messages WHERE provider_message_id = 'SMW1' AND workspace_id = ?", w.wsId)).toEqual({ n: 1 });
  });

  it("rejects another workspace's token, the platform token, an unsigned request and an unknown id with the same 401", async () => {
    const w = await two();
    for (const [path, key] of [[w.hookA, w.TOKEN_B], [w.hookA, "platform-token"], [w.hookA, null], ["/webhooks/c/wh_unknown/twilio/sms", TOKEN]] as const) {
      const r = await w.post(path, sms("+15550000001", "SMX" + Math.random()), key);
      expect(r.status, `${path} ${key}`).toBe(401);
      expect(r.body.error.code).toBe("INVALID_SIGNATURE");
    }
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM messages WHERE source = 'sms'")).toEqual({ n: 0 });
  });

  it("a request signed for workspace B cannot be replayed against workspace A's URL (the URL is part of the signature)", async () => {
    const w = await two();
    const p = sms("+15550000009", "SMB1");
    const sig = twilioSignature(w.TOKEN_B, BASE + w.hookB, p);
    const r = await w.http.call("POST", w.hookA, { raw: new URLSearchParams(p).toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig } });
    expect(r.status).toBe(401);
  });

  it("ignores a text addressed to a number the workspace does not own, even when correctly signed", async () => {
    const w = await two();
    const r = await w.post(w.hookA, sms("+15550000009", "SMC1"), TOKEN);
    expect(r.status).toBe(200);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM messages WHERE provider_message_id = 'SMC1'")).toEqual({ n: 0 });
    const ev = await w.http.get("/api/channels/sms/events", w.token);
    expect(ev.body.data[0]).toMatchObject({ kind: "twilio_sms", outcome: "ignored" });
  });

  it("a replay of the same signed request is acknowledged once and stored once", async () => {
    const w = await two();
    const p = sms("+15550000001", "SMR1");
    expect((await w.post(w.hookA, p, TOKEN)).status).toBe(200);
    expect((await w.post(w.hookA, p, TOKEN)).status).toBe(200);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM messages WHERE provider_message_id = 'SMR1'")).toEqual({ n: 1 });
    const ev = await w.http.get("/api/channels/sms/events", w.token);
    expect(ev.body.data.map((e: { outcome: string }) => e.outcome)).toEqual(["duplicate", "processed"]);
  });

  it("status callbacks only touch the workspace's own messages", async () => {
    const w = await two();
    mockProviders(w.ctx, twilioOk);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    const { room } = await mkRoom(w.ctx, w.wsId, { contact: { name: "T", phone: "+14155552671" } });
    const m = (await sendAgentMessage(w.ctx, w.owner, room.id, { kind: "text", source: "sms", content: "x" })).message;
    const hookBStatus = w.hookB.replace("/twilio/sms", "/twilio/status");
    const hookAStatus = w.hookA.replace("/twilio/sms", "/twilio/status");
    const p = { MessageSid: m.provider_message_id!, MessageStatus: "delivered" };
    expect((await w.post(hookBStatus, p, w.TOKEN_B)).status).toBe(204);
    expect((await messagesOf(w.ctx, room.id)).find((x) => x.id === m.id)!.delivery).toBe("sent"); // B cannot mark A's message
    expect((await w.post(hookAStatus, { ...p, MessageStatus: "delivered" }, TOKEN)).status).toBe(204);
  });

  it("repeated bad signatures escalate into an IP block", async () => {
    const w = await two();
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await w.post(w.hookA, sms("+15550000001", "SMZ" + i), "wrong")).status;
    expect(last).toBe(429);
  });
});

describe("SendGrid", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const sign = (ts: string, body: string) => createSign("sha256").update(ts + body).sign({ key: keys.privateKey, dsaEncoding: "der" }).toString("base64");
  const sgOk: Record<string, Handler> = {
    "GET /v3/scopes": () => json(200, { scopes: ["mail.send", "sender_verification_eligible"] }),
    "GET /v3/verified_senders": () => json(200, { results: [{ id: 1, from_email: "Support@Acme.test", from_name: "Acme", verified: true }, { id: 2, from_email: "x@acme.test", from_name: "X", verified: false }] }),
    "GET /v3/whitelabel/domains": () => json(200, [{ domain: "acme.test", valid: true }]),
    "POST /v3/mail/send": () => new Response(null, { status: 202, headers: { "x-message-id": "SGMSG1" } }),
  };
  async function sg() {
    const w = await fullApp();
    const calls = mockProviders(w.ctx, sgOk);
    const put = (b: object) => w.http.put("/api/channels/email/connection", b, w.token);
    return { ...w, calls, put };
  }

  it("verifies scopes, reports senders and domains, then imports verified senders", async () => {
    const w = await sg();
    const c = await w.put({ api_key: SG_KEY, inbound_domain: "Inbound.Acme.test" });
    expect(c.body).toMatchObject({ status: "pending", inbound_domain: "inbound.acme.test", masked: { api_key: `…${SG_KEY.slice(-4)}` } });
    expect(JSON.stringify(c.body)).not.toContain(SG_KEY);
    const v = await w.http.post("/api/channels/email/verify", {}, w.token);
    expect(v.body.connection).toMatchObject({ status: "verified", account: { scopes_ok: true, verified_senders: 1, domains: [{ domain: "acme.test", valid: true }] } });
    expect(w.calls[0]!.headers.Authorization).toBe(`Bearer ${SG_KEY}`);
    const imp = await w.http.post("/api/channels/email/senders/import", {}, w.token);
    expect(imp.body).toEqual({ added: 1, updated: 0, total_verified: 1 });
    expect((await w.http.get("/api/email-senders", w.token)).body.data[0]).toMatchObject({ address: "support@acme.test", verified: true, is_default: true });
  });

  it("rejects a key without Mail Send, a rejected key, and handles a restricted key", async () => {
    const w = await sg();
    await w.put({ api_key: SG_KEY });
    mockProviders(w.ctx, { ...sgOk, "GET /v3/scopes": () => json(200, { scopes: ["alerts.read"] }) });
    const r = await w.http.post("/api/channels/email/verify", {}, w.token);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("CHANNEL_PERMISSION_DENIED");
    mockProviders(w.ctx, { "GET /v3/scopes": () => json(401, { errors: [{ message: "The provided authorization grant is invalid" }] }) });
    expect((await w.http.post("/api/channels/email/verify", {}, w.token)).body.error.code).toBe("CHANNEL_AUTH_FAILED");
    mockProviders(w.ctx, { ...sgOk, "GET /v3/verified_senders": () => json(403, {}) });
    const ok = await w.http.post("/api/channels/email/verify", {}, w.token);
    expect(ok.status).toBe(200);
    expect(ok.body.warnings.join(" ")).toMatch(/cannot read Sender Authentication/);
    expect((await w.http.post("/api/channels/email/senders/import", {}, w.token)).body.error.code).toBe("CHANNEL_PERMISSION_DENIED");
  });

  it("sends through the workspace key and maps an unverified sender", async () => {
    const w = await sg();
    await w.put({ api_key: SG_KEY });
    await w.http.post("/api/channels/email/verify", {}, w.token);
    await addSenderRaw(w.ctx, w.wsId, "support@acme.test", true, true);
    const { room } = await mkRoom(w.ctx, w.wsId, { contact: { name: "P", email: "p@example.test" } });
    const ok = await sendAgentMessage(w.ctx, w.owner, room.id, { kind: "text", source: "email", content: "hi" });
    expect(ok.message).toMatchObject({ delivery: "sent", provider_message_id: "SGMSG1" });
    expect(w.ctx.email.sent).toHaveLength(0);
    mockProviders(w.ctx, { "POST /v3/mail/send": () => json(403, { errors: [{ message: "The from address does not match a verified Sender Identity." }] }) });
    const bad = await sendAgentMessage(w.ctx, w.owner, room.id, { kind: "text", source: "email", content: "again" });
    expect(bad.message.delivery).toBe("failed");
    const st = await w.http.get("/api/channels/status", w.token);
    expect(st.body.email.last_error.code).toBe("unverified_sender");
    expect(await w.ctx.db.all("SELECT 1 FROM jobs WHERE type = 'send_retry'")).toHaveLength(0);
  });

  describe("inbound webhooks", () => {
    async function hooks() {
      const w = await sg();
      await w.put({ api_key: SG_KEY });
      await w.http.post("/api/channels/email/verify", {}, w.token);
      await w.ctx.db.run("INSERT INTO inbound_addresses(address, workspace_id, created_at) VALUES ('help@acme.test', ?, ?)", w.wsId, w.ctx.clock().toISOString());
      const urls = (await w.http.get("/api/channels/connections", w.token)).body.email.webhooks as { inbound: string; events: string };
      const form = (url: string, fields: Record<string, string>) => {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.set(k, v);
        return w.http.call("POST", url.replace(BASE, ""), { form: fd });
      };
      return { ...w, urls, form };
    }
    const mail = { from: "Pat <pat@example.test>", to: "help@acme.test", subject: "Hello", text: "Need help", headers: "Message-ID: <abc@example.test>" };

    it("needs the connection's secret; a wrong secret, no secret, an unknown id and another workspace's secret are all 401", async () => {
      const w = await hooks();
      expect((await w.form(w.urls.inbound, mail)).status).toBe(200);
      const noSecret = w.urls.inbound.split("?")[0]!;
      expect((await w.form(noSecret, { ...mail, headers: "Message-ID: <n1@x>" })).status).toBe(401);
      expect((await w.form(noSecret + "?secret=wrong", { ...mail, headers: "Message-ID: <n2@x>" })).status).toBe(401);
      expect((await w.form(`${BASE}/webhooks/c/wh_nope/sendgrid/inbound?secret=x`, mail)).status).toBe(401);
      expect(await w.ctx.db.get("SELECT COUNT(*) n FROM messages WHERE source = 'email' AND sender_type = 'contact'")).toEqual({ n: 1 });
    });

    it("only delivers to this workspace's inbound addresses, and duplicates are acknowledged once", async () => {
      const w = await hooks();
      const other = await seedWorkspace(w.ctx, "Other");
      await w.ctx.db.run("INSERT INTO inbound_addresses(address, workspace_id, created_at) VALUES ('other@acme.test', ?, ?)", other.wsId, w.ctx.clock().toISOString());
      const r = await w.form(w.urls.inbound, { ...mail, to: "other@acme.test", headers: "Message-ID: <o1@x>" });
      expect(r.body.status).toBe("ignored");
      await w.form(w.urls.inbound, mail);
      const dup = await w.form(w.urls.inbound, mail);
      expect(dup.body.status).toBe("duplicate");
    });

    it("rotating the secret invalidates the old URL", async () => {
      const w = await hooks();
      const rot = await w.http.post("/api/channels/email/webhook-secret/rotate", {}, w.token);
      expect(rot.body.webhooks.inbound).not.toBe(w.urls.inbound);
      expect((await w.form(w.urls.inbound, { ...mail, headers: "Message-ID: <r1@x>" })).status).toBe(401);
      expect((await w.form(rot.body.webhooks.inbound, { ...mail, headers: "Message-ID: <r2@x>" })).status).toBe(200);
    });

    it("event webhook: verification key per workspace (valid, tampered, stale, replayed, wrong key)", async () => {
      const w = await hooks();
      await w.http.patch("/api/channels/email/connection", { event_public_key: pub }, w.token);
      const evUrl = w.urls.events.split("?")[0]!.replace(BASE, "");
      const post = (body: string, o: { ts?: string; sig?: string } = {}) => {
        const ts = o.ts ?? String(Math.floor(w.ctx.clock().getTime() / 1000));
        return w.http.call("POST", evUrl, { raw: body, headers: { "content-type": "application/json", "x-twilio-email-event-webhook-signature": o.sig ?? sign(ts, body), "x-twilio-email-event-webhook-timestamp": ts } });
      };
      const body = JSON.stringify([{ event: "delivered", sg_event_id: "E1", sg_message_id: "nomatch.filter" }]);
      const ts0 = String(Math.floor(w.ctx.clock().getTime() / 1000));
      const sig0 = sign(ts0, body);
      expect((await post(body, { ts: ts0, sig: sig0 })).status).toBe(200);
      expect((await post(body, { ts: ts0, sig: sig0 })).status).toBe(401); // the same signed request again
      expect((await post(body + " ", { ts: ts0, sig: sign(ts0, body) })).status).toBe(401); // tampered
      expect((await post(JSON.stringify([]), { ts: "1000" })).status).toBe(401); // stale
      const otherKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const forged = createSign("sha256").update("1" + "[]").sign({ key: otherKeys.privateKey, dsaEncoding: "der" }).toString("base64");
      expect((await post("[]", { sig: forged })).status).toBe(401);
      expect((await w.http.patch("/api/channels/email/connection", { event_public_key: "not a key" }, w.token)).status).toBe(422);
    });

    it("event webhook without a verification key falls back to the connection secret", async () => {
      const w = await hooks();
      const r = await w.http.call("POST", w.urls.events.replace(BASE, ""), { raw: "[]", headers: { "content-type": "application/json" } });
      expect(r.status).toBe(200);
      expect((await w.http.call("POST", w.urls.events.split("?")[0]!.replace(BASE, ""), { raw: "[]", headers: { "content-type": "application/json" } })).status).toBe(401);
    });
  });
});

describe("test sends, guards, permissions, audit", () => {
  it("sends a test text, rate limits at 10 an hour, and refuses when nothing is connected", async () => {
    const w = await world();
    const none = await w.http.post("/api/channels/sms/test", { to: "+14155552671" }, w.token);
    expect(none.status).toBe(422); // no number yet
    await addSmsNumberRaw(w.ctx, w.wsId, "+15550000001", true);
    const notConnected = await w.http.post("/api/channels/sms/test", { to: "+14155552671" }, w.token);
    expect(notConnected.status).toBe(200); // platform fake provider counts as a real one
    w.ctx.sms = Object.assign(Object.create(Object.getPrototypeOf(w.ctx.sms)), w.ctx.sms, { simulated: true });
    expect((await w.http.post("/api/channels/sms/test", { to: "+14155552671" }, w.token)).body.error.code).toBe("CHANNEL_NOT_CONNECTED");
    w.ctx.sms = Object.assign(Object.create(Object.getPrototypeOf(w.ctx.sms)), w.ctx.sms, { simulated: false });
    await connectTwilio(w);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    const ok = await w.http.post("/api/channels/sms/test", { to: "(415) 555-2671" }, w.token);
    expect(ok.body).toMatchObject({ ok: true, to: "+14155552671", from: "+15550000001", provider_message_id: "SM_OUT_1" });
    const sent = w.calls.filter((c) => c.url.includes("/Messages.json")).at(-1)!;
    expect(sent.body).toContain("Test+message+from");
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await w.http.post("/api/channels/sms/test", { to: "+14155552671" }, w.token)).status;
    expect(last).toBe(429);
  });

  it("test email needs a verified sender", async () => {
    const w = await fullApp();
    mockProviders(w.ctx, {
      "GET /v3/scopes": () => json(200, { scopes: ["mail.send"] }),
      "GET /v3/verified_senders": () => json(403, {}),
      "GET /v3/whitelabel/domains": () => json(403, {}),
      "POST /v3/mail/send": () => new Response(null, { status: 202, headers: { "x-message-id": "T1" } }),
    });
    await w.http.put("/api/channels/email/connection", { api_key: SG_KEY }, w.token);
    await w.http.post("/api/channels/email/verify", {}, w.token);
    expect((await w.http.post("/api/channels/email/test", { to: "me@example.test" }, w.token)).body.error.code).toBe("NO_VERIFIED_SENDER");
    await addSenderRaw(w.ctx, w.wsId, "support@acme.test", true, true);
    expect((await w.http.post("/api/channels/email/test", { to: "not-an-email" }, w.token)).status).toBe(422);
    const ok = await w.http.post("/api/channels/email/test", { to: "me@example.test" }, w.token);
    expect(ok.body).toMatchObject({ ok: true, from: "support@acme.test" });
  });

  it("only channels:manage may read or change connections; everyone may read the status", async () => {
    const w = await world();
    const agent = await addMemberRaw(w.ctx, w.wsId, { role: "agent" });
    const at = await tokenFor(w.ctx, agent);
    const app = client(createApp(w.ctx));
    expect((await app.get("/api/channels/connections", at)).status).toBe(403);
    expect((await app.put("/api/channels/sms/connection", { account_sid: SID, auth_token: TOKEN }, at)).status).toBe(403);
    expect((await app.post("/api/channels/sms/verify", {}, at)).status).toBe(403);
    expect((await app.post("/api/channels/sms/test", { to: "+14155552671" }, at)).status).toBe(403);
    expect((await app.get("/api/channels/status", at)).status).toBe(200);
    const manager = await addMemberRaw(w.ctx, w.wsId, { role: "manager" });
    expect((await app.get("/api/channels/connections", await tokenFor(w.ctx, manager))).status).toBe(200);
  });

  it("tenant isolation: another workspace never sees or uses a connection", async () => {
    const w = await world();
    await connectTwilio(w);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    const b = await seedWorkspace(w.ctx, "Beta");
    const tb = await tokenFor(w.ctx, b.owner);
    expect((await w.http.get("/api/channels/connections", tb)).body).toEqual({ sms: null, email: null });
    expect((await w.http.get("/api/channels/status", tb)).body.sms.source).toBe("platform");
    expect((await w.http.post("/api/channels/sms/verify", {}, tb)).status).toBe(404);
    expect((await w.http.call("DELETE", "/api/channels/sms/connection", { token: tb })).status).toBe(404);
    expect((await w.http.get("/api/channels/connections", w.token)).body.sms.status).toBe("verified");
  });

  it("writes audit entries without any credential", async () => {
    const w = await world();
    await connectTwilio(w);
    await w.http.post("/api/channels/sms/verify", {}, w.token);
    await addSmsNumberRaw(w.ctx, w.wsId, "+15550000001", true);
    await w.http.post("/api/channels/sms/test", { to: "+14155552671" }, w.token);
    await w.http.call("DELETE", "/api/channels/sms/connection", { token: w.token });
    const rows = await w.ctx.db.all<{ action: string; detail: string }>("SELECT action, detail FROM audit_log WHERE workspace_id = ? AND action LIKE 'channel.%' ORDER BY created_at, id", w.wsId);
    expect(rows.map((r) => r.action)).toEqual(["channel.connected", "channel.verified", "channel.test_sent", "channel.disconnected"]);
    const all = JSON.stringify(rows);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("4155552671");
  });

  it("never writes credentials to the logs", async () => {
    const lines: string[] = [];
    const capture: Logger = { debug: (m, f) => void lines.push(m + JSON.stringify(f ?? {})), info: (m, f) => void lines.push(m + JSON.stringify(f ?? {})), warn: (m, f) => void lines.push(m + JSON.stringify(f ?? {})), error: (m, f) => void lines.push(m + JSON.stringify(f ?? {})) } as Logger;
    const ctx = await makeCtx({}, { log: capture });
    const ws = await seedWorkspace(ctx);
    const app = client(createApp(ctx));
    const t = await tokenFor(ctx, ws.owner);
    mockProviders(ctx, { [`GET /Accounts/${SID}.json`]: () => json(401, { code: 20003, message: `Authenticate ${TOKEN}` }) });
    await app.put("/api/channels/sms/connection", { account_sid: SID, auth_token: TOKEN }, t);
    const bad = await app.post("/api/channels/sms/verify", {}, t);
    await setSettings(ctx, ws.wsId, {});
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(bad.body)).not.toContain(TOKEN);
  });

  it("Check webhook: the newest inbound events with their outcome, no content", async () => {
    const w = await world();
    await connectTwilio(w);
    expect((await w.http.get("/api/channels/sms/events", w.token)).body.data).toEqual([]);
    expect((await w.http.get("/api/channels/fax/events", w.token)).status).toBe(404);
  });
});
