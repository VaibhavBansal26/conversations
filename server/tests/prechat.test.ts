import { describe, expect, it } from "vitest";
import { updateDepartment } from "../src/services/departments.js";
import { effectiveInfo } from "../src/services/visitorInfo.js";
import { agentWorld, say, ticketOf, type AgentWorld } from "./agent-helpers.js";

const info = (w: AgentWorld, visitor_info: Record<string, unknown>) => w.http.patch("/api/workspace", { settings: { widget: { visitor_info } } }, w.token);
const FIELDS = [
  { key: "plan", label: "Your plan", type: "select", options: ["Free", "Pro"], mode: "required" },
  { key: "order", label: "Order number", type: "text", mode: "optional" },
  { key: "terms", label: "I accept the terms", type: "checkbox", mode: "required" },
  { key: "company", label: "Company", type: "text", mode: "ask_when_needed" },
];
const start = (w: AgentWorld, body: object, device = "device-pre-00001") => w.http.post("/public/sessions", body, undefined, w.h(device));
const contactOf = (w: AgentWorld, id: string) => w.ctx.db.get<any>("SELECT * FROM contacts WHERE id = ?", id);

describe("custom fields in the pre-chat form", () => {
  it("settings: text, choice and checkbox, at most five, choices need two options", async () => {
    const w = await agentWorld();
    expect((await info(w, { custom_fields: FIELDS })).status).toBe(200);
    expect((await info(w, { custom_fields: [{ key: "x", label: "X", type: "date" }] })).status).toBe(400);
    expect((await info(w, { custom_fields: Array.from({ length: 6 }, (_, i) => ({ key: `f${i}`, label: `F${i}` })) })).status).toBe(400);
    const cfg = (await w.http.get("/public/widget/config", undefined, w.h())).body.widget.visitor_info;
    expect(cfg.custom_fields.map((f: any) => [f.key, f.type, f.mode])).toEqual([["plan", "select", "required"], ["order", "text", "optional"], ["terms", "checkbox", "required"], ["company", "text", "ask_when_needed"]]);
  });

  it("required fields are enforced by the server (REQUIRED_INFO_MISSING), values are validated, unknown and later-asked keys refused, answers stored on the contact", async () => {
    const w = await agentWorld();
    await info(w, { custom_fields: FIELDS });
    const none = await start(w, {});
    expect(none.status).toBe(422);
    expect(none.body.error).toMatchObject({ code: "REQUIRED_INFO_MISSING", details: { missing: ["plan", "terms"] } });
    expect((await start(w, { attrs: { plan: "Pro", terms: false } })).body.error.details.missing).toEqual(["terms"]);
    const bad = await start(w, { attrs: { plan: "Enterprise", terms: true, company: "Acme", nope: "x" } });
    expect(bad.body.error).toMatchObject({ code: "INVALID_FORM", details: { errors: { plan: "Choose one of the options", company: "Not asked", nope: "Not asked" } } });
    expect((await start(w, { attrs: { plan: "Pro", terms: true, order: "<script>" } })).body.error.details.errors.order).toMatch(/plain text/);
    const ok = await start(w, { name: "Pat", attrs: { plan: "Pro", terms: true, order: "A-1001" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const c = await contactOf(w, ok.body.contact.id);
    expect(JSON.parse(c.attrs)).toMatchObject({ plan: "Pro", terms: "yes", order: "A-1001" });
  });

  it("answered before the chat means not asked again in the thread; ask-when-needed fields (also a checkbox) come in the thread card", async () => {
    const w = await agentWorld({ agent: { enabled: false } });
    await info(w, { custom_fields: [...FIELDS.slice(0, 3), { key: "newsletter", label: "Send me product news", type: "checkbox", mode: "ask_when_needed" }], fields: { email: "ask_when_needed" } });
    const s = await w.newSession({ attrs: { plan: "Free", terms: true } }, "device-pre-00002");
    const room = await w.http.post("/public/rooms", {}, undefined, s.headers);
    await w.http.post(`/public/rooms/${room.body.room.id}/messages`, { content: "Hello" }, undefined, s.headers);
    await w.http.post(`/public/rooms/${room.body.room.id}/request-human`, {}, undefined, s.headers);
    await w.ctx.background.settle();
    const rows = await w.ctx.db.all<{ id: string; meta: string }>("SELECT id, meta FROM messages WHERE room_id = ? AND sender_type = 'bot' ORDER BY seq DESC", room.body.room.id);
    const card = rows.map((r) => ({ id: r.id, card: JSON.parse(r.meta).card })).find((x) => x.card?.type === "contact_form")!;
    expect(card.card.fields.map((f: any) => [f.key, f.type])).toEqual([["email", "email"], ["newsletter", "checkbox"]]);
    const sub = await w.http.post(`/public/rooms/${room.body.room.id}/forms/${card.id}`, { values: { email: "pat@example.test", newsletter: "yes" } }, undefined, s.headers);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const contact = await w.ctx.db.get<any>("SELECT c.* FROM contacts c JOIN rooms r ON r.contact_id = c.id WHERE r.id = ?", room.body.room.id);
    expect(JSON.parse(contact.attrs)).toMatchObject({ plan: "Free", terms: "yes", newsletter: "yes" });
  });

  it("consent: when the workspace asks for it, an address given before the chat needs the box ticked; the agreement is recorded as given in the pre-chat form", async () => {
    const w = await agentWorld();
    await info(w, { fields: { email: "optional" }, consent: { enabled: true, text: "You may contact me about this conversation." } });
    const no = await start(w, { email: "pat@example.test" }, "device-pre-00003");
    expect(no.body.error).toMatchObject({ code: "INVALID_FORM", details: { errors: { consent: "Please agree to continue" } } });
    const ok = await start(w, { email: "pat@example.test", consent: true }, "device-pre-00004");
    expect(ok.status).toBe(201);
    expect(JSON.parse((await contactOf(w, ok.body.contact.id)).attrs).contact_consent).toMatchObject({ text: "You may contact me about this conversation.", via: "prechat" });
    // without an address there is nothing to agree to
    expect((await start(w, {}, "device-pre-00005")).status).toBe(201);
  });

  it("a department overrides the custom fields' modes and the consent wording; the widget's department decides the pre-chat form", async () => {
    const w = await agentWorld({ agent: { enabled: false } });
    await info(w, { custom_fields: [{ key: "order", label: "Order number", type: "text", mode: "optional" }], fields: { email: "ask_when_needed" }, consent: { enabled: true, text: "Acme may contact me." } });
    await updateDepartment(w.ctx, w.owner, w.support.id, { visitor_info: { custom_fields: { order: "required" }, consent: { text: "Acme Support Ltd may contact me.", privacy_url: "https://support.example.test/privacy" } } } as never);
    const eff = await effectiveInfo(w.ctx, w.wsId, w.support.id);
    expect(eff.custom_fields[0]!.mode).toBe("required");
    expect(eff.consent).toMatchObject({ enabled: true, text: "Acme Support Ltd may contact me.", privacy_url: "https://support.example.test/privacy" });
    expect((await effectiveInfo(w.ctx, w.wsId, w.billing.id)).consent.text).toBe("Acme may contact me.");
    // the widget's default department is Technical support: its override applies before the chat
    expect((await w.http.get("/public/widget/config", undefined, w.h())).body.widget.visitor_info.custom_fields[0].mode).toBe("required");
    expect((await start(w, {}, "device-pre-00006")).body.error.details.missing).toEqual(["order"]);
    // and in the thread: the card of a Technical support ticket carries the department's consent wording
    const v = await w.visitor({ attrs: { order: "A-1" } }, "device-pre-00007");
    await say(w, v, "Hello");
    await w.http.post(`/public/rooms/${v.roomId}/request-human`, {}, undefined, v.headers);
    await w.ctx.background.settle();
    const t = await ticketOf(w, v.roomId);
    expect(t.department_id).toBe(w.support.id);
    const rows = await w.ctx.db.all<{ meta: string }>("SELECT meta FROM messages WHERE room_id = ? AND sender_type = 'bot'", v.roomId);
    const card = rows.map((r) => JSON.parse(r.meta).card).find((c) => c?.type === "contact_form");
    expect(card.consent.text).toBe("Acme Support Ltd may contact me.");
    // validated like the workspace's settings
    expect((await w.http.patch(`/api/departments/${w.billing.id}`, { visitor_info: { custom_fields: { order: "sometimes" } } }, w.token)).status).toBe(400);
    expect((await w.http.patch(`/api/departments/${w.billing.id}`, { visitor_info: { consent: { privacy_url: "javascript:alert(1)" } } }, w.token)).status).toBe(400);
  });
});
