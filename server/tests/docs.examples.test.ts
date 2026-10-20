import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { client, makeCtx } from "./helpers.js";

/**
 * The curl flow in docs/API.md ("Authentication") run against an in-process app. The request bodies are taken from the document itself, so an
 * example that stops working (or a renamed field) fails here.
 */
function bodiesFromDoc(): { path: string; body: any }[] {
  const doc = readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8");
  const block = doc.match(/```bash\nBASE=[\s\S]*?```/)![0];
  const out: { path: string; body: any }[] = [];
  for (const m of block.matchAll(/curl -s "?\$BASE(\/[^\s"]*)"?[^\n]*\\\n\s*-d '(\{[^']*\})'/g)) out.push({ path: m[1]!, body: JSON.parse(m[2]!.replace(/<[^>]+>/g, "x")) });
  for (const m of block.matchAll(/curl -s \$BASE(\/[^\s]*) -H 'content-type: application\/json' \\\n\s*-d '(\{[^']*\})'/g)) if (!out.some((o) => o.path === m[1] && JSON.stringify(o.body) === m[2])) out.push({ path: m[1]!, body: JSON.parse(m[2]!) });
  return out;
}

describe("docs/API.md examples", () => {
  it("register, contact, conversation, idempotent send and history work exactly as documented", async () => {
    const ctx = await makeCtx();
    const http = client(createApp(ctx));
    const ex = bodiesFromDoc();
    const body = (p: string) => ex.find((e) => e.path.startsWith(p))!.body;
    expect(ex.length).toBeGreaterThanOrEqual(4);

    const reg = await http.post("/api/auth/register", body("/api/auth/register"));
    expect(reg.status).toBe(201);
    expect(Object.keys(reg.body)).toEqual(expect.arrayContaining(["token", "refresh_token", "expires_in", "user", "member", "workspace"]));
    const token = reg.body.token as string;

    const contact = await http.post("/api/contacts", body("/api/contacts"), token);
    expect(contact.status).toBe(201);
    const room = await http.post("/api/rooms", { ...body("/api/rooms"), contact_id: contact.body.id }, token);
    expect(room.status).toBe(201);

    const send = { ...body(`/api/rooms/`), };
    const first = await http.post(`/api/rooms/${room.body.room.id}/messages`, send, token);
    const again = await http.post(`/api/rooms/${room.body.room.id}/messages`, send, token);
    expect(first.status).toBe(201);
    expect(again.body.id).toBe(first.body.id); // "the same client_msg_id sent twice stores ONE message"
    const hist = await http.get(`/api/rooms/${room.body.room.id}/messages?limit=30`, token);
    expect(hist.status).toBe(200);
    expect(hist.body.data.filter((m: { content_text: string }) => m.content_text === "Hi Casey")).toHaveLength(1);
  });

  it("the documented error shape and the rate-limit headers are what the server returns", async () => {
    const ctx = await makeCtx();
    const http = client(createApp(ctx));
    const bad = await http.post("/api/auth/login", { email: "not-an-email" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(bad.body.error.details)).toBe(true);
    const reg = await http.post("/api/auth/register", { name: "Ada", email: "ada@example.test", password: "correct horse battery", workspace_name: "Acme" });
    const res = await createApp(ctx).request("/api/auth/me", { headers: { authorization: `Bearer ${reg.body.token}` } });
    expect(res.status).toBe(200);
    for (const h of ["ratelimit-policy", "ratelimit", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) expect(res.headers.get(h), h).toBeTruthy();
  });
});
