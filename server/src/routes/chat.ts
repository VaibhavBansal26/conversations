import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { bridgeTestPage, chatPage, chatSecurity, hostedTokenFor, safeLang, safeTheme, unavailablePage } from "../services/hostedChat.js";
import { compressed } from "../static.js";

const CHAT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/chat");
const ASSETS: Record<string, string> = {
  "chat.js": "application/javascript; charset=utf-8",
  "bridge.js": "application/javascript; charset=utf-8",
  "i18n.js": "application/javascript; charset=utf-8",
  "calls.js": "application/javascript; charset=utf-8",
  "bridge-test.js": "application/javascript; charset=utf-8",
  "chat.css": "text/css; charset=utf-8",
  "bridge-test.css": "text/css; charset=utf-8",
};

let versionMemo: { sig: string; v: string } | undefined;
/** Short content hash of the assets, so the page URL changes when a file does (memoised on file mtimes). */
function assetVersion(): string {
  try {
    const sig = Object.keys(ASSETS).map((f) => `${f}:${statSync(resolve(CHAT_DIR, f)).mtimeMs}`).join("|");
    if (versionMemo?.sig === sig) return versionMemo.v;
    const h = createHash("sha1");
    for (const f of Object.keys(ASSETS)) h.update(readFileSync(resolve(CHAT_DIR, f)));
    versionMemo = { sig, v: h.digest("hex").slice(0, 10) };
    return versionMemo.v;
  } catch {
    return "0";
  }
}

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function chatRoutes(ctx: AppContext) {
  const r = new Hono();

  r.get("/", async (c) => {
    const q = c.req.query();
    const token = await hostedTokenFor(ctx, q.token);
    if (!token) {
      const sec = chatSecurity(ctx, null);
      return c.html(unavailablePage(), 403, { ...BASE_HEADERS, "Content-Security-Policy": sec.csp, "X-Frame-Options": "DENY" });
    }
    const sec = chatSecurity(ctx, token.domain);
    const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Security-Policy": sec.csp };
    if (sec.xFrameOptions) headers["X-Frame-Options"] = sec.xFrameOptions;
    return c.html(chatPage({ lang: safeLang(q.locale), theme: safeTheme(q.theme), domain: token.domain, v: assetVersion() }), 200, headers);
  });

  r.get("/bridge-test", (c) => {
    const sec = chatSecurity(ctx, null);
    const csp = sec.csp.replace("default-src 'none'", "default-src 'none'; frame-src 'self'");
    return c.html(bridgeTestPage(assetVersion()), 200, { ...BASE_HEADERS, "Content-Security-Policy": csp, "X-Frame-Options": "DENY" });
  });

  r.get("/assets/:file", (c) => {
    const name = c.req.param("file");
    const type = ASSETS[name];
    if (!type) return c.notFound();
    let body: Buffer;
    try {
      body = readFileSync(resolve(CHAT_DIR, name));
    } catch {
      return c.notFound();
    }
    return compressed(c.req.header("accept-encoding"), c.req.header("if-none-match"), body, {
      "Content-Type": type,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    }, `chat/${name}`);
  });

  return r;
}
