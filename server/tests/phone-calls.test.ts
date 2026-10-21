import { describe, expect, it } from "vitest";
import { sweepCalls } from "../src/calls/service.js";
import { inQuietHours } from "../src/calls/phone.js";
import { connectTwilio, verifyConnection } from "../src/services/channelConnections.js";
import { twilioSignature } from "../src/webhooks/signatures.js";
import { addMemberRaw, addSmsNumberRaw, contactSays, fullApp, mkRoom, tokenFor, type TestCtx } from "./helpers.js";

const SID = "AC" + "c3".repeat(16);
const TOKEN = "7d1e" + "0123456789abcdef0123456789ab";
const VISITOR = "+14155552671";
const AGENT = "+14155550100";
const CALLER = "+14155550123";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Req {
  method: string;
  url: string;
  body: URLSearchParams;
  headers: Record<string, string>;
}
interface World {
  f: Awaited<ReturnType<typeof fullApp>>;
  ctx: TestCtx;
  reqs: Req[];
  room: { id: string };
  contact: { id: string };
  place: (body?: object, token?: string) => Promise<{ status: number; body: any }>;
  webhookId: string;
  setProvider: (h: (r: Req) => Response | Promise<Response>) => void;
}

/** a workspace with its own verified Twilio account (mocked), an imported caller ID, phone calls on, and a contact who agreed to be called */
async function world(o: { settings?: Record<string, unknown>; contact?: Record<string, unknown>; consent?: boolean | null; connect?: boolean; calls?: boolean } = {}): Promise<World> {
  const f = await fullApp({});
  const ctx = f.ctx as TestCtx;
  const reqs: Req[] = [];
  let provider: (r: Req) => Response | Promise<Response> = (r) => {
    if (r.url.endsWith("/Calls.json")) return json(201, { sid: `CA${"1".repeat(32)}`, status: "queued" });
    if (r.url.includes("/Calls/")) return json(200, { status: "completed" });
    if (r.url.endsWith(`/Accounts/${SID}.json`)) return json(200, { sid: SID, friendly_name: "x", status: "active", type: "Full" });
    if (r.url.includes("/IncomingPhoneNumbers.json")) return json(200, { incoming_phone_numbers: [] });
    return json(404, { message: "unexpected " + r.url });
  };
  ctx.providers.baseUrls = { twilio: "https://twilio.test" };
  ctx.providers.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Req = { method: init?.method ?? "GET", url: String(input), body: new URLSearchParams(String(init?.body ?? "")), headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) };
    const res = await Promise.resolve(provider(req));
    reqs.push(req);
    return res;
  }) as typeof fetch;
  if (o.connect !== false) {
    await connectTwilio(ctx, f.owner, { account_sid: SID, auth_token: TOKEN });
    await verifyConnection(ctx, f.owner, "sms");
  }
  await addSmsNumberRaw(ctx, f.wsId, CALLER, true);
  if (o.calls !== false) await f.http.patch("/api/calls/settings", { browser: { enabled: true }, phone: { enabled: true, caller_id: CALLER, allowed_countries: ["US"], ...(o.settings ?? {}) } }, f.token);
  const { contact, room } = await mkRoom(ctx, f.wsId, { contact: { name: "Visitor Vic", phone: VISITOR, ...(o.contact ?? {}) } });
  await contactSays(ctx, room, "Please call me");
  if (o.consent !== null) await ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ call_consent: { at: "2026-03-01T10:00:00.000Z", phone: o.consent === false ? "+14155559999" : VISITOR, text: "I agree" } }), contact.id);
  const row = (await ctx.db.get<{ webhook_id: string }>("SELECT webhook_id FROM channel_connections WHERE workspace_id = ?", f.wsId))?.webhook_id ?? "";
  return { f, ctx, reqs, room, contact, webhookId: row, place: (body = { agent_phone: AGENT }, token = f.token) => f.http.post(`/api/rooms/${room.id}/phone-call`, body, token), setProvider: (h) => (provider = h) };
}

/** a Twilio webhook, signed with the workspace's auth token over the exact URL the server expects */
async function hook(w: World, path: string, params: Record<string, string>, opts: { token?: string; webhookId?: string } = {}) {
  const full = `${w.ctx.config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/c/${opts.webhookId ?? w.webhookId}/twilio/voice/${path}`;
  const sig = twilioSignature(opts.token ?? TOKEN, full, params);
  return w.f.app.request(full.replace(w.ctx.config.PUBLIC_URL.replace(/\/$/, ""), ""), { method: "POST", headers: { "x-twilio-signature": sig, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
}
const callOf = (w: World, id: string) => w.ctx.db.get<any>("SELECT * FROM calls WHERE id = ?", id);
const AGENT_SID = `CA${"1".repeat(32)}`;
const VISITOR_SID = `CA${"2".repeat(32)}`;

/** place a call and return its id */
async function placed(w: World) {
  const r = await w.place();
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.call.id as string;
}
const cardText = (w: World) => w.ctx.db.get<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = ? AND meta LIKE '%\"sub_type\":\"call\"%'", w.room.id).then((m) => m?.content_text);

describe("click-to-call", () => {
  it("rings the agent through the workspace's own Twilio account, dials the visitor when the agent answers, and logs the call", async () => {
    const w = await world();
    const id = await placed(w);
    // the agent's leg: To is the agent's phone, From the caller ID, instructions and status come back to this workspace's webhook urls
    const create = w.reqs.find((r) => r.url.endsWith("/Calls.json"))!;
    expect(create.url).toBe(`https://twilio.test/2010-04-01/Accounts/${SID}/Calls.json`);
    expect(Object.fromEntries(create.body)).toMatchObject({ To: AGENT, From: CALLER, Method: "POST", StatusCallbackMethod: "POST", Timeout: "30" });
    expect(create.body.get("Url")).toBe(`${w.ctx.config.PUBLIC_URL}/webhooks/c/${w.webhookId}/twilio/voice/connect?call=${id}`);
    expect(create.body.get("StatusCallback")).toBe(`${w.ctx.config.PUBLIC_URL}/webhooks/c/${w.webhookId}/twilio/voice/status?call=${id}&leg=agent`);
    expect(create.body.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(create.headers["I-Twilio-Idempotency-Token"]).toBe(id);
    expect(create.headers.Authorization).toBe("Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"));
    expect(await cardText(w)).toBe("Phone call: calling the agent's phone");

    // the agent answers: Twilio asks for instructions
    const connect = await hook(w, `connect?call=${id}`, { CallSid: AGENT_SID, CallStatus: "in-progress" });
    expect(connect.status).toBe(200);
    expect(connect.headers.get("content-type")).toContain("text/xml");
    const twiml = await connect.text();
    expect(twiml).toContain(`<Dial callerId="${CALLER}" timeLimit="1800" timeout="45" answerOnBridge="true">`);
    expect(twiml).toContain(`>${VISITOR}</Number>`);
    expect(twiml).toContain(`status?call=${id}&amp;leg=visitor`);
    expect((await callOf(w, id)).state).toBe("connecting");
    expect(await cardText(w)).toBe("Phone call: calling the contact");

    // the visitor picks up, the call runs, the visitor hangs up first
    await hook(w, `status?call=${id}&leg=visitor`, { CallSid: VISITOR_SID, ParentCallSid: AGENT_SID, CallStatus: "in-progress", SequenceNumber: "2" });
    expect((await callOf(w, id)).state).toBe("active");
    w.ctx.clockCtl.advance(185_000);
    await hook(w, `status?call=${id}&leg=visitor`, { CallSid: VISITOR_SID, ParentCallSid: AGENT_SID, CallStatus: "completed", SequenceNumber: "3" });
    await hook(w, `status?call=${id}&leg=agent`, { CallSid: AGENT_SID, CallStatus: "completed", SequenceNumber: "4" });
    expect(await callOf(w, id)).toMatchObject({ state: "ended", ended_by: "visitor", end_reason: "completed", duration_s: 185, transport: "phone" });
    expect(await cardText(w)).toBe("Phone call, 3 min, ended by the visitor");
    const events = (await w.ctx.db.all<{ type: string; detail: string }>("SELECT type, detail FROM ticket_events WHERE ticket_id = (SELECT ticket_id FROM calls WHERE id = ?)", id)).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["call_started", "call_ended"]));
  });

  it("never records or logs full phone numbers: the audit trail, the ticket events and the call row keep the last four digits", async () => {
    const w = await world();
    const id = await placed(w);
    const audit = JSON.stringify(await w.ctx.db.all("SELECT detail FROM audit_log WHERE target = ?", id));
    const events = JSON.stringify(await w.ctx.db.all("SELECT detail FROM ticket_events"));
    const row = await callOf(w, id);
    for (const dump of [audit, events]) {
      expect(dump).not.toContain(VISITOR);
      expect(dump).not.toContain(AGENT);
    }
    expect(audit).toContain("2671");
    expect(row.meta).not.toContain(AGENT);
    expect(JSON.parse(row.meta)).toMatchObject({ agent_last4: "0100", visitor_last4: "2671" });
  });

  it("the agent hangs up: Twilio is told to end the agent's leg, only the seat that placed the call may, and a late connect is refused", async () => {
    const w = await world();
    const id = await placed(w);
    const mia = await addMemberRaw(w.ctx, w.f.wsId, { name: "Mia Manager", role: "manager" });
    expect((await w.f.http.post(`/api/calls/${id}/hangup`, {}, await tokenFor(w.ctx, mia))).status).toBe(403);
    const r = await w.f.http.post(`/api/calls/${id}/hangup`, {}, w.f.token);
    expect(r.status).toBe(200);
    expect(w.reqs.find((x) => x.url.endsWith(`/Calls/${AGENT_SID}.json`))!.body.get("Status")).toBe("completed");
    expect(await callOf(w, id)).toMatchObject({ state: "ended", ended_by: "agent", end_reason: "cancelled" });
    const late = await (await hook(w, `connect?call=${id}`, { CallSid: AGENT_SID, CallStatus: "in-progress" })).text();
    expect(late).toContain("no longer available");
    expect(late).toContain("<Hangup/>");
    expect((await w.f.http.post("/api/calls/call_nope/hangup", {}, w.f.token)).status).toBe(404);
  });

  it("outcomes of the visitor's phone: no answer is missed, busy is declined, unreachable is failed; the agent not answering fails the call", async () => {
    for (const [leg, status, state, reason] of [
      ["visitor", "no-answer", "missed", "no_answer"],
      ["visitor", "busy", "declined", "declined"],
      ["visitor", "failed", "failed", "visitor_unreachable"],
    ] as const) {
      const w = await world();
      const id = await placed(w);
      await hook(w, `connect?call=${id}`, { CallSid: AGENT_SID, CallStatus: "in-progress" });
      await hook(w, `status?call=${id}&leg=${leg}`, { CallSid: VISITOR_SID, ParentCallSid: AGENT_SID, CallStatus: status });
      expect(await callOf(w, id), status).toMatchObject({ state, end_reason: reason });
    }
    for (const status of ["no-answer", "busy", "failed"]) {
      const w = await world();
      const id = await placed(w);
      await hook(w, `status?call=${id}&leg=agent`, { CallSid: AGENT_SID, CallStatus: status });
      expect(await callOf(w, id), status).toMatchObject({ state: "failed", end_reason: status === "failed" ? "agent_unreachable" : "agent_no_answer" });
    }
  });

  it("repeated and out-of-order callbacks change nothing twice", async () => {
    const w = await world();
    const id = await placed(w);
    await hook(w, `connect?call=${id}`, { CallSid: AGENT_SID, CallStatus: "in-progress" });
    const answered = { CallSid: VISITOR_SID, ParentCallSid: AGENT_SID, CallStatus: "in-progress", SequenceNumber: "2" };
    await hook(w, `status?call=${id}&leg=visitor`, answered);
    await hook(w, `status?call=${id}&leg=visitor`, answered); // duplicate delivery
    // "completed" arrives before a late "in-progress"
    const done = { CallSid: VISITOR_SID, ParentCallSid: AGENT_SID, CallStatus: "completed", SequenceNumber: "3" };
    await hook(w, `status?call=${id}&leg=visitor`, done);
    await hook(w, `status?call=${id}&leg=visitor`, { ...answered, SequenceNumber: "9" });
    expect(await callOf(w, id)).toMatchObject({ state: "ended" });
    const cards = await w.ctx.db.all("SELECT id FROM messages WHERE room_id = ? AND meta LIKE '%\"sub_type\":\"call\"%'", w.room.id);
    expect(cards).toHaveLength(1);
  });
});

describe("what stops a call", () => {
  const refused = async (w: World, code: string, status: number, body?: object) => {
    const r = await w.place(body);
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(r.body.error.code).toBe(code);
    expect(w.reqs.some((x) => x.url.endsWith("/Calls.json"))).toBe(false); // Twilio was never asked
    expect(await w.ctx.db.get("SELECT 1 FROM calls WHERE state IN ('ringing','connecting','active')")).toBeUndefined();
  };

  it("switched off, no own Twilio account, no caller ID, no countries chosen", async () => {
    await refused(await world({ settings: { enabled: false } }), "PHONE_CALLS_DISABLED", 403);
    await refused(await world({ connect: false }), "NO_TWILIO", 409);
    const noCaller = await world({ calls: false });
    await noCaller.f.http.patch("/api/calls/settings", { phone: { enabled: true, allowed_countries: ["US"] } }, noCaller.f.token);
    await refused(noCaller, "NO_CALLER_ID", 409);
    await refused(await world({ settings: { allowed_countries: [] } }), "DESTINATION_BLOCKED", 422);
  });

  it("a contact without a number, without agreement, with an agreement for another number, or who opted out", async () => {
    await refused(await world({ contact: { phone: null } }), "CONTACT_NO_PHONE", 409);
    await refused(await world({ consent: null }), "NO_CALL_CONSENT", 409);
    await refused(await world({ consent: false }), "NO_CALL_CONSENT", 409);
    const w = await world();
    await w.ctx.db.run("UPDATE contacts SET sms_opt_out = 1 WHERE id = ?", w.contact.id);
    await refused(w, "DO_NOT_CALL", 409);
    const u = await world();
    await u.ctx.db.run("UPDATE contacts SET unsubscribed = 1 WHERE id = ?", u.contact.id);
    await refused(u, "DO_NOT_CALL", 409);
  });

  it("countries that are not allowed, and premium-rate numbers even in an allowed country", async () => {
    await refused(await world({ contact: { phone: "+442071234567" }, consent: null }).then(async (w) => (await w.ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ call_consent: { at: "x", phone: "+442071234567" } }), w.contact.id), w)), "DESTINATION_BLOCKED", 422);
    const p = await world({ settings: { allowed_countries: ["GB"] }, contact: { phone: "+449098765432" }, consent: null });
    await p.ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ call_consent: { at: "x", phone: "+449098765432" } }), p.contact.id);
    const r = await p.place();
    expect(r.body.error.code).toBe("DESTINATION_BLOCKED");
    expect(r.body.error.message).toMatch(/Premium-rate/);
  });

  it("night for the visitor in their own time zone, and an agent number that is wrong", async () => {
    const w = await world();
    await w.ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ call_consent: { at: "x", phone: VISITOR }, timezone: "Asia/Tokyo" }), w.contact.id);
    // 10:00 UTC is 19:00 in Tokyo: fine; at 13:30 UTC it is 22:30 there
    expect((await w.place()).status).toBe(200);
    const q = await world();
    await q.ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ call_consent: { at: "x", phone: VISITOR }, timezone: "Asia/Tokyo" }), q.contact.id);
    q.ctx.clockCtl.set("2026-03-02T13:30:00.000Z");
    const r = await q.place(undefined, await tokenFor(q.ctx, q.f.owner));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "QUIET_HOURS", details: { zone: "Asia/Tokyo" } });
    const bad = await world();
    await refused(bad, "INVALID_AGENT_PHONE", 422, { agent_phone: "12345" });
    await refused(bad, "INVALID_AGENT_PHONE", 422, { agent_phone: VISITOR });
  });

  it("quiet hours: wrap past midnight, edges, equal start and end, and zones", () => {
    const at = (iso: string) => new Date(iso);
    expect(inQuietHours("UTC", at("2026-03-02T22:00:00Z"), "21:00", "08:00")).toBe(true);
    expect(inQuietHours("UTC", at("2026-03-02T03:00:00Z"), "21:00", "08:00")).toBe(true);
    expect(inQuietHours("UTC", at("2026-03-02T08:00:00Z"), "21:00", "08:00")).toBe(false);
    expect(inQuietHours("UTC", at("2026-03-02T20:59:00Z"), "21:00", "08:00")).toBe(false);
    expect(inQuietHours("UTC", at("2026-03-02T12:00:00Z"), "13:00", "14:00")).toBe(false);
    expect(inQuietHours("UTC", at("2026-03-02T13:30:00Z"), "13:00", "14:00")).toBe(true);
    expect(inQuietHours("UTC", at("2026-03-02T13:30:00Z"), "09:00", "09:00")).toBe(false);
    expect(inQuietHours("America/Los_Angeles", at("2026-03-02T05:00:00Z"), "21:00", "08:00")).toBe(true); // 21:00 the evening before
    expect(inQuietHours("America/Los_Angeles", at("2026-03-02T17:00:00Z"), "21:00", "08:00")).toBe(false); // 09:00
  });

  it("the quiet-hours rule can be switched off", async () => {
    const w = await world({ settings: { quiet_hours: { enabled: false } } });
    w.ctx.clockCtl.set("2026-03-02T23:00:00.000Z");
    expect((await w.place(undefined, await tokenFor(w.ctx, w.f.owner))).status).toBe(200);
  });

  it("a team member may place only a few calls an hour", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) {
      const r = await w.place();
      expect(r.status, `call ${i}`).toBe(200);
      await w.f.http.post(`/api/calls/${r.body.call.id}/hangup`, {}, w.f.token);
    }
    const eleventh = await w.place();
    expect(eleventh.status).toBe(429);
    expect(w.reqs.filter((x) => x.url.endsWith("/Calls.json"))).toHaveLength(10);
  });

  it("the workspace's daily limit: counted per day, never exceeded under parallel requests, refused attempts do not count", async () => {
    const w = await world({ settings: { daily_limit: 2 } });
    const rooms = [{ room: w.room, contact: w.contact }];
    for (let i = 0; i < 3; i++) {
      const r = await mkRoom(w.ctx, w.f.wsId, { contact: { name: `Vic ${i}`, phone: `+1415555${2680 + i}` } });
      await contactSays(w.ctx, r.room, "hi");
      await w.ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ call_consent: { at: "x", phone: `+1415555${2680 + i}` } }), r.contact.id);
      rooms.push(r);
    }
    const results = await Promise.all(rooms.map((r) => w.f.http.post(`/api/rooms/${r.room.id}/phone-call`, { agent_phone: AGENT }, w.f.token)));
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeLessThanOrEqual(2);
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(w.reqs.filter((x) => x.url.endsWith("/Calls.json"))).toHaveLength(ok);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.body.error.code).toBe("DAILY_LIMIT");
    // sequentially: after the two are used a third is refused, and a new day starts at zero
    const w2 = await world({ settings: { daily_limit: 2 } });
    const placeIn = async (room: { id: string }) => w2.f.http.post(`/api/rooms/${room.id}/phone-call`, { agent_phone: AGENT }, w2.f.token);
    const made = [] as { id: string }[];
    for (let i = 0; i < 3; i++) {
      const r = await mkRoom(w2.ctx, w2.f.wsId, { contact: { name: `Seq ${i}`, phone: `+1415555${2700 + i}` } });
      await contactSays(w2.ctx, r.room, "hi");
      await w2.ctx.db.run("UPDATE contacts SET attrs = ? WHERE id = ?", JSON.stringify({ call_consent: { at: "x", phone: `+1415555${2700 + i}` } }), r.contact.id);
      made.push(r.room);
    }
    expect((await placeIn(made[0]!)).status).toBe(200);
    expect((await placeIn(made[1]!)).status).toBe(200);
    expect((await placeIn(made[2]!)).body.error.code).toBe("DAILY_LIMIT");
    expect((await w2.ctx.db.all("SELECT end_reason FROM calls WHERE end_reason LIKE 'guard:%'"))).toHaveLength(1);
    w2.ctx.clockCtl.advance(24 * 3600_000);
    w2.f.token = await tokenFor(w2.ctx, w2.f.owner);
    expect((await placeIn(made[2]!)).status).toBe(200);
  });

  it("one live call per conversation, also for phone calls, and a conversation without a ticket", async () => {
    const w = await world();
    await placed(w);
    expect((await w.place()).body.error.code).toBe("CALL_IN_PROGRESS");
    const q = await world();
    const bare = await mkRoom(q.ctx, q.f.wsId, { contact: { name: "Quiet", phone: "+14155552699" } });
    const r = await q.f.http.post(`/api/rooms/${bare.room.id}/phone-call`, { agent_phone: AGENT }, q.f.token);
    expect(r.body.error.code).toBe("NO_CONVERSATION");
  });
});

describe("Twilio failures", () => {
  it("a refusal from Twilio ends the call at once with a plain message, and the next call can start", async () => {
    const w = await world();
    w.setProvider(() => json(400, { code: 21215, message: "Geo Permission configuration is not permitting call" }));
    const r = await w.place();
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("PROVIDER_ERROR");
    expect(await w.ctx.db.get<any>("SELECT state, end_reason FROM calls")).toMatchObject({ state: "failed", end_reason: "provider_error" });
    expect(await cardText(w)).toBe("Phone call failed to connect");
    w.setProvider(() => json(201, { sid: AGENT_SID }));
    expect((await w.place()).status).toBe(200);
  });

  it("an agent who never answers is ended by the sweep, which also asks Twilio to hang up; a bridge that never completes fails too", async () => {
    const w = await world();
    const id = await placed(w);
    w.ctx.clockCtl.advance(44_000);
    expect(await sweepCalls(w.ctx)).toMatchObject({ failed: 0 });
    w.ctx.clockCtl.advance(2_000);
    expect(await sweepCalls(w.ctx)).toMatchObject({ failed: 1 });
    expect(await callOf(w, id)).toMatchObject({ state: "failed", end_reason: "agent_no_answer" });
    expect(w.reqs.some((x) => x.url.endsWith(`/Calls/${AGENT_SID}.json`))).toBe(true);
    const v = await world();
    const id2 = await placed(v);
    await hook(v, `connect?call=${id2}`, { CallSid: AGENT_SID, CallStatus: "in-progress" });
    v.ctx.clockCtl.advance(95_000);
    await sweepCalls(v.ctx);
    expect(await callOf(v, id2)).toMatchObject({ state: "failed", end_reason: "connect_timeout" });
  });

  it("a Twilio 'already completed' answer to a hang-up counts as done", async () => {
    const w = await world();
    const id = await placed(w);
    w.setProvider(() => json(400, { code: 21220, message: "Call is not in-progress" }));
    expect((await w.f.http.post(`/api/calls/${id}/hangup`, {}, w.f.token)).status).toBe(200);
  });
});

describe("webhook authentication", () => {
  it("a wrong signature, another workspace's token, an unknown connection and a missing call id are all refused alike, and change nothing", async () => {
    const w = await world();
    const id = await placed(w);
    const p = { CallSid: AGENT_SID, CallStatus: "in-progress" };
    expect((await hook(w, `connect?call=${id}`, p, { token: "wrong-token-wrong-token-wrong-token" })).status).toBe(401);
    expect((await hook(w, `connect?call=${id}`, p, { webhookId: "whk_unknown" })).status).toBe(401);
    expect((await hook(w, `status?call=${id}&leg=agent`, p, { token: "nope-nope-nope-nope-nope-nope" })).status).toBe(401);
    expect((await hook(w, "connect", p)).status).toBe(400);
    expect((await callOf(w, id)).state).toBe("ringing");
    // a workspace with its own account cannot drive another workspace's call, even with a valid signature of its own
    const other = await world();
    const mine = await hook(other, `connect?call=${id}`, p);
    expect(await mine.text()).toContain("no longer available");
    expect((await callOf(w, id)).state).toBe("ringing");
  });

  it("a status callback for a leg that is not this call's is ignored", async () => {
    const w = await world();
    const id = await placed(w);
    await hook(w, `connect?call=${id}`, { CallSid: AGENT_SID, CallStatus: "in-progress" });
    await hook(w, `status?call=${id}&leg=visitor`, { CallSid: VISITOR_SID, ParentCallSid: `CA${"9".repeat(32)}`, CallStatus: "completed" });
    expect((await callOf(w, id)).state).toBe("connecting");
    await hook(w, `status?call=${id}&leg=agent`, { CallSid: `CA${"8".repeat(32)}`, CallStatus: "completed" });
    expect((await callOf(w, id)).state).toBe("connecting");
  });
});

describe("consent and the callback form", () => {
  it("asking for consent puts a card with the number to confirm and a consent line; agreeing records it for that number and the visitor's time zone", async () => {
    const w = await world({ consent: null });
    expect((await w.place()).body.error.code).toBe("NO_CALL_CONSENT");
    const ask = await w.f.http.post(`/api/rooms/${w.room.id}/phone-call/consent`, {}, w.f.token);
    expect(ask.body).toEqual({ asked: true });
    const msg = await w.ctx.db.get<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE room_id = ? AND meta LIKE '%contact_form%' ORDER BY seq DESC", w.room.id);
    const card = JSON.parse(msg!.meta).card;
    expect(card.consent.text).toBe("I agree that you may call me on this number.");
    expect(card.fields).toEqual([expect.objectContaining({ key: "phone", required: true, prefill: VISITOR })]);
    // the visitor session of this contact
    const { createToken, createSession } = await import("../src/services/visitors.js");
    void createToken; void createSession;
    // without ticking the box nothing is stored
    const sess = await visitorSessionFor(w);
    const refused = await w.f.http.post(`/public/rooms/${w.room.id}/forms/${msg!.id}`, { values: { phone: VISITOR }, consent: false }, undefined, sess.headers);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.errors.consent).toBeTruthy();
    const ok = await w.f.http.post(`/public/rooms/${w.room.id}/forms/${msg!.id}`, { values: { phone: VISITOR }, consent: true, timezone: "Europe/Berlin" }, undefined, sess.headers);
    expect(ok.status).toBe(200);
    const attrs = JSON.parse((await w.ctx.db.get<{ attrs: string }>("SELECT attrs FROM contacts WHERE id = ?", w.contact.id))!.attrs);
    expect(attrs.call_consent).toMatchObject({ phone: VISITOR, text: "I agree that you may call me on this number." });
    expect(attrs.timezone).toBe("Europe/Berlin");
    expect((await w.place()).status).toBe(200);
  });

  it("a number typed into the form that belongs to someone else is never a call target", async () => {
    const w = await world({ consent: null, contact: { phone: null } });
    const other = await mkRoom(w.ctx, w.f.wsId, { contact: { name: "Owner", phone: "+14155552688" } });
    void other;
    await w.f.http.post(`/api/rooms/${w.room.id}/phone-call/consent`, {}, w.f.token);
    const msg = await w.ctx.db.get<{ id: string }>("SELECT id FROM messages WHERE room_id = ? AND meta LIKE '%contact_form%'", w.room.id);
    const sess = await visitorSessionFor(w);
    await w.f.http.post(`/public/rooms/${w.room.id}/forms/${msg!.id}`, { values: { phone: "+14155552688" }, consent: true }, undefined, sess.headers);
    const c = await w.ctx.db.get<{ phone: string | null; attrs: string }>("SELECT phone, attrs FROM contacts WHERE id = ?", w.contact.id);
    expect(c!.phone).toBeNull();
    expect(JSON.parse(c!.attrs).call_consent).toBeUndefined();
    expect((await w.place()).body.error.code).toBe("CONTACT_NO_PHONE");
  });
});

describe("settings", () => {
  it("the caller ID must be an imported number, countries are upper-cased, limits are validated, and a manager without calls:settings is refused", async () => {
    const w = await world({ calls: false });
    const bad = await w.f.http.patch("/api/calls/settings", { phone: { caller_id: "+14155559998" } }, w.f.token);
    expect(bad.body.error.code).toBe("UNKNOWN_CALLER_ID");
    expect((await w.f.http.patch("/api/workspace", { settings: { calls: { phone: { caller_id: "+14155559998" } } } }, w.f.token)).body.error.code).toBe("UNKNOWN_CALLER_ID");
    expect((await w.f.http.patch("/api/calls/settings", { phone: { caller_id: "not a number" } }, w.f.token)).status).toBe(400);
    expect((await w.f.http.patch("/api/calls/settings", { phone: { daily_limit: 0 } }, w.f.token)).status).toBe(400);
    expect((await w.f.http.patch("/api/calls/settings", { phone: { allowed_countries: ["usa"] } }, w.f.token)).status).toBe(400);
    const ok = await w.f.http.patch("/api/calls/settings", { phone: { enabled: true, caller_id: CALLER, allowed_countries: ["us", "gb"], quiet_hours: { start: "22:00" } } }, w.f.token);
    expect(ok.status).toBe(200);
    expect(ok.body.settings.calls.phone).toMatchObject({ enabled: true, caller_id: CALLER, allowed_countries: ["US", "GB"], daily_limit: 50, quiet_hours: { enabled: true, start: "22:00", end: "08:00" } });
    const cfg = await w.f.http.get("/api/calls/config", w.f.token);
    expect(cfg.body.phone).toMatchObject({ enabled: true, ready: true, caller_id: CALLER, allowed_countries: ["US", "GB"], problems: [] });
    const agent = await addMemberRaw(w.ctx, w.f.wsId, { name: "Ann Agent", role: "agent" });
    expect((await w.f.http.patch("/api/calls/settings", { phone: { enabled: false } }, await tokenFor(w.ctx, agent))).status).toBe(403);
  });

  it("readiness lists what is missing, in plain words", async () => {
    const w = await world({ connect: false, calls: false });
    await w.f.http.patch("/api/calls/settings", { phone: { enabled: true } }, w.f.token);
    const cfg = await w.f.http.get("/api/calls/config", w.f.token);
    expect(cfg.body.phone.ready).toBe(false);
    expect(cfg.body.phone.problems.join(" ")).toMatch(/Twilio account.*caller ID.*countries/s);
  });

  it("the visitor's copy of a phone call carries no member id and says it is a phone call", async () => {
    const w = await world();
    w.ctx.bus.clear();
    const id = await placed(w);
    const ev = w.ctx.bus.ofType("call:state").find((e) => e.payload.call.id === id)!;
    expect(ev.visitor).toMatchObject({ call: { id, transport: "phone", kind: "voice", state: "ringing" } });
    expect(JSON.stringify(ev.visitor)).not.toContain(w.f.owner.memberId);
  });
});

async function visitorSessionFor(w: World) {
  const { createToken, createSession } = await import("../src/services/visitors.js");
  const { actorFromRow, getMember } = await import("../src/services/members.js");
  const member = (await w.ctx.db.get<{ id: string }>("SELECT id FROM members WHERE workspace_id = ? LIMIT 1", w.f.wsId))!;
  const token = await createToken(w.ctx, actorFromRow(await getMember(w.ctx, w.f.wsId, member.id)), "chat.example.com");
  // a session for the contact whose conversation this is (the same device continues the contact's conversation)
  const row = await w.ctx.db.get<{ id: string }>("SELECT id FROM rooms WHERE id = ?", w.room.id);
  void row;
  const s = await createSession(w.ctx, token as never, { device_id: "device-phone-0001", ip: null });
  // point the conversation at this session so the visitor owns it
  await w.ctx.db.run("UPDATE visitor_sessions SET contact_id = ? WHERE id = ?", w.contact.id, s.session.id);
  await w.ctx.db.run("UPDATE rooms SET session_id = ? WHERE id = ?", s.session.id, w.room.id);
  return { headers: { "x-support-session": s.secret, "x-device-id": "device-phone-0001", origin: "https://chat.example.com" } };
}
