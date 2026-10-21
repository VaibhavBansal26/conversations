import { describe, expect, it } from "vitest";
import { ConsoleEmailProvider } from "../src/providers/fake.js";
import { silentLogger } from "../src/logger.js";
import { setMemberRole } from "../src/services/roles.js";
import { unsubscribeToken } from "../src/services/transcripts.js";
import { addMemberRaw, addSenderRaw, setSettings, tokenFor } from "./helpers.js";
import { agentWorld, answerWith, say, ScriptedProvider, ticketOf, type AgentWorld } from "./agent-helpers.js";

type Visitor = Awaited<ReturnType<AgentWorld["visitor"]>>;
async function world(t: Record<string, unknown> = { enabled: true }, o: { agent?: Record<string, unknown> } = {}) {
  const w = await agentWorld({ agent: { enabled: false, ...o.agent } });
  await addSenderRaw(w.ctx, w.wsId, "support@acme.test", true, true);
  await setSettings(w.ctx, w.wsId, { transcripts: t, widget: { visitor_info: { fields: { email: "ask_when_needed" }, consent: { enabled: true, text: "You may email me about this conversation." } } } });
  await w.ctx.cache.invalidate(`settings:${w.wsId}`);
  const ask = (v: Visitor) => w.http.post(`/public/rooms/${v.roomId}/transcript`, {}, undefined, v.headers);
  const sentTo = (addr: string) => (w.ctx.email.sent as any[]).filter((m) => m.to === addr && /Your conversation with/.test(m.subject));
  return { ...w, ask, sentTo };
}
/** the newest contact_form card of a room */
async function formOf(w: AgentWorld, v: Visitor) {
  const rows = await w.ctx.db.all<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE room_id = ? AND sender_type = 'bot' ORDER BY seq DESC", v.roomId);
  return rows.find((r) => JSON.parse(r.meta).card?.type === "contact_form") ?? null;
}
const contactOf = async (w: AgentWorld, v: Visitor) => (await w.ctx.db.get<any>("SELECT c.* FROM contacts c JOIN rooms r ON r.contact_id = c.id WHERE r.id = ?", v.roomId))!;

describe("a visitor asks for a copy", () => {
  it("off by default: refused, and the widget config says so", async () => {
    const w = await world({});
    const v = await w.visitor();
    await say(w, v, "Hello");
    expect((await w.ask(v)).body.error.code).toBe("TRANSCRIPTS_DISABLED");
    expect((await w.http.get("/public/widget/config", undefined, w.h())).body.transcripts).toEqual({ enabled: false });
  });

  it("no address yet: the details form appears in the chat; after giving it with consent, the copy goes to that address", async () => {
    const w = await world();
    const v = await w.visitor();
    await say(w, v, "My printer is on fire");
    const r = await w.ask(v);
    expect(r.body.error.code).toBe("EMAIL_REQUIRED");
    const card = await formOf(w, v);
    expect(card).not.toBeNull();
    const sub = await w.http.post(`/public/rooms/${v.roomId}/forms/${card!.id}`, { values: { email: "vic@example.test" }, consent: true }, undefined, v.headers);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const ok = await w.ask(v);
    expect(ok.body).toMatchObject({ status: "sent", to: "v…@example.test" });
    const [mail] = w.sentTo("vic@example.test");
    expect(mail.from.address).toBe("support@acme.test");
    expect(mail.text).toContain("You: My printer is on fire");
    expect(mail.text).toMatch(/one-time copy, not a subscription/);
    expect(mail.extraHeaders["Auto-Submitted"]).toBe("auto-replied");
  });

  it("an address typed at the start is not trusted: a code first (the existing verification), then the copy", async () => {
    const w = await world();
    const v = await w.visitor({ email: "typed@example.test", consent: true });
    await say(w, v, "Hi there");
    const r = await w.ask(v);
    expect(r.body.error).toMatchObject({ code: "VERIFY_EMAIL_FIRST", details: { channel: "email" } });
    expect(w.sentTo("typed@example.test")).toHaveLength(0);
    expect((await w.http.post("/public/otp/send", {}, undefined, v.headers)).status).toBe(200);
    const code = /code is (\d{5})/.exec((w.ctx.email.sent as any[]).at(-1).text)![1];
    expect((await w.http.post("/public/otp/verify", { code }, undefined, v.headers)).status).toBe(200);
    expect((await w.ask(v)).body.status).toBe("sent");
  });

  it("never to another contact's address: an address that belongs to someone else stays unverified and nothing is sent to it", async () => {
    const w = await world();
    const other = await w.visitor({}, "device-other-0001");
    await say(w, other, "x");
    const oc = await contactOf(w, other);
    await w.ctx.db.run("UPDATE contacts SET email = 'owner@example.test' WHERE id = ?", oc.id);
    const v = await w.visitor({}, "device-mine-00001");
    await say(w, v, "Send me everything");
    await w.ask(v);
    const card = await formOf(w, v);
    await w.http.post(`/public/rooms/${v.roomId}/forms/${card!.id}`, { values: { email: "owner@example.test" }, consent: true }, undefined, v.headers);
    expect((await contactOf(w, v)).email).toBeNull();
    expect((await w.ask(v)).body.error.code).toBe("EMAIL_REQUIRED");
    expect(w.sentTo("owner@example.test")).toHaveLength(0);
  });

  it("contains what the visitor saw only: no internal notes, no internal lines, no AI reasoning; personal data masked when asked", async () => {
    const w = await world({ enabled: true, redact: true }, { agent: { enabled: true } });
    w.ctx.ai = new ScriptedProvider(answerWith()) as never;
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    await say(w, v, "my card is 4111 1111 1111 1111 and mail me at secret.person@example.test");
    await w.http.post(`/api/rooms/${v.roomId}/messages`, { kind: "note", source: "dm", content: "INTERNAL NOTE: refund is likely" }, w.token);
    const card = await formOf(w, v);
    if (card) await w.http.post(`/public/rooms/${v.roomId}/forms/${card.id}`, { values: { email: "vic@example.test" }, consent: true }, undefined, v.headers);
    else {
      await w.ask(v);
      const c2 = await formOf(w, v);
      await w.http.post(`/public/rooms/${v.roomId}/forms/${c2!.id}`, { values: { email: "vic@example.test" }, consent: true }, undefined, v.headers);
    }
    expect((await w.ask(v)).body.status).toBe("sent");
    const text = w.sentTo("vic@example.test")[0].text as string;
    expect(text).toContain("Open Settings");
    expect(text).toMatch(/Aria \(AI\)/);
    expect(text).not.toContain("INTERNAL NOTE");
    expect(text).not.toContain("secret.person@example.test");
    expect(text).not.toContain("4111 1111 1111 1111");
    expect(text).not.toMatch(/confidence|retrieval|trace/i);
    expect(text).not.toContain("The visitor shared"); // an internal line for the team
  });

  it("3 copies an hour per contact; test mode says so honestly", async () => {
    const w = await world();
    const v = await w.visitor();
    await say(w, v, "hello");
    await w.ask(v);
    const card = await formOf(w, v);
    await w.http.post(`/public/rooms/${v.roomId}/forms/${card!.id}`, { values: { email: "vic@example.test" }, consent: true }, undefined, v.headers);
    for (let i = 0; i < 3; i++) expect((await w.ask(v)).status).toBe(200);
    expect((await w.ask(v)).status).toBe(429);
    const t = await world();
    t.ctx.email = new ConsoleEmailProvider(silentLogger);
    const tv = await t.visitor();
    await say(t, tv, "hello");
    await t.ask(tv);
    const c = await formOf(t, tv);
    await t.http.post(`/public/rooms/${tv.roomId}/forms/${c!.id}`, { values: { email: "vic@example.test" }, consent: true }, undefined, tv.headers);
    expect((await t.ask(tv)).body.status).toBe("not_sent_test_mode");
    expect(await t.ctx.db.get("SELECT status FROM transcript_sends WHERE room_id = ?", tv.roomId)).toMatchObject({ status: "not_sent_test_mode" });
  });
});

describe("the team sends a copy", () => {
  it("to the contact's own address on file, with conversations:reply; audited with a hint of the address; listed on the conversation", async () => {
    const w = await world({});
    const v = await w.visitor({ email: "client@example.test", consent: true });
    await say(w, v, "Please send me the details");
    const r = await w.http.post(`/api/rooms/${v.roomId}/transcript`, {}, w.token);
    expect(r.body).toMatchObject({ status: "sent", to: "c…@example.test" });
    expect(w.sentTo("client@example.test")).toHaveLength(1);
    const audit = await w.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'transcript.sent' AND target = ?", v.roomId);
    expect(audit!.detail).not.toContain("client@example.test");
    const lst = await w.http.get(`/api/rooms/${v.roomId}/transcripts`, w.token);
    expect(lst.body.data[0]).toMatchObject({ requested_by: "member", to_hint: "c…@example.test", status: "sent" });
    const viewer = await addMemberRaw(w.ctx, w.wsId, { name: "Vi", role: "agent" });
    await setMemberRole(w.ctx, w.owner, viewer.memberId, "role_viewer");
    expect((await w.http.post(`/api/rooms/${v.roomId}/transcript`, {}, await tokenFor(w.ctx, viewer))).status).toBe(403);
    const other = await agentWorld();
    expect((await other.http.post(`/api/rooms/${v.roomId}/transcript`, {}, other.token)).status).toBe(404);
    const v2 = await w.visitor({}, "device-noemail-01");
    await say(w, v2, "hi");
    expect((await w.http.post(`/api/rooms/${v2.roomId}/transcript`, {}, w.token)).body.error.code).toBe("CONTACT_EMAIL_REQUIRED");
  });
});

describe("the automatic copy after a resolution", () => {
  async function resolved(w: Awaited<ReturnType<typeof world>>, v: Visitor) {
    const t = await ticketOf(w, v.roomId);
    expect((await w.http.post(`/api/tickets/${t.id}/resolve`, {}, w.token)).status).toBe(200);
    await w.ctx.background.settle();
    return t;
  }
  it("once per ticket, only to a confirmed address, with a working unsubscribe link; never after unsubscribing", async () => {
    const w = await world({ enabled: true, send_after_resolve: true });
    const v = await w.visitor();
    await say(w, v, "hello");
    await w.ask(v);
    const card = await formOf(w, v);
    await w.http.post(`/public/rooms/${v.roomId}/forms/${card!.id}`, { values: { email: "vic@example.test" }, consent: true }, undefined, v.headers);
    const t = await resolved(w, v);
    const auto = w.sentTo("vic@example.test");
    expect(auto).toHaveLength(1);
    expect(auto[0].text).toMatch(/sends one after a conversation is resolved/);
    expect(auto[0].extraHeaders["Auto-Submitted"]).toBe("auto-generated");
    const link = /\/public\/transcripts\/unsubscribe\/(\S+)/.exec(auto[0].text)![1];
    // resolving again sends nothing more
    const { maybeSendAfterResolve } = await import("../src/services/transcripts.js");
    expect(await maybeSendAfterResolve(w.ctx, t.id)).toBeNull();
    // a forged link does nothing; the real one unsubscribes
    const contact = await contactOf(w, v);
    const forged = unsubscribeToken(w.ctx, w.wsId, "ctc_someoneelse0000000000").split(".")[0] + "." + link.split(".")[1];
    expect((await w.app.request(`/public/transcripts/unsubscribe/${forged}`)).status).toBe(200);
    expect((await contactOf(w, v)).unsubscribed).toBe(0);
    expect((await w.app.request(`/public/transcripts/unsubscribe/${link}`)).status).toBe(200);
    expect((await contactOf(w, v)).unsubscribed).toBe(1);
    expect(contact.id).toBeTruthy();
    // a new ticket of the same contact gets no automatic copy any more
    await say(w, v, "one more question");
    await resolved(w, v);
    expect(w.sentTo("vic@example.test")).toHaveLength(1);
  });

  it("nothing for an unconfirmed address or when the option is off", async () => {
    const w = await world({ enabled: true, send_after_resolve: true });
    const v = await w.visitor({ email: "typed@example.test", consent: true });
    await say(w, v, "hello");
    await resolved(w, v);
    expect(w.sentTo("typed@example.test")).toHaveLength(0);
    const off = await world({ enabled: true });
    const v2 = await off.visitor();
    await say(off, v2, "hello");
    await off.ask(v2);
    const card = await formOf(off, v2);
    await off.http.post(`/public/rooms/${v2.roomId}/forms/${card!.id}`, { values: { email: "vic2@example.test" }, consent: true }, undefined, v2.headers);
    await resolved(off, v2);
    expect((off.ctx.email.sent as any[]).filter((m) => /sends one after/.test(m.text))).toHaveLength(0);
  });
});

describe("the AI agent offers it", () => {
  it("send_transcript (an allowed action, off for older agents) sends to the confirmed address and tells the team", async () => {
    const w = await world({ enabled: true }, { agent: { enabled: true } });
    w.ctx.ai = new ScriptedProvider((req) => ({ ...(answerWith()(req) as object), actions: [{ tool: "send_transcript" }] })) as never;
    const v = await w.visitor();
    await say(w, v, "hello");
    await w.ask(v);
    const card = await formOf(w, v);
    await w.http.post(`/public/rooms/${v.roomId}/forms/${card!.id}`, { values: { email: "vic@example.test" }, consent: true }, undefined, v.headers);
    await say(w, v, "How do I reset my password? Please email me this conversation");
    expect(w.sentTo("vic@example.test").length).toBeGreaterThanOrEqual(1);
    const lines = (await w.ctx.db.all<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = ? AND kind = 'system'", v.roomId)).map((x) => x.content_text).join("\n");
    expect(lines).toMatch(/sent the visitor a copy of the conversation/);
  });
});
