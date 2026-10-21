import { describe, expect, it } from "vitest";
import { signPreview, verifyPreview, PREVIEW_TTL_SECONDS } from "../src/services/widgetPreview.js";
import { fullApp, seedWorkspace, tokenFor, addMemberRaw } from "./helpers.js";
import { startServer } from "./rt-helpers.js";

const OWN = "http://localhost:3000"; // PUBLIC_URL of the test config
const SITE = "https://shop.example.com";

async function world() {
  const f = await fullApp();
  const created = await f.http.post("/api/tokens", { domain: "shop.example.com" }, f.token);
  const apiKey = created.body.token as string;
  const tokenId = created.body.id as string;
  const preview = async () => (await f.http.post(`/api/tokens/${tokenId}/preview`, {}, f.token)).body as { url: string; expires_at: string };
  const flagOf = (url: string) => new URL(url).searchParams.get("p")!;
  const h = (o: Record<string, string>) => ({ "x-device-id": "device-aaaa-0001", ...o });
  return { ...f, apiKey, tokenId, preview, flagOf, h };
}

describe("widget install verification", () => {
  it("records the origin and time of the newest config request from a real site", async () => {
    const w = await world();
    expect((await w.http.get("/api/tokens", w.token)).body.data[0]).toMatchObject({ last_seen_origin: null, last_seen_at: null });
    const r = await w.http.get("/public/widget/config", undefined, { "x-api-key": w.apiKey, origin: SITE });
    expect(r.status).toBe(200);
    const t = (await w.http.get("/api/tokens", w.token)).body.data[0];
    expect(t).toMatchObject({ last_seen_origin: SITE, last_seen_at: w.ctx.clock().toISOString() });
  });

  it("a refused origin or a wrong key does not count as an installation", async () => {
    const w = await world();
    expect((await w.http.get("/public/widget/config", undefined, { "x-api-key": w.apiKey, origin: "https://evil.example" })).status).toBe(403);
    expect((await w.http.get("/public/widget/config", undefined, { "x-api-key": "cvt_nope", origin: SITE })).status).toBe(401);
    expect((await w.http.get("/api/tokens", w.token)).body.data[0].last_seen_at).toBeNull();
  });

  it("session traffic does not touch last_seen (only the config request does) and the in-app preview never counts", async () => {
    const w = await world();
    const p = await w.preview();
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": w.flagOf(p.url) }))).status).toBe(200);
    expect((await w.http.get("/api/tokens", w.token)).body.data[0].last_seen_at).toBeNull();
  });
});

describe("in-app preview flag", () => {
  it("is issued for a token of the caller's workspace only, by someone who manages tokens, and audited", async () => {
    const w = await world();
    const p = await w.preview();
    expect(p.url).toMatch(/^http:\/\/localhost:3000\/widget-preview\?p=/);
    expect(new Date(p.expires_at).getTime() - w.ctx.clock().getTime()).toBe(PREVIEW_TTL_SECONDS * 1000);
    const other = await seedWorkspace(w.ctx, "Other");
    expect((await w.http.post(`/api/tokens/${w.tokenId}/preview`, {}, await tokenFor(w.ctx, other.owner))).status).toBe(404);
    const agent = await addMemberRaw(w.ctx, w.wsId, { role: "agent" });
    expect((await w.http.post(`/api/tokens/${w.tokenId}/preview`, {}, await tokenFor(w.ctx, agent))).status).toBe(403);
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'widget.preview_opened'")).toEqual({ n: 1 });
    // a revoked token cannot be previewed
    await w.http.del(`/api/tokens/${w.tokenId}`, w.token);
    expect((await w.http.post(`/api/tokens/${w.tokenId}/preview`, {}, w.token)).status).toBe(404);
  });

  it("verifies: valid, expired (boundary), tampered, malformed", async () => {
    const w = await world();
    const { flag } = signPreview(w.ctx, { id: w.tokenId, workspace_id: w.wsId });
    expect(verifyPreview(w.ctx, flag)).toEqual({ tokenId: w.tokenId, workspaceId: w.wsId });
    w.ctx.clockCtl.advance(PREVIEW_TTL_SECONDS * 1000 - 1000);
    expect(() => verifyPreview(w.ctx, flag)).not.toThrow();
    w.ctx.clockCtl.advance(1000);
    expect(() => verifyPreview(w.ctx, flag)).toThrow(/expired/);
    const fresh = signPreview(w.ctx, { id: w.tokenId, workspace_id: w.wsId }).flag;
    const [body, mac] = fresh.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ t: "tok_other", w: w.wsId, e: 9999999999 })).toString("base64url");
    for (const bad of ["", "x", "a.b", `${forged}.${mac}`, `${body}.${"0".repeat(mac.length)}`, `${body}x.${mac}`, `${body}`]) expect(() => verifyPreview(w.ctx, bad), bad).toThrow();
  });

  it("a flag for workspace A's token cannot be turned into access to workspace B's", async () => {
    const w = await world();
    const b = await seedWorkspace(w.ctx, "Beta");
    const tb = await w.http.post("/api/tokens", { domain: "beta.example.com" }, await tokenFor(w.ctx, b.owner));
    const mine = signPreview(w.ctx, { id: w.tokenId, workspace_id: w.wsId }).flag;
    // swapping in the other workspace's token id breaks the signature
    const [, mac] = mine.split(".") as [string, string];
    const swapped = Buffer.from(JSON.stringify({ t: tb.body.id, w: b.wsId, e: 9999999999 })).toString("base64url");
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": `${swapped}.${mac}` }))).status).toBe(401);
    // a token id that does not belong to the claimed workspace resolves to nothing
    const crossed = signPreview(w.ctx, { id: tb.body.id, workspace_id: w.wsId }).flag;
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": crossed }))).status).toBe(401);
    // and the real flag answers with workspace A's configuration only
    const cfg = await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": mine }));
    expect(cfg.body.workspace_id).toBe(w.wsId);
  });

  it("works from the app's own origin only: no Origin (same-origin GET) or the app's, never a site's", async () => {
    const w = await world();
    const flag = w.flagOf((await w.preview()).url);
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": flag }))).status).toBe(200);
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": flag, origin: OWN }))).status).toBe(200);
    for (const origin of [SITE, "https://evil.example", "null", "http://localhost:3001"]) {
      expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": flag, origin }))).status, origin).toBe(403);
    }
    w.ctx.clockCtl.advance((PREVIEW_TTL_SECONDS + 1) * 1000);
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-preview": flag }))).status).toBe(401);
  });

  it("a preview session chats from the app's origin, expires in hours, and is refused from any other origin", async () => {
    const w = await world();
    const flag = w.flagOf((await w.preview()).url);
    const s = await w.http.post("/public/sessions", {}, undefined, w.h({ "x-preview": flag, origin: OWN }));
    expect(s.status).toBe(201);
    const row = (await w.ctx.db.get<{ preview: number; expires_at: string; token_id: string }>("SELECT preview, expires_at, token_id FROM visitor_sessions"))!;
    expect(row.preview).toBe(1);
    expect(row.token_id).toBe(w.tokenId);
    expect(new Date(row.expires_at).getTime() - w.ctx.clock().getTime()).toBe(12 * 3600_000);
    const sess = { "x-support-session": s.body.session_token, "x-device-id": "device-aaaa-0001" };
    const room = await w.http.post("/public/rooms", {}, undefined, { ...sess, origin: OWN });
    expect(room.status).toBe(201);
    expect((await w.http.post(`/public/rooms/${room.body.room.id}/messages`, { content: "hi from the preview" }, undefined, { ...sess, origin: OWN })).status).toBe(201);
    for (const origin of [SITE, "https://evil.example"]) expect((await w.http.get("/public/rooms", undefined, { ...sess, origin })).body.error.code, origin).toBe("ORIGIN_NOT_ALLOWED");
    // the conversation is a real one the team can answer
    expect((await w.http.get("/api/rooms", w.token)).body.data.some((r: { id: string }) => r.id === room.body.room.id)).toBe(true);
  });

  it("does not weaken the production check: a normal session is still refused from the app's own origin, and the key alone from it", async () => {
    const w = await world();
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-api-key": w.apiKey, origin: OWN }))).status).toBe(403);
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-api-key": w.apiKey }))).status).toBe(403); // missing Origin
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-api-key": w.apiKey, origin: "null" }))).status).toBe(403);
    const s = await w.http.post("/public/sessions", {}, undefined, w.h({ "x-api-key": w.apiKey, origin: SITE }));
    expect((await w.http.get("/public/rooms", undefined, { "x-support-session": s.body.session_token, "x-device-id": "device-aaaa-0001", origin: OWN })).body.error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect((await w.http.get("/public/rooms", undefined, { "x-support-session": s.body.session_token, "x-device-id": "device-aaaa-0001", origin: SITE })).status).toBe(200);
    // a preview flag next to a wrong api key does not fall back to the key
    expect((await w.http.get("/public/widget/config", undefined, w.h({ "x-api-key": w.apiKey, "x-preview": "garbage", origin: SITE }))).status).toBe(401);
  });
});

describe("pages", () => {
  it("/widget-preview serves the real widget with the flag, never the token, and refuses bad or expired flags", async () => {
    const w = await world();
    const { url } = await w.preview();
    const path = url.replace(OWN, "");
    const ok = await w.app.request(path);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain('src="/widget.js"');
    expect(html).toContain("data-preview=");
    expect(html).not.toContain(w.apiKey);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await w.app.request("/widget-preview?p=nope")).status).toBe(403);
    expect((await w.app.request("/widget-preview")).status).toBe(403);
    w.ctx.clockCtl.advance((PREVIEW_TTL_SECONDS + 1) * 1000);
    const late = await w.app.request(path);
    expect(late.status).toBe(403);
    expect(await late.text()).toContain("expired");
  });

  it("/widget-demo.html points at the in-app preview instead of asking for a token", async () => {
    const w = await world();
    const r = await w.app.request("/widget-demo.html");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("/settings/widget");
    expect(html).not.toContain("cvt_");
  });
});

describe("preview over sockets", () => {
  it("a preview session connects from the app's own origin and is refused from a site", async () => {
    const srv = await startServer();
    try {
      const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Acme");
      const { createToken, createSession } = await import("../src/services/visitors.js");
      const { actorFromRow, getMember } = await import("../src/services/members.js");
      const token = await createToken(srv.ctx, actorFromRow(await getMember(srv.ctx, wsId, owner.memberId)), "chat.example.com");
      const s = await createSession(srv.ctx, { ...token, preview: true }, { device_id: "device-pv-0001", ip: null });
      const auth = { session: s.secret, deviceId: "device-pv-0001" };
      const ok = await srv.connect(wsId, auth, { origin: "http://localhost:3000" });
      expect(ok.connected).toBe(true);
      await expect(srv.connect(wsId, auth, { origin: "https://chat.example.com" })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      // a normal session is the other way round
      const n = await createSession(srv.ctx, token, { device_id: "device-pv-0002", ip: null });
      await expect(srv.connect(wsId, { session: n.secret, deviceId: "device-pv-0002" }, { origin: "http://localhost:3000" })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      expect((await srv.connect(wsId, { session: n.secret, deviceId: "device-pv-0002" }, { origin: "https://chat.example.com" })).connected).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
