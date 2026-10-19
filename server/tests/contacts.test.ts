import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone } from "../src/util/phone.js";
import { parseCsv } from "../src/util/csv.js";
import { findOrCreateContact, importContactsCsv } from "../src/services/contacts.js";
import { fullApp, setSettings } from "./helpers.js";

describe("phone normalisation", () => {
  const table: [string, string, string | null][] = [
    ["(415) 555-2671", "US", "+14155552671"],
    ["415-555-2671", "US", "+14155552671"],
    ["+1 415 555 2671", "US", "+14155552671"],
    ["+14155552671", "GB", "+14155552671"],
    ["020 7946 0958", "GB", "+442079460958"],
    ["07911 123456", "GB", "+447911123456"],
    ["+91 98765 43210", "US", "+919876543210"],
    ["98765 43210", "IN", "+919876543210"],
    ["12345", "US", null],
    ["not a phone", "US", null],
    ["", "US", null],
    ["   ", "US", null],
    ["+999 123", "US", null],
    ["555-0100", "US", null],
  ];
  it.each(table)("%s (%s) -> %s", (input, region, expected) => {
    expect(normalizePhone(input, region)).toBe(expected);
  });
  it("handles null/undefined and bad region codes without throwing", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("415-555-2671", "ZZ")).toBeNull();
  });
  it("normalises emails", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(normalizeEmail("")).toBeNull();
  });
});

describe("contacts API", () => {
  it("creates, normalises, updates and deletes", async () => {
    const { http, token } = await fullApp();
    const c = await http.post("/api/contacts", { name: "  Dana Lee ", email: "Dana@Example.test", phone: "(415) 555-2671", tags: ["VIP", "vip", " new "] }, token);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: "Dana Lee", email: "dana@example.test", phone: "+14155552671", tags: ["vip", "new"], source: "manual" });
    const up = await http.patch(`/api/contacts/${c.body.id}`, { attrs: { plan: "pro" }, phone: null, sms_opt_out: true }, token);
    expect(up.body.attrs).toEqual({ plan: "pro" });
    expect(up.body.phone).toBeNull();
    expect(up.body.sms_opt_out).toBe(true);
    expect((await http.patch(`/api/contacts/${c.body.id}`, { attrs: { plan: null } }, token)).body.attrs).toEqual({});
    expect((await http.del(`/api/contacts/${c.body.id}`, token)).status).toBe(204);
    expect((await http.get(`/api/contacts/${c.body.id}`, token)).status).toBe(404);
  });

  it("uses the workspace default region for local numbers", async () => {
    const { ctx, http, wsId, token } = await fullApp();
    setSettings(ctx, wsId, { default_region: "GB" });
    const c = await http.post("/api/contacts", { name: "Brit", phone: "020 7946 0958" }, token);
    expect(c.body.phone).toBe("+442079460958");
  });

  it("rejects invalid phones, empty contacts and bad emails", async () => {
    const { http, token } = await fullApp();
    expect((await http.post("/api/contacts", { name: "X", phone: "12" }, token)).body.error.code).toBe("INVALID_PHONE");
    expect((await http.post("/api/contacts", {}, token)).body.error.code).toBe("CONTACT_EMPTY");
    expect((await http.post("/api/contacts", { name: "X", email: "nope" }, token)).status).toBe(400);
  });

  it("dedupes by email (case-insensitive) and by normalised phone, scoped per workspace", async () => {
    const { ctx, http, token } = await fullApp();
    const a = await http.post("/api/contacts", { name: "A", email: "dup@example.test", phone: "415-555-2671" }, token);
    const byEmail = await http.post("/api/contacts", { name: "B", email: "DUP@example.test" }, token);
    expect(byEmail.status).toBe(409);
    expect(byEmail.body.error.details.existing_id).toBe(a.body.id);
    expect((await http.post("/api/contacts", { name: "C", phone: "+1 (415) 555-2671" }, token)).status).toBe(409);
    const b = await http.post("/api/contacts", { name: "D", email: "d@example.test" }, token);
    expect((await http.patch(`/api/contacts/${b.body.id}`, { email: "dup@example.test" }, token)).status).toBe(409);
    // another workspace may reuse the same identity
    const { seedWorkspace, tokenFor } = await import("./helpers.js");
    const other = await seedWorkspace(ctx, "Other");
    expect((await http.post("/api/contacts", { name: "A", email: "dup@example.test" }, await tokenFor(ctx, other.owner))).status).toBe(201);
  });

  it("find-or-create merges missing details into the existing contact", async () => {
    const { ctx, wsId } = await fullApp();
    const first = findOrCreateContact(ctx, wsId, { email: "m@example.test" });
    expect(first.created).toBe(true);
    const again = findOrCreateContact(ctx, wsId, { email: "M@example.test", phone: "415-555-2671", name: "Mo" });
    expect(again.created).toBe(false);
    expect(again.contact).toMatchObject({ id: first.contact.id, phone: "+14155552671", name: "Mo" });
    const byPhone = findOrCreateContact(ctx, wsId, { phone: "+14155552671" });
    expect(byPhone.contact.id).toBe(first.contact.id);
  });

  it("searches by name/email/phone treating wildcard and SQL characters literally", async () => {
    const { http, token } = await fullApp();
    await http.post("/api/contacts", { name: "100% Real", email: "real@example.test" }, token);
    await http.post("/api/contacts", { name: "Under_score", email: "u@example.test" }, token);
    await http.post("/api/contacts", { name: "Plain Person", email: "plain@example.test", phone: "415-555-2671" }, token);
    const names = async (q: string) => (await http.get(`/api/contacts?search=${encodeURIComponent(q)}`, token)).body.data.map((c: any) => c.name);
    expect(await names("real")).toEqual(["100% Real"]);
    expect(await names("%")).toEqual(["100% Real"]);
    expect(await names("_")).toEqual(["Under_score"]);
    expect(await names("4155552671")).toEqual(["Plain Person"]);
    expect(await names("+1415")).toEqual(["Plain Person"]);
    expect(await names("'; DROP TABLE contacts;--")).toEqual([]);
    expect((await http.get("/api/contacts", token)).body.pagination.total).toBe(3);
  });

  it("filters by tag and paginates with a max page size of 100", async () => {
    const { http, token } = await fullApp();
    for (let i = 0; i < 5; i++) await http.post("/api/contacts", { name: `C${i}`, email: `c${i}@example.test`, tags: i % 2 ? ["odd"] : ["even"] }, token);
    expect((await http.get("/api/contacts?tag=odd", token)).body.data).toHaveLength(2);
    const p = await http.get("/api/contacts?limit=2&page=3", token);
    expect(p.body.data).toHaveLength(1);
    expect((await http.get("/api/contacts?limit=101", token)).status).toBe(400);
  });

  it("manages notes", async () => {
    const { http, token } = await fullApp();
    const c = await http.post("/api/contacts", { name: "N" }, token);
    const n = await http.post(`/api/contacts/${c.body.id}/notes`, { body: "Prefers email" }, token);
    expect(n.status).toBe(201);
    expect((await http.get(`/api/contacts/${c.body.id}/notes`, token)).body.data).toHaveLength(1);
    expect((await http.post(`/api/contacts/${c.body.id}/notes`, { body: "   " }, token)).status).toBe(400);
    expect((await http.del(`/api/contacts/${c.body.id}/notes/${n.body.id}`, token)).status).toBe(204);
  });
});

describe("contact CSV import", () => {
  it("parses quoted fields, escaped quotes, CRLF and BOM", () => {
    expect(parseCsv('﻿name,email\r\n"Lee, Dana","d@x.test"\r\n"He said ""hi""",\r\n\r\n')).toEqual([["name", "email"], ["Lee, Dana", "d@x.test"], ['He said "hi"', ""]]);
  });
  it("creates, updates, skips and reports row errors", async () => {
    const { ctx, wsId } = await fullApp();
    const csv = [
      "name,email,phone,tags,plan",
      "Ann,ann@example.test,415-555-2671,vip;new,pro",
      "Bob,bob@example.test,not-a-phone,,",
      ",,,,pro",
      "Ann Again,ANN@example.test,,lead,",
    ].join("\n");
    const res = importContactsCsv(ctx, wsId, csv);
    expect(res).toMatchObject({ created: 1, updated: 1, skipped: 1 });
    expect(res.errors).toEqual([{ row: 3, error: "Phone number is not valid" }]);
    const ann = ctx.db.get<{ tags: string; attrs: string }>("SELECT tags, attrs FROM contacts WHERE email = 'ann@example.test'")!;
    expect(JSON.parse(ann.tags)).toEqual(["vip", "new", "lead"]);
    expect(JSON.parse(ann.attrs)).toEqual({ plan: "pro" });
  });
  it("rejects files without a recognisable header and oversize imports; works over HTTP (multipart and raw)", async () => {
    const { ctx, wsId, http, token } = await fullApp();
    expect(() => importContactsCsv(ctx, wsId, "foo,bar\n1,2")).toThrow(/header/);
    expect(() => importContactsCsv(ctx, wsId, "name\n" + "x\n".repeat(30), 10)).toThrow(/At most/);
    const raw = await http.call("POST", "/api/contacts/import", { token, raw: "name,email\nZed,zed@example.test", headers: { "content-type": "text/csv" } });
    expect(raw.body.created).toBe(1);
    const form = new FormData();
    form.set("file", new File(["name,email\nYan,yan@example.test"], "c.csv", { type: "text/csv" }));
    expect((await http.call("POST", "/api/contacts/import", { token, form })).body.created).toBe(1);
  });
});
