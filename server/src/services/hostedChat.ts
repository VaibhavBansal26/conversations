import type { AppContext } from "../context.js";
import { assertWorkspaceActive } from "../admin/suspension.js";
import { ownOrigin } from "./widgetPreview.js";
import type { TokenRow } from "./visitors.js";

/**
 * The hosted full-page chat (`GET /chat?token=cvt_...`): the real chat for a native app's web view, or an iframe on a website, served from the
 * app's own origin so its API calls are same-origin. See docs/MOBILE-BRIDGE.md and ADR 0024.
 *
 * Security shape of the page:
 *  - no inline script or style: everything is `'self'` (chat.js, bridge.js, i18n.js, chat.css), so a reflected parameter cannot become script;
 *  - the only server-rendered values are an allow-listed `lang`/`dir`/`theme` and the token's own domain pattern (from the database);
 *  - `frame-ancestors` lists the token's domain (iframe use on that site) plus the app itself; a native web view is not subject to it;
 *  - the page needs the embed token in the URL, which is public by design (the same token sits in every website's HTML), never a session.
 */

export const CHAT_LOCALES = ["en", "es", "fr", "de", "ja", "ar", "he"] as const;
const RTL = new Set(["ar", "he", "fa", "ur"]);

/** `lang` for the document from a free-form locale param: `pt-BR` -> `pt-BR`, junk -> `en`. */
export function safeLang(input: string | undefined): string {
  const v = (input ?? "").trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(v) ? v : "en";
}
export const isRtl = (lang: string) => RTL.has(lang.toLowerCase().split("-")[0]!);
export const safeTheme = (input: string | undefined): "light" | "dark" | "auto" => (input === "light" || input === "dark" ? input : "auto");

/** CSP host sources for the sites a token's domain pattern allows: https always, http only for localhost development. */
export function frameAncestorSources(domainPattern: string): string[] {
  const d = domainPattern.toLowerCase();
  const host = d.split(":")[0]!;
  const out = [`https://${d}`];
  if (host === "localhost" || host === "127.0.0.1") out.push(`http://${d}`);
  return out;
}

export interface ChatSecurity {
  csp: string;
  /** null when the page may be framed by other sites: X-Frame-Options cannot express a list, and a stale SAMEORIGIN would block the iframe use */
  xFrameOptions: "DENY" | null;
}

export function chatSecurity(ctx: AppContext, domainPattern: string | null): ChatSecurity {
  const own = ownOrigin(ctx);
  const ws = own.replace(/^http/, "ws");
  const ancestors = domainPattern ? ["'self'", ...frameAncestorSources(domainPattern)] : ["'none'"];
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https: data: blob:",
    "font-src 'self'",
    "media-src 'self' https: blob:",
    // the realtime speech engine connects the visitor's browser to the provider (WebRTC signalling over HTTPS): only when this installation has it
    `connect-src 'self' ${own} ${ws}${ctx.realtime && ctx.config.AI_REALTIME_ENABLED ? ` ${new URL(ctx.config.OPENAI_BASE_URL).origin}` : ""}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors.join(" ")}`,
  ].join("; ");
  return { csp, xFrameOptions: domainPattern ? null : "DENY" };
}

export type HostedToken = Pick<TokenRow, "id" | "workspace_id" | "domain" | "status" | "hosted_chat_enabled">;

/** The token behind a /chat URL if the page may be served for it. Anything else gets the same generic "not available" page. */
export async function hostedTokenFor(ctx: AppContext, tokenParam: string | undefined): Promise<HostedToken | null> {
  if (!tokenParam || !/^cvt_[A-Za-z0-9_-]{8,80}$/.test(tokenParam)) return null;
  const row = await ctx.db.get<HostedToken>("SELECT id, workspace_id, domain, status, hosted_chat_enabled FROM tokens WHERE token = ?", tokenParam);
  if (!row || row.status !== "active" || !row.hosted_chat_enabled) return null;
  try {
    await assertWorkspaceActive(ctx, row.workspace_id);
  } catch {
    return null;
  }
  return row;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function chatPage(o: { lang: string; theme: "light" | "dark" | "auto"; domain: string; v: string }): string {
  return `<!doctype html>
<html lang="${esc(o.lang)}" dir="${isRtl(o.lang) ? "rtl" : "ltr"}" data-theme="${o.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="cv-domain" content="${esc(o.domain)}">
<title>Chat</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/chat/assets/chat.css?v=${o.v}">
</head>
<body>
<div id="app" class="app" aria-busy="true"><div class="boot" role="status"><span class="spinner" aria-hidden="true"></span><span id="boot-text">Loading chat...</span></div></div>
<noscript><p class="boot">JavaScript is required for the chat.</p></noscript>
<script src="/socket.io/socket.io.js"></script>
<script src="/chat/assets/i18n.js?v=${o.v}"></script>
<script src="/chat/assets/bridge.js?v=${o.v}"></script>
<script src="/chat/assets/calls.js?v=${o.v}"></script>
<script src="/chat/assets/aicall.js?v=${o.v}"></script>
<script src="/chat/assets/chat.js?v=${o.v}"></script>
</body>
</html>`;
}

/**
 * The page a call link opens. The same document for every address under /call/, so the page itself says nothing about whether a link exists: its script
 * reads the address, removes it from the browser's address bar, and asks the server (calls/links.ts). No referrer is sent from it, nothing is cached.
 */
export function callPage(v: string): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Join the call</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/chat/assets/chat.css?v=${v}">
</head>
<body>
<main id="cpage" class="cpage" aria-busy="true"><div class="boot" role="status"><span class="spinner" aria-hidden="true"></span><span id="boot-text">Loading...</span></div></main>
<noscript><p class="boot">JavaScript is required to join a call.</p></noscript>
<script src="/socket.io/socket.io.js"></script>
<script src="/chat/assets/i18n.js?v=${v}"></script>
<script src="/chat/assets/calls.js?v=${v}"></script>
<script src="/chat/assets/aicall.js?v=${v}"></script>
<script src="/chat/assets/callpage.js?v=${v}"></script>
</body>
</html>`;
}

export const unavailablePage = () =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Chat unavailable</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/chat/assets/chat.css"></head><body><main class="unavailable"><h1>Chat is not available</h1><p>This chat link is not active. If you followed it from an app, update the app or contact its support team.</p></main></body></html>`;

/** The conformance page: embeds the hosted chat in an iframe and drives every bridge command, checking every event. No token is baked in. */
export function bridgeTestPage(v: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Bridge conformance</title>
<link rel="stylesheet" href="/chat/assets/chat.css?v=${v}">
<link rel="stylesheet" href="/chat/assets/bridge-test.css?v=${v}">
</head>
<body class="bt">
<main>
<h1>Mobile bridge conformance</h1>
<p>Open as <code>/chat/bridge-test?token=cvt_...</code> for a token with the hosted chat enabled. The page loads <code>/chat</code> in an iframe, sends every host command, and checks every event and acknowledgement against the schema (docs/bridge/).</p>
<div class="bt-row"><button id="bt-run" type="button">Run all checks</button><span id="bt-summary" role="status" aria-live="polite">Not run</span></div>
<table id="bt-table"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody></tbody></table>
<h2>Event log</h2>
<pre id="bt-log" aria-label="Event log"></pre>
<iframe id="bt-frame" title="Hosted chat under test" hidden></iframe>
</main>
<script src="/chat/assets/bridge.js?v=${v}"></script>
<script src="/chat/assets/bridge-test.js?v=${v}"></script>
</body>
</html>`;
}
