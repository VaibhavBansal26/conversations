import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { twilioSignature, verifySendgridSignature, verifyTwilioSignature } from "../src/webhooks/signatures.js";
import { handleInboundEmail, handleSendgridEvents, parseAddress, parseHeaders } from "../src/services/inbound.js";
import { sendAgentMessage } from "../src/services/messages.js";
import { reconcileDeliveries } from "../src/jobs/scheduler.js";
import { setStatus } from "../src/services/rooms.js";
import { addInboundAddressRaw, addSenderRaw, addSmsNumberRaw, fullApp, messagesOf, mkInbox, mkRoom, roomRow } from "./helpers.js";

const URL_BASE = "http://localhost:3000";
const TOKEN = "twilio-auth-token";

describe("signature primitives", () => {
  it("matches the known-answer vector published in Twilio's client library tests", () => {
    const sig = twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
      CallSid: "CA1234567890ABCDE", From: "+14158675309", To: "+18005551212", Digits: "1234", Caller: "+14158675309",
    });
    expect(sig).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
  });
  it("verifies Twilio signatures and rejects tampering, missing headers and param reordering attacks", () => {
    const params = { From: "+1415", To: "+1555", Body: "hi" };
    const sig = twilioSignature(TOKEN, `${URL_BASE}/x`, params);
    expect(verifyTwilioSignature(TOKEN, `${URL_BASE}/x`, params, sig)).toBe(true);
    expect(verifyTwilioSignature(TOKEN, `${URL_BASE}/x`, { ...params, Body: "HI" }, sig)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, `${URL_BASE}/y`, params, sig)).toBe(false);
    expect(verifyTwilioSignature("other", `${URL_BASE}/x`, params, sig)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, `${URL_BASE}/x`, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, `${URL_BASE}/x`, { Body: "hi", To: "+1555", From: "+1415" }, sig)).toBe(true);
  });
  it("verifies SendGrid ECDSA signatures", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const sign = (ts: string, body: string) => createSign("sha256").update(ts + body).sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
    const sig = sign("1700000000", "[]");
    expect(verifySendgridSignature(pub, "[]", sig, "1700000000")).toBe(true);
    expect(verifySendgridSignature(pub, "[ ]", sig, "1700000000")).toBe(false);
    expect(verifySendgridSignature(pub, "[]", sig, "1700000001")).toBe(false);
    expect(verifySendgridSignature(pub, "[]", undefined, "1700000000")).toBe(false);
    expect(verifySendgridSignature("not-a-key", "[]", sig, "1700000000")).toBe(false);
  });
});

async function smsApp(extra: Record<string, string> = {}) {
  const f = await fullApp({ TWILIO_AUTH_TOKEN: TOKEN, ...extra });
  addSmsNumberRaw(f.ctx, f.wsId, "+15550000001", true);
  const post = (path: string, params: Record<string, string>, opts: { sign?: boolean; signature?: string } = {}) => {
    const sig = opts.signature ?? (opts.sign === false ? undefined : twilioSignature(TOKEN, URL_BASE + path, params));
    return f.http.call("POST", path, {
      raw: new URLSearchParams(params).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", ...(sig ? { "x-twilio-signature": sig } : {}) },
    });
  };
  return { ...f, post };
}
const inboundSms = (body: string, sid = "SM1", from = "+14155552671") => ({ From: from, To: "+15550000001", Body: body, MessageSid: sid });

describe("Twilio inbound SMS webhook", () => {
  it("creates contact + room + message for a signed request and answers with empty TwiML", async () => {
    const { ctx, post, wsId } = await smsApp();
    const res = await post("/webhooks/twilio/sms", inboundSms("Hi, is anyone there?"));
    expect(res.status).toBe(200);
    expect(res.body).toContain("<Response></Response>");
    const contact = ctx.db.get<{ id: string; phone: string; source: string }>("SELECT * FROM contacts WHERE workspace_id = ?", wsId)!;
    expect(contact).toMatchObject({ phone: "+14155552671", source: "sms" });
    const room = ctx.db.get<{ id: string; contact_id: string }>("SELECT * FROM rooms WHERE contact_id = ?", contact.id)!;
    const msg = messagesOf(ctx, room.id).find((m) => m.source === "sms")!;
    expect(msg).toMatchObject({ content: "Hi, is anyone there?", sender_type: "contact", provider_message_id: "SM1", from_addr: "+14155552671", to_addr: "+15550000001" });
    expect(ctx.db.all("SELECT from_addr, to_addr FROM message_locks WHERE room_id = ?", room.id)).toEqual([{ from_addr: "+15550000001", to_addr: "+14155552671" }]);
    await ctx.background.settle();
    expect(ctx.bus.ofType("message:new").some((e) => e.payload.message.content === "Hi, is anyone there?")).toBe(true);
  });
  it("rejects missing, invalid and replayed-with-modification signatures", async () => {
    const { ctx, post } = await smsApp();
    const p = inboundSms("hello");
    expect((await post("/webhooks/twilio/sms", p, { sign: false })).status).toBe(401);
    expect((await post("/webhooks/twilio/sms", p, { signature: "AAAA" })).body.error.code).toBe("INVALID_SIGNATURE");
    const sig = twilioSignature(TOKEN, URL_BASE + "/webhooks/twilio/sms", p);
    expect((await post("/webhooks/twilio/sms", { ...p, Body: "tampered" }, { signature: sig })).status).toBe(401);
    expect(ctx.db.get("SELECT COUNT(*) n FROM rooms")).toEqual({ n: 0 });
  });
  it("is idempotent on MessageSid (provider retries do not duplicate)", async () => {
    const { ctx, post } = await smsApp();
    await post("/webhooks/twilio/sms", inboundSms("once", "SMDUP"));
    const again = await post("/webhooks/twilio/sms", inboundSms("once", "SMDUP"));
    expect(again.status).toBe(200);
    expect(ctx.db.get("SELECT COUNT(*) n FROM messages WHERE provider_message_id = 'SMDUP'")).toEqual({ n: 1 });
  });
  it("routes by the (our number, contact) lock into the existing room and reopens it", async () => {
    const { ctx, post, owner, wsId } = await smsApp();
    const { room, contact } = mkRoom(ctx, wsId, { contact: { name: "Known", phone: "+14155552671" } });
    await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "sms", content: "hello" });
    setStatus(ctx, owner, room.id, "closed");
    expect(ctx.db.all("SELECT 1 FROM message_locks WHERE room_id = ?", room.id)).toHaveLength(0);
    await post("/webhooks/twilio/sms", inboundSms("I'm back", "SM2"));
    expect(roomRow(ctx, room.id).status).toBe("open");
    expect(ctx.db.get("SELECT COUNT(*) n FROM rooms WHERE contact_id = ?", contact.id)).toEqual({ n: 1 });
    expect(ctx.db.all("SELECT 1 FROM message_locks WHERE room_id = ?", room.id)).toHaveLength(1);
  });
  it("places new conversations in the default SMS inbox", async () => {
    const { ctx, post, owner } = await smsApp();
    const inbox = mkInbox(ctx, owner, { name: "SMS", default_sms_inbound: true });
    await post("/webhooks/twilio/sms", inboundSms("new here"));
    expect(ctx.db.get<{ inbox_id: string }>("SELECT inbox_id FROM rooms")!.inbox_id).toBe(inbox.id);
  });
  it("ignores unknown destination numbers and unparseable senders without error", async () => {
    const { ctx, post } = await smsApp();
    expect((await post("/webhooks/twilio/sms", { ...inboundSms("x"), To: "+19999999999" })).status).toBe(200);
    expect((await post("/webhooks/twilio/sms", inboundSms("x", "SM3", "garbage"))).status).toBe(200);
    expect(ctx.db.get("SELECT COUNT(*) n FROM messages WHERE source = 'sms'")).toEqual({ n: 0 });
  });
  it("validates required fields", async () => {
    const { post } = await smsApp();
    const bad = { From: "+1", To: "+2" };
    expect((await post("/webhooks/twilio/sms", bad as never)).status).toBe(400);
  });
  it("handles opt-out and opt-in keywords and blocks sends after STOP", async () => {
    const { ctx, post, owner, wsId } = await smsApp();
    const matrix: [string, boolean][] = [["STOP", true], ["start", false], [" Stop. ", true], ["Yes", false], ["UNSUBSCRIBE", true], ["unstop", false], ["QUIT!", true], ["END", false === false], ["please stop", false]];
    let n = 0;
    for (const [body, expectOptOut] of matrix) {
      await post("/webhooks/twilio/sms", inboundSms(body, `SMK${++n}`));
      const c = ctx.db.get<{ sms_opt_out: number }>("SELECT sms_opt_out FROM contacts WHERE phone = '+14155552671'")!;
      if (["STOP", " Stop. ", "UNSUBSCRIBE", "QUIT!", "END"].includes(body)) expect(!!c.sms_opt_out, body).toBe(true);
      if (["start", "Yes", "unstop"].includes(body)) expect(!!c.sms_opt_out, body).toBe(false);
      void expectOptOut;
    }
    await post("/webhooks/twilio/sms", inboundSms("STOP", "SMSTOP"));
    const room = ctx.db.get<{ id: string }>("SELECT id FROM rooms")!;
    await expect(sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "sms", content: "hi" })).rejects.toMatchObject({ code: "CONTACT_OPTED_OUT" });
    expect(messagesOf(ctx, room.id).some((m) => m.content.includes("opted out of SMS"))).toBe(true);
    await post("/webhooks/twilio/sms", inboundSms("START", "SMSTART"));
    expect((await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "sms", content: "welcome back" })).message.delivery).toBe("sent");
    expect(wsId).toBeTruthy();
  });
  it("an unknown number texting STOP is recorded as opted out", async () => {
    const { ctx, post } = await smsApp();
    await post("/webhooks/twilio/sms", inboundSms("STOP", "SMX", "+14155550123"));
    expect(ctx.db.get<{ sms_opt_out: number }>("SELECT sms_opt_out FROM contacts WHERE phone = '+14155550123'")!.sms_opt_out).toBe(1);
  });
  it("is rate limited", async () => {
    const { post } = await smsApp();
    let last = 0;
    for (let i = 0; i < 320; i++) last = (await post("/webhooks/twilio/sms", inboundSms("x", `SMR${i}`, "garbage"))).status;
    expect(last).toBe(429);
  });
  it("refuses unsigned webhooks in production when no auth token is configured, but not in dev", async () => {
    const prod = await fullApp({ NODE_ENV: "production", JWT_SECRET: "p".repeat(32) });
    const r = await prod.http.call("POST", "/webhooks/twilio/sms", { raw: "From=%2B1&To=%2B2&MessageSid=S", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.status).toBe(503);
    const dev = await fullApp();
    expect((await dev.http.call("POST", "/webhooks/twilio/sms", { raw: "From=%2B14155552671&To=%2B15550000009&MessageSid=S", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(200);
  });
});

describe("Twilio status callbacks and reconciliation", () => {
  async function sent() {
    const f = await smsApp();
    const { room } = mkRoom(f.ctx, f.wsId, { contact: { phone: "+14155552671" } });
    const m = (await sendAgentMessage(f.ctx, f.owner, room.id, { kind: "text", source: "sms", content: "status me" })).message;
    return { ...f, m };
  }
  it("marks delivered, never downgrades, and ignores duplicates and unknown ids", async () => {
    const { ctx, post, m } = await sent();
    const sid = m.provider_message_id!;
    await post("/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "delivered" });
    const row = () => ctx.db.get<{ delivery: string; delivered_at: string | null }>("SELECT delivery, delivered_at FROM messages WHERE id = ?", m.id)!;
    expect(row().delivery).toBe("delivered");
    expect(row().delivered_at).toBeTruthy();
    await post("/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "failed", ErrorCode: "30003" });
    expect(row().delivery).toBe("delivered");
    await post("/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "sent" });
    expect(row().delivery).toBe("delivered");
    expect((await post("/webhooks/twilio/status", { MessageSid: "unknown", MessageStatus: "delivered" })).status).toBe(204);
    expect((await post("/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "delivered" }, { sign: false })).status).toBe(401);
  });
  it("marks undelivered messages as failed with the carrier code", async () => {
    const { ctx, post, m } = await sent();
    ctx.bus.clear();
    await post("/webhooks/twilio/status", { MessageSid: m.provider_message_id!, MessageStatus: "undelivered", ErrorCode: "30003" });
    expect(ctx.db.get("SELECT delivery, failure_reason FROM messages WHERE id = ?", m.id)).toEqual({ delivery: "failed", failure_reason: "Carrier error 30003" });
    expect(ctx.bus.ofType("message:updated")).toHaveLength(1);
  });
  it("reconciliation asks the provider about messages that never got a callback", async () => {
    const { ctx, m } = await sent();
    ctx.sms.statuses.set(m.provider_message_id!, "delivered");
    expect(await reconcileDeliveries(ctx)).toBe(0); // too fresh
    ctx.clockCtl.advance(3 * 60_000);
    expect(await reconcileDeliveries(ctx)).toBe(1);
    expect(ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", m.id)!.delivery).toBe("delivered");
    expect(await reconcileDeliveries(ctx)).toBe(0);
  });
  it("reconciliation survives provider errors and skips providers without fetchStatus", async () => {
    const { ctx, m } = await sent();
    ctx.clockCtl.advance(5 * 60_000);
    ctx.sms.fetchStatus = async () => { throw new Error("down"); };
    expect(await reconcileDeliveries(ctx)).toBe(0);
    ctx.sms.fetchStatus = undefined as never;
    expect(await reconcileDeliveries(ctx)).toBe(0);
    expect(m.id).toBeTruthy();
  });
});

describe("SendGrid inbound parse", () => {
  async function mailApp(extra: Record<string, string> = {}) {
    const f = await fullApp({ WEBHOOK_SHARED_SECRET: "s3cret", ...extra });
    addInboundAddressRaw(f.ctx, f.wsId, "inbound@parse.acme.test");
    addSenderRaw(f.ctx, f.wsId, "support@acme.test", true, true);
    return f;
  }
  const mail = (o: Partial<{ from: string; to: string; subject: string; text: string; html: string; headers: string }> = {}) => ({
    from: "Pat Parker <pat@example.test>", to: "inbound@parse.acme.test", subject: "Where is my order?", text: "It has been a week.", headers: "Message-ID: <in1@example.test>\r\nSubject: x", ...o,
  });

  it("creates contact and room for an unknown sender, in the default email inbox, with threading ids stored", async () => {
    const { ctx, http, owner, wsId } = await mailApp();
    const inbox = mkInbox(ctx, owner, { name: "Email", default_email_inbound: true });
    const res = await http.call("POST", "/webhooks/sendgrid/inbound?secret=s3cret", { raw: new URLSearchParams(mail()).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.body.status).toBe("processed");
    const contact = ctx.db.get<{ id: string; name: string; email: string; source: string }>("SELECT * FROM contacts WHERE workspace_id = ?", wsId)!;
    expect(contact).toMatchObject({ name: "Pat Parker", email: "pat@example.test", source: "email" });
    const room = ctx.db.get<{ id: string; inbox_id: string; subject: string }>("SELECT * FROM rooms WHERE contact_id = ?", contact.id)!;
    expect(room).toMatchObject({ inbox_id: inbox.id, subject: "Where is my order?" });
    expect(messagesOf(ctx, room.id).find((m) => m.source === "email")).toMatchObject({ content: "It has been a week.", rfc_message_id: "<in1@example.test>", subject: "Where is my order?", sender_type: "contact" });
  });
  it("works as multipart form data too, and requires the shared secret", async () => {
    const { http } = await mailApp();
    const form = new FormData();
    for (const [k, v] of Object.entries(mail({ headers: "Message-ID: <in2@example.test>" }))) form.set(k, v);
    expect((await http.call("POST", "/webhooks/sendgrid/inbound?secret=s3cret", { form })).body.status).toBe("processed");
    const form2 = new FormData();
    for (const [k, v] of Object.entries(mail())) form2.set(k, v);
    expect((await http.call("POST", "/webhooks/sendgrid/inbound", { form: form2 })).status).toBe(401);
    expect((await http.call("POST", "/webhooks/sendgrid/inbound?secret=wrong", { form: form2 })).status).toBe(401);
    expect((await http.call("POST", "/webhooks/sendgrid/inbound", { form: form2, headers: { "x-webhook-secret": "s3cret" } })).body.status).toBe("processed");
    expect((await http.call("POST", "/webhooks/sendgrid/inbound", { form: form2, headers: { "x-webhook-secret": "s3cret" } })).body.status).toBe("duplicate");
  });
  it("matches a reply to its room by In-Reply-To / References, even from another address", async () => {
    const { ctx, owner, wsId } = await mailApp();
    const { room, contact } = mkRoom(ctx, wsId, { contact: { name: "Pat", email: "pat@example.test" } });
    const out = (await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "email", content: "Hello Pat" })).message;
    const r = handleInboundEmail(ctx, mail({ from: "pat.work@other.test", headers: `Message-ID: <r1@x>\r\nIn-Reply-To: ${out.rfc_message_id}\r\nReferences: <old@x> ${out.rfc_message_id}` }));
    expect(r).toMatchObject({ status: "processed", room_id: room.id });
    expect(ctx.db.get("SELECT COUNT(*) n FROM contacts WHERE email = 'pat.work@other.test'")).toEqual({ n: 0 });
    const viaRefs = handleInboundEmail(ctx, mail({ from: "pat.work@other.test", headers: `Message-ID: <r2@x>\r\nReferences: <old@x>\r\n ${out.rfc_message_id}` }));
    expect(viaRefs.room_id).toBe(room.id);
    expect(contact.id).toBeTruthy();
  });
  it("falls back to the (contact email, our sender) lock when headers do not match", async () => {
    const { ctx, owner, wsId } = await mailApp();
    const { room } = mkRoom(ctx, wsId, { contact: { name: "Pat", email: "pat@example.test" } });
    await sendAgentMessage(ctx, owner, room.id, { kind: "text", source: "email", content: "Hello" });
    const r = handleInboundEmail(ctx, mail({ headers: "Message-ID: <fresh@x>", subject: "Totally new subject" }));
    expect(r.room_id).toBe(room.id);
  });
  it("prefers the header match over the lock when they disagree", async () => {
    const { ctx, owner, wsId } = await mailApp();
    const a = mkRoom(ctx, wsId, { contact: { name: "A", email: "a@example.test" } });
    const b = mkRoom(ctx, wsId, { contact: { name: "B", email: "b@example.test" } });
    const outA = (await sendAgentMessage(ctx, owner, a.room.id, { kind: "text", source: "email", content: "to A" })).message;
    await sendAgentMessage(ctx, owner, b.room.id, { kind: "text", source: "email", content: "to B" });
    const r = handleInboundEmail(ctx, mail({ from: "b@example.test", headers: `Message-ID: <x1@x>\r\nIn-Reply-To: ${outA.rfc_message_id}` }));
    expect(r.room_id).toBe(a.room.id);
  });
  it("is idempotent on Message-ID, reopens closed rooms and sanitises html", async () => {
    const { ctx, owner, wsId } = await mailApp();
    const { room } = mkRoom(ctx, wsId, { contact: { name: "Pat", email: "pat@example.test" } });
    setStatus(ctx, owner, room.id, "closed");
    const first = handleInboundEmail(ctx, mail({ html: '<p onclick="x">Hi <b>you</b></p><script>alert(1)</script>', text: "" }));
    expect(first.status).toBe("processed");
    expect(roomRow(ctx, room.id).status).toBe("open");
    expect(messagesOf(ctx, room.id).pop()!.content).toBe("<p>Hi <b>you</b></p>");
    expect(handleInboundEmail(ctx, mail({ html: "<p>again</p>" })).status).toBe("duplicate");
  });
  it("ignores mail for unknown inbound addresses and unparseable senders", async () => {
    const { ctx } = await mailApp();
    expect(handleInboundEmail(ctx, mail({ to: "nobody@parse.acme.test" })).status).toBe("ignored");
    expect(handleInboundEmail(ctx, mail({ from: "garbage" })).status).toBe("ignored");
    expect(ctx.db.get("SELECT COUNT(*) n FROM rooms")).toEqual({ n: 0 });
  });
  it("parses addresses and folded headers", () => {
    expect(parseAddress('"Pat, P." <PAT@Example.test>')).toEqual({ address: "pat@example.test", name: "Pat, P." });
    expect(parseAddress("plain@example.test")).toEqual({ address: "plain@example.test", name: "" });
    expect(parseAddress("nope")).toBeNull();
    expect(parseHeaders("Message-ID: <a@b>\r\nReferences: <1@x>\r\n <2@x>\r\nBroken line")).toEqual({ "message-id": "<a@b>", references: "<1@x> <2@x>" });
  });
});

describe("SendGrid event webhook", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const sign = (ts: string, body: string) => createSign("sha256").update(ts + body).sign({ key: keys.privateKey, dsaEncoding: "der" }).toString("base64");

  async function evApp() {
    const f = await fullApp({ SENDGRID_WEBHOOK_PUBLIC_KEY: pub });
    addSenderRaw(f.ctx, f.wsId, "support@acme.test", true, true);
    const { room } = mkRoom(f.ctx, f.wsId, { contact: { name: "Pat", email: "pat@example.test" } });
    const m = (await sendAgentMessage(f.ctx, f.owner, room.id, { kind: "text", source: "email", content: "hello" })).message;
    const post = (events: unknown[], o: { ts?: string; sig?: string; body?: string } = {}) => {
      const body = o.body ?? JSON.stringify(events);
      const ts = o.ts ?? String(Math.floor(f.ctx.clock().getTime() / 1000));
      return f.http.call("POST", "/webhooks/sendgrid/events", {
        raw: body, headers: { "content-type": "application/json", "x-twilio-email-event-webhook-signature": o.sig ?? sign(ts, body), "x-twilio-email-event-webhook-timestamp": ts },
      });
    };
    return { ...f, room, m, post };
  }
  const ev = (m: { provider_message_id: string | null }, event: string, id: string, extra: object = {}) => ({ event, sg_event_id: id, sg_message_id: `${m.provider_message_id}.filter0001.1`, ...extra });

  it("accepts a valid signature, marks delivered and records opens as read receipts", async () => {
    const { ctx, m, post } = await evApp();
    ctx.bus.clear();
    const res = await post([ev(m, "delivered", "e1"), ev(m, "open", "e2")]);
    expect(res.body).toEqual({ processed: 2, ignored: 0 });
    expect(ctx.db.get<{ delivery: string; opened_at: string | null }>("SELECT delivery, opened_at FROM messages WHERE id = ?", m.id)).toMatchObject({ delivery: "delivered", opened_at: expect.any(String) });
    expect(ctx.bus.ofType("message:receipt").pop()!.payload).toMatchObject({ reader: { type: "contact" }, up_to_message_id: m.id, channel: "email_open" });
    const dto = ctx.bus.ofType("message:updated").pop()!.payload.message;
    expect(dto.read).toBe(true);
  });
  it("rejects tampered bodies, bad signatures and stale timestamps", async () => {
    const { ctx, m, post } = await evApp();
    const events = [ev(m, "delivered", "e1")];
    expect((await post(events, { body: JSON.stringify(events) + " " , sig: sign(String(Math.floor(ctx.clock().getTime() / 1000)), JSON.stringify(events)) })).status).toBe(401);
    expect((await post(events, { sig: "AAAA" })).body.error.code).toBe("INVALID_SIGNATURE");
    const staleTs = String(Math.floor(ctx.clock().getTime() / 1000) - 3600);
    const stale = await post(events, { ts: staleTs, sig: sign(staleTs, JSON.stringify(events)) });
    expect(stale.body.error.code).toBe("STALE_WEBHOOK");
    expect(ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", m.id)!.delivery).toBe("sent");
  });
  it("rejects a replayed request (same signature and timestamp) and is idempotent on event ids", async () => {
    const { ctx, m, post } = await evApp();
    const events = [ev(m, "delivered", "e1")];
    const ts = String(Math.floor(ctx.clock().getTime() / 1000));
    const sig = sign(ts, JSON.stringify(events));
    expect((await post(events, { ts, sig })).status).toBe(200);
    const replay = await post(events, { ts, sig });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REPLAYED_WEBHOOK");
    ctx.clockCtl.advance(1000);
    const again = await post(events); // fresh signature but same sg_event_id
    expect(again.body).toEqual({ processed: 0, ignored: 1 });
  });
  it("marks bounces and drops as failed (but never undoes delivered)", async () => {
    const { ctx, m, post } = await evApp();
    await post([ev(m, "bounce", "b1", { reason: "550 mailbox full" })]);
    expect(ctx.db.get("SELECT delivery, failure_reason FROM messages WHERE id = ?", m.id)).toEqual({ delivery: "failed", failure_reason: "550 mailbox full" });
    await post([ev(m, "delivered", "d1")]);
    expect(ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", m.id)!.delivery).toBe("delivered");
    await post([ev(m, "dropped", "d2")]);
    expect(ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", m.id)!.delivery).toBe("delivered");
  });
  it("matches by smtp-id when the provider id is unknown and ignores unmatched events", async () => {
    const { ctx, m } = await evApp();
    const r = handleSendgridEvents(ctx, [{ event: "delivered", sg_event_id: "z1", "smtp-id": m.rfc_message_id! }, { event: "delivered", sg_event_id: "z2", sg_message_id: "nope.filter" }, { sg_event_id: "z3" }, { event: "processed", sg_event_id: "z4", sg_message_id: `${m.provider_message_id}.f` }]);
    expect(r).toEqual({ processed: 1, ignored: 3 });
  });
  it("validates the payload shape", async () => {
    const { post } = await evApp();
    expect((await post([], { body: "not json" })).status).toBe(400);
    expect((await post([], { body: '{"a":1}' })).status).toBe(400);
  });
  it("falls back to the shared secret when no public key is configured", async () => {
    const f = await fullApp({ WEBHOOK_SHARED_SECRET: "fallback" });
    const body = JSON.stringify([]);
    expect((await f.http.call("POST", "/webhooks/sendgrid/events", { raw: body })).status).toBe(401);
    expect((await f.http.call("POST", "/webhooks/sendgrid/events?secret=fallback", { raw: body })).status).toBe(200);
  });
});
