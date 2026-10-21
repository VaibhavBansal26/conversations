import { describe, expect, it } from "vitest";
import { identityMessage, signIdentity } from "../src/services/identity.js";
import { encryptWithDataKey } from "../src/util/dataCrypto.js";
import { addMemberRaw, fullApp, mkContact, seedWorkspace, tokenFor } from "./helpers.js";

const OWN = "http://localhost:3000";
const DEVICE = "device-ident-0001";

async function world() {
  const f = await fullApp();
  const created = await f.http.post("/api/tokens", { domain: "shop.example.com", hosted_chat_enabled: true }, f.token);
  const apiKey = created.body.token as string;
  const page = (device = DEVICE) => ({ "x-api-key": apiKey, "x-device-id": device, "x-hosted-chat": "1", origin: OWN });
  const session = (body: object, device = DEVICE) => f.http.post("/public/sessions", body, undefined, page(device));
  const secret = async () => (await f.http.post("/api/identity/rotate", {}, f.token)).body.secret as string;
  const contacts = () => f.ctx.db.all<{ id: string; email: string | null; external_id: string | null; name: string }>("SELECT id, email, external_id, name FROM contacts WHERE workspace_id = ? ORDER BY created_at, id", f.wsId);
  return { ...f, apiKey, page, session, secret, contacts };
}

describe("identity secret management", () => {
  it("is created once, shown once, never listed; rotation replaces it; enforce needs a secret; everything is audited and manager-only", async () => {
    const w = await world();
    expect((await w.http.get("/api/identity", w.token)).body).toEqual({ configured: false, enforce: false, rotated_at: null });
    expect((await w.http.call("PATCH", "/api/identity", { token: w.token, json: { enforce: true } })).body.error.code).toBe("IDENTITY_NOT_CONFIGURED");
    const first = await w.http.post("/api/identity/rotate", {}, w.token);
    expect(first.status).toBe(201);
    expect(first.body.secret).toMatch(/^cvi_[A-Za-z0-9_-]{40,}$/);
    const status = await w.http.get("/api/identity", w.token);
    expect(JSON.stringify(status.body)).not.toContain("cvi_");
    expect(status.body).toMatchObject({ configured: true, enforce: false });
    // stored sealed, not in clear
    const stored = (await w.ctx.db.get<{ secret: string }>("SELECT secret FROM workspace_identity WHERE workspace_id = ?", w.wsId))!.secret;
    expect(stored).not.toContain(first.body.secret);
    expect(stored.startsWith("enc2.")).toBe(true);
    const second = await w.http.post("/api/identity/rotate", {}, w.token);
    expect(second.body.secret).not.toBe(first.body.secret);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM workspace_identity")).toEqual({ n: 1 });
    expect((await w.http.call("PATCH", "/api/identity", { token: w.token, json: { enforce: true } })).body).toMatchObject({ configured: true, enforce: true });
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'identity.%'")).toEqual({ n: 3 });
    const agent = await addMemberRaw(w.ctx, w.wsId, { role: "agent" });
    const at = await tokenFor(w.ctx, agent);
    expect((await w.http.get("/api/identity", at)).status).toBe(403);
    expect((await w.http.post("/api/identity/rotate", {}, at)).status).toBe(403);
    // another workspace has its own (none)
    const other = await seedWorkspace(w.ctx, "Beta");
    expect((await w.http.get("/api/identity", await tokenFor(w.ctx, other.owner))).body.configured).toBe(false);
  });

});

describe("identity_hash verification matrix", () => {
  it("reference vector: HMAC-SHA256 hex over external_id|lower(email)", () => {
    // the vectors documented in docs/MOBILE-BRIDGE.md; every snippet there must print these values
    expect(identityMessage("u_42", "Ana@Example.com ")).toBe("u_42|ana@example.com");
    expect(identityMessage(undefined, "ana@example.com")).toBe("|ana@example.com");
    expect(identityMessage("u_42", undefined)).toBe("u_42|");
    expect(signIdentity("secret-for-docs", "u_42", "ana@example.com")).toBe("a584a401ae7c12353a79e19cc23d1747144c637916777606506ed0b3862e6336");
    expect(signIdentity("secret-for-docs", undefined, "Ana@Example.com")).toBe("7b9a785b58d36ecd98dc92f490e82d59fbf5d78101be7f760836788b195f0743");
    expect(signIdentity("secret-for-docs", "u_42", undefined)).toBe("25fb47472598367fc73affa8a5d2e4e5c973d6b5fffa4dd7aa7cdb3d3cfda24a");
  });

  it("valid hash: identified and verified in one step, no code; the same user on another device lands in the same contact and conversation", async () => {
    const w = await world();
    const secret = await w.secret();
    const hash = signIdentity(secret, "u_42", "ana@example.com");
    const s = await w.session({ name: "Ana", email: "Ana@Example.com", external_id: "u_42", identity_hash: hash });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ verified: true, requires_verification: false });
    expect(await w.contacts()).toMatchObject([{ email: "ana@example.com", external_id: "u_42", name: "Ana" }]);
    const sess = { "x-support-session": s.body.session_token, "x-device-id": DEVICE, origin: OWN };
    const room = await w.http.post("/public/rooms", {}, undefined, sess);
    await w.http.post(`/public/rooms/${room.body.room.id}/messages`, { content: "hello from phone" }, undefined, sess);
    // second device, same signed identity: no OTP, same history
    const s2 = await w.session({ email: "ana@example.com", external_id: "u_42", identity_hash: hash }, "device-ident-0002");
    expect(s2.body).toMatchObject({ verified: true, requires_verification: false });
    const sess2 = { "x-support-session": s2.body.session_token, "x-device-id": "device-ident-0002", origin: OWN };
    const rooms = await w.http.get("/public/rooms", undefined, sess2);
    expect(rooms.body.data.map((r: { id: string }) => r.id)).toEqual([room.body.room.id]);
    expect((await w.contacts()).length).toBe(1);
  });

  it("external id only (no email) works; a later email-only hash adopts the existing contact and keeps the id", async () => {
    const w = await world();
    const secret = await w.secret();
    const a = await w.session({ external_id: "u_7", identity_hash: signIdentity(secret, "u_7", undefined), name: "Guest 7" });
    expect(a.status).toBe(201);
    expect((await w.contacts())[0]).toMatchObject({ external_id: "u_7", email: null });
    // an email-only identity of a contact that exists without an external id gets the id attached
    await w.ctx.db.run("INSERT INTO contacts(id, workspace_id, name, email, created_at, updated_at) VALUES ('con_pre', ?, 'Pre', 'pre@example.com', ?, ?)", w.wsId, w.ctx.clock().toISOString(), w.ctx.clock().toISOString());
    const b = await w.session({ email: "pre@example.com", external_id: "u_8", identity_hash: signIdentity(secret, "u_8", "pre@example.com") }, "device-ident-0003");
    expect(b.status).toBe(201);
    expect(await w.ctx.db.get("SELECT external_id FROM contacts WHERE id = 'con_pre'")).toEqual({ external_id: "u_8" });
  });

  it("a wrong, tampered or other-secret hash is a 401, even with enforcement off; a hash needs something to sign", async () => {
    const w = await world();
    const secret = await w.secret();
    const good = signIdentity(secret, "u_42", "ana@example.com");
    const bad: [string, object][] = [
      ["wrong external id", { email: "ana@example.com", external_id: "u_43", identity_hash: good }],
      ["wrong email", { email: "bob@example.com", external_id: "u_42", identity_hash: good }],
      ["other secret", { email: "ana@example.com", external_id: "u_42", identity_hash: signIdentity("not-the-secret", "u_42", "ana@example.com") }],
      ["not hex", { email: "ana@example.com", external_id: "u_42", identity_hash: "z".repeat(64) }],
      ["short", { email: "ana@example.com", external_id: "u_42", identity_hash: good.slice(0, 40) }],
      ["uppercase tamper is fine but a flipped nibble is not", { email: "ana@example.com", external_id: "u_42", identity_hash: (good[0] === "0" ? "1" : "0") + good.slice(1) }],
    ];
    for (const [label, body] of bad) {
      const r = await w.session(body);
      expect([label, r.status, r.body.error?.code]).toEqual([label, 401, "IDENTITY_HASH_INVALID"]);
    }
    expect((await w.contacts()).length).toBe(0);
    expect((await w.session({ identity_hash: good })).body.error.code).toBe("IDENTITY_REQUIRED");
    // the hash is accepted case-insensitively
    expect((await w.session({ email: "ana@example.com", external_id: "u_42", identity_hash: good.toUpperCase() })).status).toBe(201);
  });

  it("no secret configured: a hash is refused loudly, an unsigned external_id is ignored", async () => {
    const w = await world();
    expect((await w.session({ email: "a@example.com", external_id: "u_1", identity_hash: "a".repeat(64) })).body.error.code).toBe("IDENTITY_NOT_CONFIGURED");
    const r = await w.session({ email: "a@example.com", external_id: "u_1" });
    expect(r.status).toBe(201);
    expect(r.body.verified).toBe(false);
    expect((await w.contacts())[0]).toMatchObject({ email: "a@example.com", external_id: null });
  });

  it("enforcement off + no hash: legacy behaviour, a typed email of a known contact needs the code", async () => {
    const w = await world();
    await w.secret();
    const known = await mkContact(w.ctx, w.wsId, { email: "known@example.com", name: "Known" });
    const first = await w.session({ email: "known@example.com" });
    expect(first.status).toBe(201);
    expect(first.body.verified).toBe(false);
    expect((await w.contacts()).filter((c) => c.id === known.id).length).toBe(1);
  });

  it("enforcement on: unsigned identity params are ignored and the visitor stays anonymous; signed ones still work", async () => {
    const w = await world();
    const secret = await w.secret();
    await w.http.call("PATCH", "/api/identity", { token: w.token, json: { enforce: true } });
    const victim = await mkContact(w.ctx, w.wsId, { email: "victim@example.com", name: "Victim" });
    const attack = await w.session({ name: "Mallory", email: "victim@example.com", phone: "+14155550123", external_id: "u_victim" });
    expect(attack.status).toBe(201);
    expect(attack.body.verified).toBe(false);
    expect(attack.body.requires_verification).toBe(false);
    expect(attack.body.contact.id).not.toBe(victim.id);
    const cs = await w.contacts();
    const mallory = cs.find((c) => c.id === attack.body.contact.id)!;
    expect(mallory).toMatchObject({ email: null, external_id: null });
    // the attacker cannot read the victim's conversation
    const sess = { "x-support-session": attack.body.session_token, "x-device-id": DEVICE, origin: OWN };
    expect((await w.http.get("/public/rooms", undefined, sess)).body.data).toEqual([]);
    // signed identity under enforcement
    const ok = await w.session({ email: "victim@example.com", identity_hash: signIdentity(secret, undefined, "victim@example.com") }, "device-ident-0009");
    expect(ok.body).toMatchObject({ verified: true });
    expect(ok.body.contact.id).toBe(victim.id);
    // required info is still demanded even though it is not used to identify
    await w.http.patch("/api/workspace", { settings: { widget: { required_info: ["email"] } } }, w.token);
    expect((await w.session({ name: "x" }, "device-ident-0010")).body.error.code).toBe("REQUIRED_INFO_MISSING");
  });

  it("conflicts: an email owned by another user id is refused; an id owned by another contact is reused, never duplicated", async () => {
    const w = await world();
    const secret = await w.secret();
    await w.session({ email: "a@example.com", external_id: "u_a", identity_hash: signIdentity(secret, "u_a", "a@example.com") });
    const clash = await w.session({ email: "a@example.com", external_id: "u_other", identity_hash: signIdentity(secret, "u_other", "a@example.com") }, "device-ident-0002");
    expect([clash.status, clash.body.error.code]).toEqual([409, "IDENTITY_CONFLICT"]);
    // same id again from the same person with no email: found by id
    const again = await w.session({ external_id: "u_a", identity_hash: signIdentity(secret, "u_a", undefined) }, "device-ident-0003");
    expect(again.status).toBe(201);
    expect((await w.contacts()).length).toBe(1);
  });

  it("tenant isolation: the same external id in two workspaces is two contacts, and one workspace's secret never verifies in the other", async () => {
    const a = await world();
    const secretA = await a.secret();
    const b = await seedWorkspace(a.ctx, "Beta");
    const bTok = await tokenFor(a.ctx, b.owner);
    const tb = await a.http.post("/api/tokens", { domain: "beta.example.com", hosted_chat_enabled: true }, bTok);
    const secretB = (await a.http.post("/api/identity/rotate", {}, bTok)).body.secret as string;
    expect(secretB).not.toBe(secretA);
    const hdrB = { "x-api-key": tb.body.token, "x-device-id": DEVICE, "x-hosted-chat": "1", origin: OWN };
    // A's signature is worthless in B
    expect((await a.http.post("/public/sessions", { email: "x@example.com", external_id: "u_1", identity_hash: signIdentity(secretA, "u_1", "x@example.com") }, undefined, hdrB)).body.error.code).toBe("IDENTITY_HASH_INVALID");
    const inA = await a.session({ email: "x@example.com", external_id: "u_1", identity_hash: signIdentity(secretA, "u_1", "x@example.com") });
    const inB = await a.http.post("/public/sessions", { email: "x@example.com", external_id: "u_1", identity_hash: signIdentity(secretB, "u_1", "x@example.com") }, undefined, hdrB);
    expect([inA.status, inB.status]).toEqual([201, 201]);
    expect(inA.body.contact.id).not.toBe(inB.body.contact.id);
    expect(await a.ctx.db.get("SELECT COUNT(*) n FROM contacts WHERE external_id = 'u_1'")).toEqual({ n: 2 });
  });

  it("an unreadable stored secret (data key lost) counts as not configured, never as 'accept anything'", async () => {
    const w = await world();
    const secret = await w.secret();
    await w.ctx.db.run("UPDATE workspace_identity SET secret = ? WHERE workspace_id = ?", encryptWithDataKey({ NODE_ENV: "test", JWT_SECRET: "x".repeat(32), DATA_ENCRYPTION_KEY: "ab".repeat(32) }, secret, `identity:${w.wsId}`), w.wsId);
    const r = await w.session({ email: "a@example.com", external_id: "u_1", identity_hash: signIdentity(secret, "u_1", "a@example.com") });
    expect(r.body.error.code).toBe("IDENTITY_NOT_CONFIGURED");
  });
});

describe("visitor extras used by the mobile chat", () => {
  async function chatting() {
    const w = await world();
    const s = await w.session({});
    const sess = { "x-support-session": s.body.session_token as string, "x-device-id": DEVICE, origin: OWN };
    const room = (await w.http.post("/public/rooms", {}, undefined, sess)).body.room.id as string;
    return { ...w, sess, room };
  }
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

  it("log-out ends the session at once", async () => {
    const w = await chatting();
    expect((await w.http.call("DELETE", "/public/session", { headers: w.sess })).status).toBe(204);
    expect((await w.http.get("/public/rooms", undefined, w.sess)).body.error.code).toBe("SESSION_EXPIRED");
  });

  it("host attributes are validated, merged under attrs.app, bounded, and null removes a key", async () => {
    const w = await chatting();
    const post = (attributes: unknown) => w.http.post("/public/session/attributes", { attributes }, undefined, w.sess);
    expect((await post({ plan: "pro", seats: 3, beta: true })).status).toBe(200);
    expect((await post({ app_version: "1.2.3", beta: null })).status).toBe(200);
    const attrs = JSON.parse((await w.ctx.db.get<{ attrs: string }>("SELECT attrs FROM contacts LIMIT 1"))!.attrs);
    expect(attrs).toEqual({ app: { plan: "pro", seats: 3, app_version: "1.2.3" } });
    for (const bad of [{ "Bad-Key": "x" }, { k: { nested: 1 } }, { k: "x".repeat(201) }, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]))]) {
      expect((await post(bad)).status).toBe(400);
    }
  });

  it("uploads a picture, sends it as an image message that the team sees; only pictures and PDFs; only your own uploads", async () => {
    const w = await chatting();
    const upload = (name: string, bytes: Buffer, type: string, headers = w.sess) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(bytes)], name, { type }));
      return w.http.call("POST", "/public/attachments", { form, headers });
    };
    const ok = await upload("photo.png", PNG, "image/png");
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ file_name: "photo.png", content_type: "image/png", url: expect.stringContaining("/files/") });
    const sent = await w.http.post(`/public/rooms/${w.room}/messages`, { attachment_ids: [ok.body.id], client_msg_id: "cm-img-0001" }, undefined, w.sess);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ kind: "image", attachments: [{ file_name: "photo.png" }] });
    // idempotent resend
    const again = await w.http.post(`/public/rooms/${w.room}/messages`, { attachment_ids: [ok.body.id], client_msg_id: "cm-img-0001" }, undefined, w.sess);
    expect([again.status, again.body.id]).toEqual([200, sent.body.id]);
    const agentView = await w.http.get(`/api/rooms/${w.room}/messages`, w.token);
    expect(agentView.body.data.at(-1)).toMatchObject({ kind: "image", attachments: [{ file_name: "photo.png" }] });
    // pdf allowed, text and executables not, extension must match
    expect((await upload("a.pdf", Buffer.from("%PDF-1.4\n%x\n"), "application/pdf")).status).toBe(201);
    expect((await upload("notes.txt", Buffer.from("hello"), "text/plain")).body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect((await upload("x.png", Buffer.from("MZ\x90\x00\x03", "latin1"), "image/png")).status).toBe(415);
    expect((await upload("photo.jpg", PNG, "image/jpeg")).body.error.code).toBe("FILE_TYPE_MISMATCH");
    // another visitor cannot attach it, and a message needs text or an attachment
    const s2 = await w.session({}, "device-ident-0777");
    const sess2 = { "x-support-session": s2.body.session_token, "x-device-id": "device-ident-0777", origin: OWN };
    const room2 = (await w.http.post("/public/rooms", {}, undefined, sess2)).body.room.id;
    expect((await w.http.post(`/public/rooms/${room2}/messages`, { attachment_ids: [ok.body.id] }, undefined, sess2)).body.error.code).toBe("UNKNOWN_ATTACHMENT");
    expect((await w.http.post(`/public/rooms/${w.room}/messages`, {}, undefined, w.sess)).status).toBe(400);
    expect((await w.http.post(`/public/rooms/${w.room}/messages`, { attachment_ids: ["att_nope"] }, undefined, w.sess)).body.error.code).toBe("UNKNOWN_ATTACHMENT");
  });

  it("uploads are rate limited per visitor", async () => {
    const w = await chatting();
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(PNG)], `p${i}.png`, { type: "image/png" }));
      const r = await w.http.call("POST", "/public/attachments", { form, headers: w.sess });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
