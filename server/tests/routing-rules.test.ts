import { describe, expect, it } from "vitest";
import { conditionHolds, createRule, deleteRule, listRules, matchRule, reorderRules, updateRule, type Condition } from "../src/services/routingRules.js";
import { updateDepartment } from "../src/services/departments.js";
import { addMemberRaw, mkInbox, tokenFor } from "./helpers.js";
import { widgetWorld } from "./widget-helpers.js";

const cond = (field: Condition["field"], op: Condition["op"], value = "", key?: string): Condition => ({ field, op, value, ...(key ? { key } : {}) });

describe("conditions", () => {
  it("compares text case-insensitively with the six operators", () => {
    const x = { page_url: "https://Shop.example.com/Pricing/pro", locale: "de-AT", channel: "dm" as const, email: "Ann@Acme.example", tags: ["VIP", "beta"], attrs: { plan: "Enterprise", app: { version: "4.2.0" } } };
    const t = (c: Condition) => conditionHolds(c, x);
    expect(t(cond("page_url", "contains", "/pricing"))).toBe(true);
    expect(t(cond("page_url", "starts_with", "https://shop.example.com"))).toBe(true);
    expect(t(cond("page_url", "ends_with", "/PRO"))).toBe(true);
    expect(t(cond("page_url", "equals", "https://shop.example.com/pricing/pro"))).toBe(true);
    expect(t(cond("page_url", "not_contains", "/docs"))).toBe(true);
    expect(t(cond("page_url", "not_equals", "x"))).toBe(true);
    expect(t(cond("locale", "starts_with", "de"))).toBe(true);
    expect(t(cond("channel", "equals", "sms"))).toBe(false);
    expect(t(cond("email_domain", "equals", "acme.example"))).toBe(true);
    expect(t(cond("tag", "equals", "vip"))).toBe(true);
    expect(t(cond("tag", "not_equals", "vip"))).toBe(false);
    expect(t(cond("tag", "equals", "gold"))).toBe(false);
    expect(t(cond("attr", "equals", "enterprise", "plan"))).toBe(true);
    expect(t(cond("attr", "starts_with", "4.", "version"))).toBe(true); // an app attribute sent through the widget
    expect(t(cond("attr", "exists", "", "plan"))).toBe(true);
    expect(t(cond("attr", "exists", "", "missing"))).toBe(false);
  });

  it("an unknown value is 'not' anything and never matches the positive operators; there is no regular expression syntax", () => {
    expect(conditionHolds(cond("page_url", "contains", "pricing"), {})).toBe(false);
    expect(conditionHolds(cond("page_url", "not_contains", "pricing"), {})).toBe(true);
    expect(conditionHolds(cond("email_domain", "equals", "acme.example"), { email: "no-at-sign" })).toBe(false);
    expect(conditionHolds(cond("page_url", "contains", "(a+)+$"), { page_url: "https://x.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" })).toBe(false); // literal text, instant
  });
});

describe("rules in order", () => {
  it("the first enabled rule whose conditions all hold wins; the trace shows what was looked at", async () => {
    const w = await widgetWorld();
    const sales = await mkInbox(w.ctx, w.owner, { name: "Sales" });
    const billing = await mkInbox(w.ctx, w.owner, { name: "Billing" });
    const r1 = await createRule(w.ctx, w.owner, { name: "Pricing page", enabled: true, conditions: [cond("page_url", "contains", "/pricing")], department_id: sales.id });
    await createRule(w.ctx, w.owner, { name: "Invoices", enabled: true, conditions: [cond("page_url", "contains", "/billing"), cond("tag", "equals", "customer")], department_id: billing.id });
    await createRule(w.ctx, w.owner, { name: "Disabled", enabled: false, conditions: [cond("locale", "equals", "de")], department_id: sales.id });
    expect((await matchRule(w.ctx, w.wsId, { page_url: "https://x.example/pricing" })).rule?.id).toBe(r1.id);
    const both = await matchRule(w.ctx, w.wsId, { page_url: "https://x.example/billing", tags: ["customer"] });
    expect(both.rule?.department_id).toBe(billing.id);
    expect(both.trace.map((t) => [t.name, t.matched])).toEqual([["Pricing page", false], ["Invoices", true]]);
    expect((await matchRule(w.ctx, w.wsId, { page_url: "https://x.example/billing" })).rule).toBeNull(); // all conditions must hold
    expect((await matchRule(w.ctx, w.wsId, { locale: "de" })).rule).toBeNull(); // disabled rules are skipped
  });

  it("reorder changes the priority and validates the list; updates and deletes are audited and scoped", async () => {
    const w = await widgetWorld();
    const other = await widgetWorld();
    const d = await mkInbox(w.ctx, w.owner, { name: "A" });
    const a = await createRule(w.ctx, w.owner, { name: "a", enabled: true, conditions: [cond("channel", "equals", "dm")], department_id: d.id });
    const e = await mkInbox(w.ctx, w.owner, { name: "E" });
    const b = await createRule(w.ctx, w.owner, { name: "b", enabled: true, conditions: [cond("channel", "equals", "dm")], department_id: e.id });
    expect((await matchRule(w.ctx, w.wsId, { channel: "dm" })).rule?.id).toBe(a.id);
    await reorderRules(w.ctx, w.owner, [b.id, a.id]);
    expect((await matchRule(w.ctx, w.wsId, { channel: "dm" })).rule?.id).toBe(b.id);
    await expect(reorderRules(w.ctx, w.owner, [b.id])).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await expect(reorderRules(w.ctx, w.owner, [b.id, b.id])).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await updateRule(w.ctx, w.owner, a.id, { name: "renamed", enabled: false });
    expect((await listRules(w.ctx, w.wsId)).find((r) => r.id === a.id)).toMatchObject({ name: "renamed", enabled: 0 });
    await expect(updateRule(other.ctx, other.owner, a.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteRule(other.ctx, other.owner, a.id)).rejects.toMatchObject({ status: 404 });
    await deleteRule(w.ctx, w.owner, a.id);
    expect(await listRules(w.ctx, w.wsId)).toHaveLength(1);
    const actions = (await w.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'routing_rule.%' ORDER BY created_at, id")).map((r) => r.action);
    expect(actions).toEqual(["routing_rule.created", "routing_rule.created", "routing_rule.reordered", "routing_rule.updated", "routing_rule.deleted"]);
  });

  it("validation: unknown department, empty values, attribute without a name, too many conditions or rules", async () => {
    const w = await widgetWorld();
    const d = await mkInbox(w.ctx, w.owner, { name: "A" });
    await expect(createRule(w.ctx, w.owner, { name: "x", enabled: true, conditions: [cond("channel", "equals", "dm")], department_id: "inb_missing" })).rejects.toMatchObject({ code: "UNKNOWN_DEPARTMENT" });
    await expect(createRule(w.ctx, w.owner, { name: "x", enabled: true, conditions: [cond("page_url", "contains", "")], department_id: d.id })).rejects.toMatchObject({ code: "VALUE_REQUIRED" });
    await expect(createRule(w.ctx, w.owner, { name: "x", enabled: true, conditions: [cond("attr", "exists")], department_id: d.id })).rejects.toMatchObject({ code: "ATTR_KEY_REQUIRED" });
    const http = (body: object) => w.http.post("/api/routing-rules", body, w.token);
    expect((await http({ name: "x", conditions: [], department_id: d.id })).status).toBe(400);
    expect((await http({ name: "x", conditions: Array.from({ length: 6 }, () => cond("channel", "equals", "dm")), department_id: d.id })).status).toBe(400);
    expect((await http({ name: "x", conditions: [{ field: "regex", op: "equals", value: "x" }], department_id: d.id })).status).toBe(400);
    for (let i = 0; i < 50; i++) await createRule(w.ctx, w.owner, { name: `r${i}`, enabled: true, conditions: [cond("channel", "equals", "dm")], department_id: d.id });
    await expect(createRule(w.ctx, w.owner, { name: "one too many", enabled: true, conditions: [cond("channel", "equals", "dm")], department_id: d.id })).rejects.toMatchObject({ code: "TOO_MANY_RULES" });
  });

  it("over HTTP: managers only, the sandbox answers with the department and the trace, other workspaces see nothing", async () => {
    const w = await widgetWorld();
    const other = await widgetWorld();
    const d = await mkInbox(w.ctx, w.owner, { name: "Sales" });
    const created = await w.http.post("/api/routing-rules", { name: "Pricing", conditions: [cond("page_url", "contains", "/pricing")], department_id: d.id }, w.token);
    expect(created.status).toBe(201);
    const agent = await tokenFor(w.ctx, await addMemberRaw(w.ctx, w.wsId, { name: "Ann", role: "agent" }));
    expect((await w.http.get("/api/routing-rules", agent)).status).toBe(403);
    expect((await w.http.post("/api/routing-rules/test", {}, agent)).status).toBe(403);
    const test = await w.http.post("/api/routing-rules/test", { page_url: "https://x.example/pricing?utm=1" }, w.token);
    expect(test.body).toMatchObject({ department_id: d.id, rule: { name: "Pricing" }, evaluated: [{ name: "Pricing", matched: true }] });
    expect((await w.http.post("/api/routing-rules/test", { page_url: "https://x.example/docs" }, w.token)).body.department_id).toBeNull();
    const ot = await tokenFor(other.ctx, other.owner);
    expect((await other.http.get("/api/routing-rules", ot)).body.data).toEqual([]);
    expect((await other.http.patch(`/api/routing-rules/${created.body.id}`, { name: "hijack" }, ot)).status).toBe(404);
    expect((await w.http.put("/api/routing-rules/order", { ids: [created.body.id] }, w.token)).body.data).toHaveLength(1);
    expect((await w.http.del(`/api/routing-rules/${created.body.id}`, w.token)).status).toBe(204);
  });
});

describe("choosing the department of a new conversation (widget)", () => {
  async function world() {
    const w = await widgetWorld();
    const sales = await mkInbox(w.ctx, w.owner, { name: "Sales", live_routing_visibility: true });
    const hidden = await mkInbox(w.ctx, w.owner, { name: "Internal" });
    const dflt = await mkInbox(w.ctx, w.owner, { name: "General" });
    await w.http.patch("/api/workspace", { settings: { widget: { default_inbox_id: dflt.id } } }, w.token);
    await createRule(w.ctx, w.owner, { name: "Pricing", enabled: true, conditions: [cond("page_url", "contains", "/pricing")], department_id: hidden.id });
    return { ...w, sales, hidden, dflt };
  }
  const inboxOf = async (w: Awaited<ReturnType<typeof world>>, roomId: string) => (await w.ctx.db.get<{ inbox_id: string | null }>("SELECT inbox_id FROM rooms WHERE id = ?", roomId))!.inbox_id;

  it("the visitor's own choice wins, then a matching rule, then the widget default", async () => {
    const w = await world();
    const a = await w.newSession({}, "device-aaaa-0001");
    const picked = await w.http.post("/public/rooms", { department_id: w.sales.id, page_url: "https://x.example/pricing" }, undefined, a.headers);
    expect(picked.status).toBe(201);
    expect(await inboxOf(w, picked.body.room.id)).toBe(w.sales.id);
    const b = await w.newSession({}, "device-aaaa-0002");
    const ruled = await w.http.post("/public/rooms", { page_url: "https://x.example/pricing?secret=1#frag" }, undefined, b.headers);
    expect(await inboxOf(w, ruled.body.room.id)).toBe(w.hidden.id); // a rule may route to a department that is not offered in the picker
    const c = await w.newSession({}, "device-aaaa-0003");
    const plain = await w.http.post("/public/rooms", {}, undefined, c.headers);
    expect(await inboxOf(w, plain.body.room.id)).toBe(w.dflt.id);
    const d = await w.newSession({}, "device-aaaa-0004");
    const noBody = await w.http.call("POST", "/public/rooms", { headers: d.headers });
    expect(noBody.status).toBe(201); // an empty body is still fine (older embeds)
  });

  it("only departments marked visible in the widget can be picked", async () => {
    const w = await world();
    const s = await w.newSession();
    const res = await w.http.post("/public/rooms", { department_id: w.hidden.id }, undefined, s.headers);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INBOX_NOT_AVAILABLE");
    expect((await w.http.post("/public/rooms", { department_id: "x".repeat(70) }, undefined, s.headers)).status).toBe(400);
  });

  it("keeps where the visitor is, without query string or fragment, and their language, as context for later routing", async () => {
    const w = await world();
    const s = await w.newSession();
    const res = await w.http.post("/public/rooms", { page_url: "https://x.example/pricing/pro?token=abc#top", locale: "pt-BR" }, undefined, s.headers);
    const meta = JSON.parse((await w.ctx.db.get<{ meta: string }>("SELECT meta FROM rooms WHERE id = ?", res.body.room.id))!.meta);
    expect(meta.context).toEqual({ page_url: "https://x.example/pricing/pro", locale: "pt-BR" });
    const s2 = await w.newSession({}, "device-aaaa-0009");
    const bad = await w.http.post("/public/rooms", { page_url: "javascript:alert(1)" }, undefined, s2.headers);
    expect(JSON.parse((await w.ctx.db.get<{ meta: string }>("SELECT meta FROM rooms WHERE id = ?", bad.body.room.id))!.meta).context).toBeUndefined();
    expect(await inboxOf(w, bad.body.room.id)).toBe(w.dflt.id);
  });

  it("the widget config lists the departments offered with whether they are open and anyone is free, and never leaks others", async () => {
    const w = await world();
    await updateDepartment(w.ctx, w.owner, w.sales.id, { description: "Plans and quotes", hours: { enabled: true, timezone: "UTC", days: [], holidays: [] } });
    const cfg = await w.http.get("/public/widget/config", undefined, w.h());
    expect(cfg.body.departments).toEqual([{ id: w.sales.id, name: "Sales", description: "Plans and quotes", icon: "inbox", open: false, available: false }]);
    expect(JSON.stringify(cfg.body)).not.toContain(w.hidden.id);
    expect(cfg.body.widget.department_selector).toBe(false);
    await w.http.patch("/api/workspace", { settings: { widget: { department_selector: true } } }, w.token);
    expect((await w.http.get("/public/widget/config", undefined, w.h())).body.widget.department_selector).toBe(true);
  });
});
