import { describe, expect, it } from "vitest";
import { updateDepartment } from "../src/services/departments.js";
import { effectiveInfo, fieldsToAsk } from "../src/services/visitorInfo.js";
import { VisitorInfoSchema } from "../src/domain/settings.js";
import { mkContact, setSettings } from "./helpers.js";
import { agentWorld, answerWith, say, ScriptedProvider, ticketOf, type AgentWorld } from "./agent-helpers.js";

type Visitor = Awaited<ReturnType<AgentWorld["visitor"]>>;
const info = (w: AgentWorld, visitor_info: Record<string, unknown>) => w.http.patch("/api/workspace", { settings: { widget: { visitor_info } } }, w.token);

/** the newest contact_form card of a room, with its message id */
async function form(w: AgentWorld, v: Visitor) {
  const rows = await w.ctx.db.all<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE room_id = ? AND sender_type = 'bot' ORDER BY seq DESC", v.roomId);
  const row = rows.find((r) => JSON.parse(r.meta).card?.type === "contact_form");
  return row ? { id: row.id, card: JSON.parse(row.meta).card, text: "" } : null;
}
const forms = async (w: AgentWorld, v: Visitor) => (await w.ctx.db.all<{ meta: string }>("SELECT meta FROM messages WHERE room_id = ? AND sender_type = 'bot'", v.roomId)).filter((r) => JSON.parse(r.meta).card?.type === "contact_form").length;
const submit = (w: AgentWorld, v: Visitor, id: string, body: object) => w.http.post(`/public/rooms/${v.roomId}/forms/${id}`, body, undefined, v.headers);
const contactOf = async (w: AgentWorld, v: Visitor) => (await w.ctx.db.get<{ name: string; email: string | null; phone: string | null; attrs: string }>("SELECT c.* FROM contacts c JOIN rooms r ON r.contact_id = c.id WHERE r.id = ?", v.roomId))!;
const wantHuman = (w: AgentWorld, v: Visitor) => w.http.post(`/public/rooms/${v.roomId}/request-human`, {}, undefined, v.headers);

describe("visitor details: settings", () => {
  it("everything is off by default, and the settings are validated", async () => {
    const w = await agentWorld();
    expect(VisitorInfoSchema.parse({}).fields).toEqual({ name: "off", email: "off", phone: "off" });
    expect((await info(w, { fields: { email: "sometimes" } })).status).toBe(400);
    expect((await info(w, { custom_fields: [{ key: "Plan", label: "Plan" }] })).status).toBe(400);
    expect((await info(w, { custom_fields: [{ key: "plan", label: "Plan", type: "select", options: ["only one"] }] })).status).toBe(400);
    expect((await info(w, { consent: { enabled: true, privacy_url: "javascript:alert(1)" } })).status).toBe(400);
    const ok = await info(w, { fields: { email: "ask_when_needed" }, custom_fields: [{ key: "plan", label: "Plan", type: "select", options: ["Free", "Pro"] }] });
    expect(ok.status).toBe(200);
    expect((await w.http.get("/public/widget/config", undefined, w.h())).body.widget.visitor_info.fields.email).toBe("ask_when_needed");
  });

  it("a department overrides the fields and moments, the rest stays the workspace's", async () => {
    const w = await agentWorld();
    await info(w, { fields: { email: "ask_when_needed" }, moments: { handoff: true, no_agent: true, callback: true, after: false } });
    await updateDepartment(w.ctx, w.owner, w.billing.id, { visitor_info: { fields: { phone: "required" }, moments: { after: true } } });
    const eff = await effectiveInfo(w.ctx, w.wsId, w.billing.id);
    expect(eff.fields).toEqual({ name: "off", email: "ask_when_needed", phone: "required" });
    expect(eff.moments.after).toBe(true);
    expect((await effectiveInfo(w.ctx, w.wsId, w.support.id)).fields.phone).toBe("off");
    expect((await w.http.patch(`/api/departments/${w.billing.id}`, { visitor_info: { fields: { phone: "maybe" } } }, w.token)).status).toBe(400);
  });

  it("a required field is also required when the session starts", async () => {
    const w = await agentWorld();
    await info(w, { fields: { email: "required" } });
    const r = await w.http.post("/public/sessions", {}, undefined, w.h("device-req-0001"));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("REQUIRED_INFO_MISSING");
    expect((await w.http.post("/public/sessions", { email: "a@example.test" }, undefined, w.h("device-req-0002"))).status).toBe(201);
  });
});

describe("visitor details: asking", () => {
  it("a handoff to a person puts one form card in the thread with the fields that are on and not yet known", async () => {
    const w = await agentWorld({ agent: { enabled: false } });
    await info(w, { fields: { name: "off", email: "ask_when_needed", phone: "optional" }, custom_fields: [{ key: "plan", label: "Your plan", type: "select", options: ["Free", "Pro"], mode: "optional" }] });
    const v = await w.visitor();
    await wantHuman(w, v);
    const f = (await form(w, v))!;
    expect(f.card).toMatchObject({ moment: "handoff", skippable: true, consent: null });
    expect(f.card.fields.map((x: { key: string; type: string; required: boolean }) => [x.key, x.type, x.required])).toEqual([["email", "email", false], ["phone", "tel", false], ["plan", "select", false]]);
    await wantHuman(w, v);
    await w.http.post(`/api/tickets/${(await ticketOf(w, v.roomId)).id}/transfer`, { department_id: w.billing.id }, w.token);
    expect(await forms(w, v)).toBe(1); // once per moment and ticket
  });

  it("a visible card never shows the team's notes, and nothing is asked when the details are known or switched off", async () => {
    const w = await agentWorld({ agent: { enabled: false } });
    const v = await w.visitor({ email: "known@example.test" });
    await info(w, { fields: { email: "required" } });
    await wantHuman(w, v);
    expect(await forms(w, v)).toBe(0); // the email is already known
    const w2 = await agentWorld({ agent: { enabled: false } });
    const v2 = await w2.visitor();
    await wantHuman(w2, v2);
    expect(await forms(w2, v2)).toBe(0); // all off
    const msgs = (await w2.http.get(`/public/rooms/${v2.roomId}/messages`, undefined, v2.headers)).body.data;
    expect(JSON.stringify(msgs)).not.toContain("Handoff:");
  });

  it("when nobody can take it the card says so; moments can be switched off", async () => {
    const w = await agentWorld({ agent: { enabled: false } });
    await setSettings(w.ctx, w.wsId, { routing: { require_online: true } });
    await info(w, { fields: { email: "ask_when_needed" } });
    const v = await w.visitor();
    await wantHuman(w, v);
    expect((await ticketOf(w, v.roomId)).status).toBe("waiting_for_human");
    const m = (await w.ctx.db.all<{ content_text: string; meta: string }>("SELECT content_text, meta FROM messages WHERE room_id = ? AND sender_type = 'bot'", v.roomId)).find((r) => JSON.parse(r.meta).card?.type === "contact_form")!;
    expect(m.content_text).toContain("Nobody is available");
    expect(JSON.parse(m.meta).card.moment).toBe("no_agent");
    const w2 = await agentWorld({ agent: { enabled: false } });
    await info(w2, { fields: { email: "ask_when_needed" }, moments: { handoff: false } });
    const v2 = await w2.visitor();
    await wantHuman(w2, v2);
    expect(await forms(w2, v2)).toBe(0);
  });

  it("consent is part of the card when the workspace asks for it, but not for a name alone", async () => {
    const w = await agentWorld({ agent: { enabled: false } });
    await info(w, { fields: { name: "ask_when_needed", email: "ask_when_needed" }, consent: { enabled: true, text: "You may email me.", privacy_url: "https://example.test/privacy" } });
    const v = await w.visitor();
    await wantHuman(w, v);
    expect((await form(w, v))!.card.consent).toEqual({ text: "You may email me.", privacy_url: "https://example.test/privacy" });
    const w2 = await agentWorld({ agent: { enabled: false } });
    await info(w2, { fields: { name: "ask_when_needed" }, consent: { enabled: true } });
    const v2 = await w2.visitor();
    await wantHuman(w2, v2);
    expect((await form(w2, v2))!.card.consent).toBeNull();
  });

  it("after a resolved ticket it asks for an email to follow up, only when switched on", async () => {
    const w = await agentWorld();
    await info(w, { fields: { email: "optional" }, moments: { handoff: false, no_agent: false, callback: false, after: true } });
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    await say(w, v, "thanks, that solved it");
    const f = (await form(w, v))!;
    expect(f.card).toMatchObject({ moment: "after", skippable: true });
    expect(f.card.fields.map((x: { key: string }) => x.key)).toEqual(["email"]);
  });

  it("the AI agent can ask for details and for a callback number through its tools, once, and never for what is switched off", async () => {
    const w = await agentWorld();
    await info(w, { fields: { name: "optional", email: "optional", phone: "off" } });
    w.ctx.ai = new ScriptedProvider(answerWith({ actions: [{ tool: "collect_contact_info", fields: ["email", "phone"] }] }));
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    const f = (await form(w, v))!;
    expect(f.card).toMatchObject({ moment: "agent" });
    expect(f.card.fields.map((x: { key: string }) => x.key)).toEqual(["email"]); // phone is off in the settings
    const turn = await w.ctx.db.get<{ actions: string }>("SELECT actions FROM ai_turns WHERE room_id = ?", v.roomId);
    expect(JSON.parse(turn!.actions)).toEqual([expect.objectContaining({ tool: "collect_contact_info", ok: true })]);
    const w2 = await agentWorld();
    await info(w2, { fields: { phone: "optional" } });
    w2.ctx.ai = new ScriptedProvider(answerWith({ actions: [{ tool: "schedule_callback" }] }));
    const v2 = await w2.visitor();
    await say(w2, v2, "How do I reset my password?");
    const cb = (await form(w2, v2))!;
    expect(cb.card).toMatchObject({ moment: "callback", skippable: false });
    expect(cb.card.fields).toEqual([expect.objectContaining({ key: "phone", required: true })]);
  });

  it("fieldsToAsk skips what the contact has, including custom values", async () => {
    const w = await agentWorld();
    const c = await mkContact(w.ctx, w.wsId, { name: "Pat", email: "pat@example.test", attrs: { plan: "Pro" } });
    const s = VisitorInfoSchema.parse({ fields: { name: "required", email: "required", phone: "required" }, custom_fields: [{ key: "plan", label: "Plan" }, { key: "team", label: "Team" }] });
    expect(fieldsToAsk(s, c, "handoff").map((f) => f.key)).toEqual(["phone", "team"]);
  });
});

describe("visitor details: answering", () => {
  async function ask(extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
    const w = await agentWorld({ agent: { enabled: false } });
    await info(w, { fields: { name: "ask_when_needed", email: "ask_when_needed", phone: "optional" }, custom_fields: [{ key: "plan", label: "Your plan", type: "select", options: ["Free", "Pro"], mode: "optional" }], ...extra });
    const v = await w.visitor();
    await wantHuman(w, v);
    return { w, v, f: (await form(w, v))!, over };
  }

  it("validates and stores: name, a lower-cased email, a phone in E.164 with the chosen country, a custom value, consent", async () => {
    const { w, v, f } = await ask({ consent: { enabled: true } });
    const r = await submit(w, v, f.id, { values: { name: "Zoë O'Neil", email: " Pat@Example.TEST ", phone: "07911 123456", plan: "Pro" }, consent: true, country: "GB" });
    expect(r.status).toBe(200);
    expect(r.body.saved).toEqual(expect.arrayContaining(["name", "email", "phone"]));
    const c = await contactOf(w, v);
    expect(c).toMatchObject({ name: "Zoë O'Neil", email: "pat@example.test", phone: "+447911123456" });
    expect(JSON.parse(c.attrs)).toMatchObject({ plan: "Pro", contact_consent: { text: expect.any(String) } });
    // the card is closed, the visitor's own message says what was shared (not the values), the team gets a line
    expect((await form(w, v))!.card.answered).toBe("submitted");
    const mine = await w.ctx.db.all<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = ? AND sender_type = 'contact' ORDER BY seq DESC LIMIT 1", v.roomId);
    expect(mine[0]!.content_text).toMatch(/^Shared my details: /);
    expect(mine[0]!.content_text).not.toContain("example.test");
    const sys = await w.ctx.db.all<{ meta: string }>("SELECT meta FROM messages WHERE room_id = ? AND kind = 'system'", v.roomId);
    expect(sys.some((s) => JSON.parse(s.meta).sub_type === "info_submitted")).toBe(true);
    // it is not asked again, and the submit is answered once
    expect((await submit(w, v, f.id, { values: { email: "x@example.test" } })).body.error.code).toBe("ALREADY_ANSWERED");
    expect((await w.http.get(`/public/rooms/${v.roomId}/messages`, undefined, v.headers)).body.data.some((m: { meta: { sub_type?: string } }) => m.meta.sub_type === "info_submitted")).toBe(false);
  });

  it("refuses bad values with one message per field, and nothing is stored or closed", async () => {
    const { w, v, f } = await ask({ consent: { enabled: true } });
    const bad = await submit(w, v, f.id, { values: { name: "<script>alert(1)</script>", email: "not-an-email", phone: "12", plan: "Enterprise", extra: "x" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("INVALID_FORM");
    expect(Object.keys(bad.body.error.details.errors).sort()).toEqual(["email", "extra", "name", "phone", "plan"]);
    expect((await form(w, v))!.card.answered).toBeUndefined();
    expect((await contactOf(w, v)).email).toBeNull();
    const w2 = await agentWorld({ agent: { enabled: false } });
    const v2 = await w2.visitor();
    await info(w2, { fields: { email: "required" } });
    await wantHuman(w2, v2);
    expect((await submit(w2, v2, (await form(w2, v2))!.id, { values: {} })).body.error.details.errors.email).toBe("This is required");
  });

  it("asks for consent when the card carries it", async () => {
    const { w, v, f } = await ask({ consent: { enabled: true } });
    const r = await submit(w, v, f.id, { values: { email: "a@example.test" } });
    expect(r.body.error.details.errors).toEqual({ consent: "Please agree to continue" });
    expect((await submit(w, v, f.id, { values: { name: "Pat" } })).status).toBe(200); // a name alone needs no consent
  });

  it("a honeypot answer stores nothing and leaves the card open", async () => {
    const { w, v, f } = await ask();
    const r = await submit(w, v, f.id, { values: { email: "bot@example.test" }, website: "https://spam.example.test" });
    expect(r.status).toBe(200);
    expect((await contactOf(w, v)).email).toBeNull();
    expect((await form(w, v))!.card.answered).toBeUndefined();
  });

  it("an email that belongs to another contact is kept as unverified and never links that contact's history", async () => {
    const { w, v, f } = await ask();
    const other = await mkContact(w.ctx, w.wsId, { name: "Existing", email: "owner@example.test" });
    const r = await submit(w, v, f.id, { values: { email: "owner@example.test", phone: "+14155552671" } });
    expect(r.status).toBe(200);
    const c = await contactOf(w, v);
    expect(c.email).toBeNull();
    expect(JSON.parse(c.attrs).unverified_email).toBe("owner@example.test");
    expect(c.phone).toBe("+14155552671");
    const room = await w.ctx.db.get<{ contact_id: string }>("SELECT contact_id FROM rooms WHERE id = ?", v.roomId);
    expect(room!.contact_id).not.toBe(other.id);
    // the response is the same as for a fresh address: it does not say the address exists
    const { w: w2, v: v2, f: f2 } = await ask();
    const fresh = await submit(w2, v2, f2.id, { values: { email: "fresh@example.test" } });
    expect(Object.keys(fresh.body).sort()).toEqual(Object.keys(r.body).sort());
  });

  it("skipping works for optional cards only; a callback card needs the number", async () => {
    const { w, v, f } = await ask({ fields: { name: "off", email: "optional", phone: "off" } });
    expect((await w.http.post(`/public/rooms/${v.roomId}/forms/${f.id}/skip`, {}, undefined, v.headers)).status).toBe(200);
    expect((await form(w, v))!.card.answered).toBe("skipped");
    expect((await w.http.post(`/public/rooms/${v.roomId}/forms/${f.id}/skip`, {}, undefined, v.headers)).body.error.code).toBe("ALREADY_ANSWERED");
    const w2 = await agentWorld();
    await info(w2, { fields: { phone: "optional" } });
    w2.ctx.ai = new ScriptedProvider(answerWith({ actions: [{ tool: "schedule_callback" }] }));
    const v2 = await w2.visitor();
    await say(w2, v2, "How do I reset my password?");
    const cb = (await form(w2, v2))!;
    expect((await w2.http.post(`/public/rooms/${v2.roomId}/forms/${cb.id}/skip`, {}, undefined, v2.headers)).body.error.code).toBe("NOT_SKIPPABLE");
    // a callback always asks to be called on that number: without the box ticked nothing is saved
    expect((await submit(w2, v2, cb.id, { values: { phone: "+14155552671" } })).body.error.details.errors.consent).toBe("Please agree to continue");
    expect((await submit(w2, v2, cb.id, { values: { phone: "+14155552671" }, consent: true })).status).toBe(200);
    expect(JSON.parse((await contactOf(w2, v2)).attrs).call_consent).toMatchObject({ phone: "+14155552671", text: "I agree that you may call me on this number." });
    const ev = await w2.ctx.db.all<{ type: string }>("SELECT type FROM ticket_events WHERE ticket_id = ?", (await ticketOf(w2, v2.roomId)).id);
    expect(ev.map((e) => e.type)).toContain("callback_requested");
  });

  it("another visitor, another room or a message that is not a form cannot be answered", async () => {
    const { w, v, f } = await ask();
    const stranger = await w.visitor({}, "device-zzzz-9999");
    expect((await submit(w, stranger, f.id, { values: { email: "x@example.test" } })).status).toBe(404);
    expect((await submit(w, v, "msg_nope", { values: {} })).status).toBe(404);
    const plain = await w.ctx.db.get<{ id: string }>("SELECT id FROM messages WHERE room_id = ? AND sender_type = 'contact' LIMIT 1", v.roomId);
    expect((await submit(w, v, plain!.id, { values: {} })).status).toBe(404);
  });

  it("two submits at once store once", async () => {
    const { w, v, f } = await ask();
    const [a, b] = await Promise.all([submit(w, v, f.id, { values: { email: "one@example.test" } }), submit(w, v, f.id, { values: { email: "one@example.test" } })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await contactOf(w, v)).email).toBe("one@example.test");
  });

  it("submitted details do not start an AI turn, and do not reach the model when the workspace redacts personal data", async () => {
    const w = await agentWorld({ redact: true });
    await info(w, { fields: { email: "optional" } });
    const model = new ScriptedProvider(answerWith({ actions: [{ tool: "collect_contact_info", fields: ["email"] }] }));
    w.ctx.ai = model;
    const v = await w.visitor();
    await say(w, v, "How do I reset my password?");
    const f = (await form(w, v))!;
    const before = model.calls.length;
    await submit(w, v, f.id, { values: { email: "secret.person@example.test" } });
    await w.ctx.background.settle();
    expect(model.calls.length).toBe(before);
    await say(w, v, "How do I reset my password again?");
    expect(JSON.stringify(model.calls.map((c) => c.prompt))).not.toContain("secret.person@example.test");
  });
});
