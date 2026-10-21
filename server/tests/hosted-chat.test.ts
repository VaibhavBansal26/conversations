import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSecurity, frameAncestorSources, isRtl, safeLang, safeTheme } from "../src/services/hostedChat.js";
import { fullApp, seedWorkspace, tokenFor, addMemberRaw } from "./helpers.js";
import { startServer } from "./rt-helpers.js";

const OWN = "http://localhost:3000"; // PUBLIC_URL of the test config
const SITE = "https://shop.example.com";
const DEVICE = "device-hosted-0001";

async function world(domain = "shop.example.com", hosted = true) {
  const f = await fullApp();
  const created = await f.http.post("/api/tokens", { domain, hosted_chat_enabled: hosted }, f.token);
  const apiKey = created.body.token as string;
  const tokenId = created.body.id as string;
  /** headers of a request the hosted page makes: same origin, marked */
  const page = (extra: Record<string, string> = {}) => ({ "x-api-key": apiKey, "x-device-id": DEVICE, "x-hosted-chat": "1", ...extra });
  const startSession = async (body: object = {}, extra: Record<string, string> = {}) => {
    const r = await f.http.post("/public/sessions", body, undefined, page({ origin: OWN, ...extra }));
    return { r, sess: { "x-support-session": r.body.session_token ?? "", "x-device-id": DEVICE, origin: OWN } };
  };
  return { ...f, apiKey, tokenId, page, startSession };
}

describe("GET /chat: the page, its CSP and framing", () => {
  it("serves the page for a token with the hosted chat enabled, with a per-token frame-ancestors and no blanket X-Frame-Options", async () => {
    const w = await world();
    const res = await w.app.request(`/chat?token=${w.apiKey}&locale=de&theme=dark`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="de" dir="ltr" data-theme="dark">');
    expect(html).toContain('<meta name="cv-domain" content="shop.example.com">');
    expect(html).toContain("/chat/assets/chat.js?v=");
    // no inline script anywhere: everything is a same-origin file (CSP script-src 'self')
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull();
    expect(html).not.toContain(w.apiKey); // the token is only in the URL the host already has, never echoed
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'self' https://shop.example.com");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses with the same generic page, framing denied, for no token, an unknown token, a flag-off token, a revoked token and a suspended workspace", async () => {
    const off = await world("off.example.com", false);
    const cases: [string, string][] = [
      ["no token", "/chat"],
      ["malformed token", "/chat?token=nope"],
      ["unknown token", "/chat?token=cvt_unknownunknownunknown123"],
      ["flag off", `/chat?token=${off.apiKey}`],
    ];
    for (const [label, path] of cases) {
      const res = await off.app.request(path);
      expect([label, res.status]).toEqual([label, 403]);
      expect(res.headers.get("content-security-policy"), label).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options"), label).toBe("DENY");
      expect(await res.text(), label).toContain("Chat is not available");
    }
    const on = await world();
    expect((await on.app.request(`/chat?token=${on.apiKey}`)).status).toBe(200);
    await on.http.del(`/api/tokens/${on.tokenId}`, on.token);
    expect((await on.app.request(`/chat?token=${on.apiKey}`)).status).toBe(403);
    const sus = await world();
    await sus.ctx.db.run("UPDATE workspaces SET suspended_at = ? WHERE id = ?", sus.ctx.clock().toISOString(), sus.wsId);
    await sus.ctx.cache.invalidate(`suspended:${sus.wsId}`);
    expect((await sus.app.request(`/chat?token=${sus.apiKey}`)).status).toBe(403);
  });

  it("derives frame-ancestors from the token's domain pattern", () => {
    expect(frameAncestorSources("shop.example.com")).toEqual(["https://shop.example.com"]);
    expect(frameAncestorSources("*.example.com")).toEqual(["https://*.example.com"]);
    expect(frameAncestorSources("Shop.Example.com:8443")).toEqual(["https://shop.example.com:8443"]);
    expect(frameAncestorSources("localhost:3000")).toEqual(["https://localhost:3000", "http://localhost:3000"]);
  });

  it("never reflects parameters into the page unescaped: lang, dir and theme are allow-listed", async () => {
    const w = await world();
    const res = await w.app.request(`/chat?token=${w.apiKey}&locale=${encodeURIComponent('"><script>alert(1)</script>')}&theme=${encodeURIComponent("x\"onload=alert(1)")}&name=<b>`);
    const html = await res.text();
    expect(html).toContain('<html lang="en" dir="ltr" data-theme="auto">');
    expect(html).not.toContain("alert(1)");
    expect(safeLang("pt-BR")).toBe("pt-BR");
    expect(safeLang("ar")).toBe("ar");
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("he-IL")).toBe(true);
    expect(isRtl("en")).toBe(false);
    expect(safeTheme("light")).toBe("light");
    expect(safeTheme("neon")).toBe("auto");
    const rtl = await (await w.app.request(`/chat?token=${w.apiKey}&locale=ar`)).text();
    expect(rtl).toContain('lang="ar" dir="rtl"');
  });

  it("chatSecurity: framing allowed only for the token's sites plus the app itself", async () => {
    const w = await world();
    expect(chatSecurity(w.ctx, "a.example.com").xFrameOptions).toBeNull();
    expect(chatSecurity(w.ctx, null)).toMatchObject({ xFrameOptions: "DENY" });
    expect(chatSecurity(w.ctx, null).csp).toContain("frame-ancestors 'none'");
    expect(chatSecurity(w.ctx, "a.example.com").csp).toContain("connect-src 'self' http://localhost:3000 ws://localhost:3000");
  });

  it("serves the assets from an allow-list (no traversal, no unknown files), with ETag and compression", async () => {
    const w = await world();
    for (const [f, type] of [["chat.js", "application/javascript"], ["bridge.js", "application/javascript"], ["i18n.js", "application/javascript"], ["chat.css", "text/css"]] as const) {
      const res = await w.app.request(`/chat/assets/${f}`, { headers: { "accept-encoding": "gzip" } });
      expect([f, res.status]).toEqual([f, 200]);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("content-encoding")).toBe("gzip");
      const etag = res.headers.get("etag")!;
      expect((await w.app.request(`/chat/assets/${f}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    }
    for (const bad of ["secret.js", "..%2f..%2fpackage.json", "%2e%2e%2fwidget.js", "chat.js.map"]) expect((await w.app.request(`/chat/assets/${bad}`)).status, bad).toBe(404);
  });

  it("the bridge-test page has its own CSP, may frame the chat and cannot itself be framed", async () => {
    const w = await world();
    const res = await w.app.request("/chat/bridge-test");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toContain("bt-run");
  });
});

describe("origin model for the hosted chat", () => {
  it("flag off: the app's own origin is refused (config, session), exactly like before", async () => {
    const w = await world("shop.example.com", false);
    for (const h of [w.page({ origin: OWN }), w.page(), { "x-api-key": w.apiKey, origin: OWN }]) {
      expect((await w.http.get("/public/widget/config", undefined, h)).body.error.code).toBe("ORIGIN_NOT_ALLOWED");
      expect((await w.http.post("/public/sessions", {}, undefined, h)).status).toBe(403);
    }
    // the site itself still works
    expect((await w.http.get("/public/widget/config", undefined, { "x-api-key": w.apiKey, origin: SITE })).status).toBe(200);
  });

  it("flag on: the app's own origin, or a marked same-origin request without Origin, is accepted; nothing else is", async () => {
    const w = await world();
    expect((await w.http.get("/public/widget/config", undefined, w.page({ origin: OWN }))).status).toBe(200);
    expect((await w.http.get("/public/widget/config", undefined, w.page())).status).toBe(200); // same-origin GET: no Origin header
    expect((await w.http.get("/public/widget/config", undefined, { "x-api-key": w.apiKey, origin: SITE })).status).toBe(200); // the site as before
    const refused: Record<string, string>[] = [
      { "x-api-key": w.apiKey }, // missing Origin without the marker
      { "x-api-key": w.apiKey, "x-hosted-chat": "0" },
      w.page({ origin: "null" }),
      w.page({ origin: "https://evil.example" }),
      w.page({ origin: "http://localhost:3001" }),
      w.page({ origin: "https://localhost:3000" }),
      w.page({ origin: "http://localhost" }),
    ];
    for (const h of refused) expect((await w.http.get("/public/widget/config", undefined, h)).body.error.code, JSON.stringify(h)).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("another workspace's flag does not help: workspace B's flag-off token is refused from the app's origin although A's is on", async () => {
    const a = await world();
    const b = await seedWorkspace(a.ctx, "Beta");
    const tb = await a.http.post("/api/tokens", { domain: "beta.example.com" }, await tokenFor(a.ctx, b.owner));
    expect((await a.http.get("/public/widget/config", undefined, { "x-api-key": tb.body.token, origin: OWN, "x-hosted-chat": "1" })).status).toBe(403);
    expect((await a.http.get("/public/widget/config", undefined, a.page({ origin: OWN }))).body.workspace_id).toBe(a.wsId);
    // and A's owner cannot flip B's token
    expect((await a.http.call("PATCH", `/api/tokens/${tb.body.id}`, { token: a.token, json: { hosted_chat_enabled: true } })).status).toBe(404);
  });

  it("a revoked token is a 401 even from the app's origin; a rotated token keeps the setting", async () => {
    const w = await world();
    const rot = await w.http.post(`/api/tokens/${w.tokenId}/rotate`, {}, w.token);
    expect(rot.body.hosted_chat_enabled).toBe(true);
    expect((await w.http.get("/public/widget/config", undefined, w.page({ origin: OWN }))).body.error.code).toBe("INVALID_API_KEY");
    expect((await w.http.get("/public/widget/config", undefined, { ...w.page({ origin: OWN }), "x-api-key": rot.body.token })).status).toBe(200);
  });

  it("hosted requests are not counted as 'seen on your site' (the install check stays honest)", async () => {
    const w = await world();
    await w.http.get("/public/widget/config", undefined, w.page({ origin: OWN }));
    await w.http.get("/public/widget/config", undefined, w.page());
    expect((await w.http.get("/api/tokens", w.token)).body.data[0]).toMatchObject({ last_seen_at: null, last_seen_origin: null });
  });

  it("a session made in the hosted chat works from the app's origin, expires, and stops working the moment the flag goes off", async () => {
    const w = await world();
    const { r, sess } = await w.startSession({});
    expect(r.status).toBe(201);
    expect((await w.http.get("/public/rooms", undefined, sess)).status).toBe(200);
    expect((await w.http.get("/public/rooms", undefined, { ...sess, origin: "https://evil.example" })).body.error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect((await w.http.get("/public/rooms", undefined, { ...sess, origin: SITE })).status).toBe(200); // the site's own origin keeps working
    await w.http.call("PATCH", `/api/tokens/${w.tokenId}`, { token: w.token, json: { hosted_chat_enabled: false } });
    expect((await w.http.get("/public/rooms", undefined, sess)).body.error.code).toBe("ORIGIN_NOT_ALLOWED");
    await w.http.call("PATCH", `/api/tokens/${w.tokenId}`, { token: w.token, json: { hosted_chat_enabled: true } });
    expect((await w.http.get("/public/rooms", undefined, sess)).status).toBe(200);
    w.ctx.clockCtl.advance(31 * 86400_000);
    expect((await w.http.get("/public/rooms", undefined, sess)).body.error.code).toBe("SESSION_EXPIRED");
  });

  it("managing the flag needs tokens:manage and is audited", async () => {
    const w = await world("shop.example.com", false);
    const agent = await addMemberRaw(w.ctx, w.wsId, { role: "agent" });
    expect((await w.http.call("PATCH", `/api/tokens/${w.tokenId}`, { token: await tokenFor(w.ctx, agent), json: { hosted_chat_enabled: true } })).status).toBe(403);
    const ok = await w.http.call("PATCH", `/api/tokens/${w.tokenId}`, { token: w.token, json: { hosted_chat_enabled: true } });
    expect(ok.body).toMatchObject({ id: w.tokenId, hosted_chat_enabled: true });
    expect(await w.ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'token.hosted_chat_changed'")).toEqual({ n: 1 });
    expect((await w.http.call("PATCH", `/api/tokens/${w.tokenId}`, { token: w.token, json: { hosted_chat_enabled: "yes" } })).status).toBe(400);
  });
});

describe("hosted chat over sockets", () => {
  it("a hosted session connects from the app's own origin, not from a stranger, and not once the flag is off", async () => {
    const srv = await startServer();
    try {
      const { wsId } = await srv.seedWorkspace(srv.ctx, "Acme");
      const v = await srv.visitor(wsId, "chat.example.com", "device-rt-9001");
      await srv.ctx.db.run("UPDATE tokens SET hosted_chat_enabled = 1 WHERE id = ?", v.tokenRow.id);
      expect((await srv.connect(wsId, v.auth, { origin: "http://localhost:3000" })).connected).toBe(true);
      expect((await srv.connect(wsId, v.auth, { origin: "https://chat.example.com" })).connected).toBe(true);
      await expect(srv.connect(wsId, v.auth, { origin: "https://evil.example" })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
      await srv.ctx.db.run("UPDATE tokens SET hosted_chat_enabled = 0 WHERE id = ?", v.tokenRow.id);
      await expect(srv.connect(wsId, v.auth, { origin: "http://localhost:3000" })).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    } finally {
      await srv.close();
    }
  });
});

describe("static assets contract", () => {
  it("the page only references files that exist, and chat.js has no eval, document.write or inline handlers", () => {
    for (const f of ["chat.js", "bridge.js", "i18n.js", "chat.css", "bridge-test.js", "bridge-test.css"]) expect(readFileSync(new URL(`../public/chat/${f}`, import.meta.url), "utf8").length).toBeGreaterThan(500);
    for (const f of ["chat.js", "bridge.js", "bridge-test.js"]) {
      const src = readFileSync(new URL(`../public/chat/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/\beval\s*\(|new Function\s*\(|document\.write|\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
    }
  });
});
