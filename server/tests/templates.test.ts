import { describe, expect, it } from "vitest";
import { renderTemplateText } from "../src/services/templates.js";
import { fullApp, mkRoom, seedWorkspace, tokenFor, addMemberRaw } from "./helpers.js";

const contact = (o: Partial<{ name: string; email: string | null; phone: string | null; attrs: string }> = {}) => ({
  name: "Dana Lee-Smith",
  email: "dana@example.test",
  phone: "+14155552671",
  attrs: JSON.stringify({ Plan: "Pro", seats: 5, nested: { a: 1 } }),
  ...o,
});
const data = { contact: contact(), agent: { name: "Olivia Owner" }, workspace: { name: "Acme" } };

describe("template merge fields", () => {
  it("substitutes the supported fields", () => {
    expect(
      renderTemplateText("Hi {{contact.first_name}} {{contact.last_name}} / {{contact.name}}, {{agent.name}} ({{agent.first_name}}) at {{workspace.name}}", data),
    ).toBe("Hi Dana Lee-Smith / Dana Lee-Smith, Olivia Owner (Olivia) at Acme");
    expect(renderTemplateText("{{contact.email}} {{contact.phone}}", data)).toBe("dana@example.test +14155552671");
  });
  it("is whitespace tolerant and case-insensitive on the field path", () => {
    expect(renderTemplateText("{{ contact.first_name }}|{{CONTACT.First_Name}}|{{  contact.first_name  |  there  }}", data)).toBe("Dana|Dana|Dana");
  });
  it("uses the fallback when the value is empty or missing", () => {
    const empty = { ...data, contact: contact({ name: "", email: null }) };
    expect(renderTemplateText("Hi {{contact.first_name|there}}!", empty)).toBe("Hi there!");
    expect(renderTemplateText("Mail {{contact.email|your inbox}}", empty)).toBe("Mail your inbox");
    expect(renderTemplateText("Hi {{contact.first_name|}}!", empty)).toBe("Hi !");
    expect(renderTemplateText("Hi {{contact.first_name| there }}!", empty)).toBe("Hi there!");
    expect(renderTemplateText("Hi {{contact.first_name|there}}!", { ...data, contact: null })).toBe("Hi there!");
  });
  it("renders unknown fields empty (or with the fallback), never the raw tag", () => {
    expect(renderTemplateText("[{{contact.favorite_color}}][{{foo.bar}}][{{nothing}}][{{contact.nope|n/a}}][{{agent.salary}}]", data)).toBe("[][][][n/a][]");
    expect(renderTemplateText("{{ }} {{contact.}} {{", data)).not.toContain("contact.first");
    expect(renderTemplateText("{{contact.first_name", data)).toBe("{{contact.first_name");
  });
  it("exposes custom attributes (case-insensitive) but never objects", () => {
    expect(renderTemplateText("{{contact.plan}} / {{contact.seats}} / [{{contact.nested}}] / {{contact.attrs.plan}}", data)).toBe("Pro / 5 / [] / Pro");
  });
  it("escapes substituted values for HTML but leaves the template markup alone", () => {
    const evil = { ...data, contact: contact({ name: `<img src=x onerror=alert(1)> & "Co"` }) };
    expect(renderTemplateText("<p>Hi {{contact.name}}</p>", evil, "html")).toBe("<p>Hi &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;</p>");
    expect(renderTemplateText("Hi {{contact.name}}", evil, "text")).toBe(`Hi <img src=x onerror=alert(1)> & "Co"`);
    expect(renderTemplateText("{{contact.first_name|<b>x</b>}}", { ...data, contact: contact({ name: "" }) }, "html")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
  it("does not re-expand values that themselves look like merge fields", () => {
    const tricky = { ...data, contact: contact({ name: "{{agent.name}}" }) };
    expect(renderTemplateText("{{contact.name}}", tricky)).toBe("{{agent.name}}");
  });
});

describe("templates API", () => {
  it("creates, lists, updates, renders server-side and deletes", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    const { room, contact: c } = await mkRoom(ctx, wsId, { contact: { name: "Dana Lee", email: "d@example.test" } });
    const t = await http.post(
      "/api/templates",
      {
        name: "Greeting",
        channel: "email",
        subject: "Hello {{contact.first_name|there}}",
        body: "Hi {{contact.first_name|there}},\n{{agent.name}} from {{workspace.name}}",
        shortcut: "hello",
      },
      token,
    );
    expect(t.status).toBe(201);
    expect((await http.get("/api/templates", token)).body.data).toHaveLength(1);
    const byRoom = await http.post(`/api/templates/${t.body.id}/render`, { room_id: room.id }, token);
    expect(byRoom.body).toEqual({ subject: "Hello Dana", body: "Hi Dana,\nOlivia Owner from Acme" });
    expect((await http.post(`/api/templates/${t.body.id}/render`, { contact_id: c.id, format: "html" }, token)).body.body).toContain("Dana");
    expect((await http.post(`/api/templates/${t.body.id}/render`, {}, token)).body.body).toBe("Hi there,\nOlivia Owner from Acme");
    expect((await http.patch(`/api/templates/${t.body.id}`, { name: "Renamed", subject: null }, token)).body).toMatchObject({
      name: "Renamed",
      subject: null,
      body: expect.any(String),
    });
    expect((await http.del(`/api/templates/${t.body.id}`, token)).status).toBe(204);
    expect((await http.get("/api/templates", token)).body.data).toEqual([]);
  });
  it("validates input and enforces unique shortcuts per workspace", async () => {
    const { ctx, http, token } = await fullApp();
    expect((await http.post("/api/templates", { name: "", body: "x" }, token)).status).toBe(400);
    expect((await http.post("/api/templates", { name: "x", body: "x", shortcut: "no spaces" }, token)).status).toBe(400);
    expect((await http.post("/api/templates", { name: "x", body: "x", channel: "fax" }, token)).status).toBe(400);
    await http.post("/api/templates", { name: "One", body: "x", shortcut: "Hi" }, token);
    expect((await http.post("/api/templates", { name: "Two", body: "x", shortcut: "hi" }, token)).body.error.code).toBe("TEMPLATE_EXISTS");
    const other = await seedWorkspace(ctx, "Other");
    expect((await http.post("/api/templates", { name: "Two", body: "x", shortcut: "hi" }, await tokenFor(ctx, other.owner))).status).toBe(201);
  });
  it("isolates workspaces and renders for rooms outside the agent's reach safely", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    const t = await http.post("/api/templates", { name: "T", body: "Hi {{contact.first_name|there}}" }, token);
    const other = await seedWorkspace(ctx, "Other");
    const ot = await tokenFor(ctx, other.owner);
    expect((await http.post(`/api/templates/${t.body.id}/render`, {}, ot)).status).toBe(404);
    const { contact } = await mkRoom(ctx, wsId, { contact: { name: "Secret Person" } });
    expect((await http.post(`/api/templates/${t.body.id}/render`, { contact_id: contact.id }, ot)).status).toBe(404);
    expect(await addMemberRaw(ctx, wsId, { name: "A" })).toBeTruthy();
  });
});
