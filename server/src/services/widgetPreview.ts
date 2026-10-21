import { can } from "../authz/permissions.js";
import type { AppContext } from "../context.js";
import type { Actor } from "../domain/types.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { hmacHex, safeEqual } from "../util/crypto.js";
import { recordAudit } from "./audit.js";
import type { TokenRow } from "./visitors.js";

/**
 * "Try it now": the in-app preview embeds the real widget on the app's own origin. A page on the app's origin cannot satisfy the embed
 * token's domain check (a same-origin GET carries no Origin header, and the token is bound to the customer's site), and the check itself
 * must not be weakened for production. Instead a manager asks for a short-lived signed preview flag for ONE token of THEIR workspace; the
 * flag lets the widget, running on the app's own origin only, talk to the public API as that token. Sessions created that way are marked
 * `preview` and accepted from the app's own origin only, so the flag opens nothing for any other site.
 */
export const PREVIEW_TTL_SECONDS = 600;
export const PREVIEW_SESSION_HOURS = 12;

const key = (ctx: AppContext) => hmacHex(ctx.config.JWT_SECRET, "widget-preview-v1");
const sign = (ctx: AppContext, body: string) => hmacHex(key(ctx), body);

export function ownOrigin(ctx: AppContext): string {
  try {
    return new URL(ctx.config.PUBLIC_URL).origin;
  } catch {
    return ctx.config.PUBLIC_URL;
  }
}

export function signPreview(ctx: AppContext, token: Pick<TokenRow, "id" | "workspace_id">): { flag: string; expires_at: string } {
  const exp = Math.floor(ctx.clock().getTime() / 1000) + PREVIEW_TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ t: token.id, w: token.workspace_id, e: exp })).toString("base64url");
  return { flag: `${body}.${sign(ctx, body)}`, expires_at: new Date(exp * 1000).toISOString() };
}

export interface PreviewClaim {
  tokenId: string;
  workspaceId: string;
}

/** Throws 401 INVALID_PREVIEW for a tampered, malformed or expired flag. */
export function verifyPreview(ctx: AppContext, flag: string): PreviewClaim {
  const bad = () => unauthorized("This preview link is invalid or has expired. Open the preview again from Settings > Widget.", "INVALID_PREVIEW");
  const [body, mac] = flag.split(".");
  if (!body || !mac || !safeEqual(sign(ctx, body), mac)) throw bad();
  let claim: { t?: unknown; w?: unknown; e?: unknown };
  try {
    claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (typeof claim.t !== "string" || typeof claim.w !== "string" || typeof claim.e !== "number") throw bad();
  if (ctx.clock().getTime() / 1000 >= claim.e) throw bad();
  return { tokenId: claim.t, workspaceId: claim.w };
}

export async function createPreviewLink(ctx: AppContext, actor: Actor, tokenId: string) {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage embed tokens");
  const t = await ctx.db.get<TokenRow>("SELECT * FROM tokens WHERE id = ? AND workspace_id = ? AND status = 'active'", tokenId, actor.workspaceId);
  if (!t) throw notFound("Token");
  const { flag, expires_at } = signPreview(ctx, t);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "widget.preview_opened", target: t.id });
  return { url: `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/widget-preview?p=${encodeURIComponent(flag)}`, expires_at };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { color-scheme: light dark; --bg:#f5f5f8; --card:#fff; --fg:#15151c; --muted:#4b4b5a; --line:#e2e2ea; --accent:#4f46e5; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b0b0f; --card:#14141a; --fg:#ececf3; --muted:#a9a9bb; --line:#2b2b38; --accent:#818cf8; } }
* { box-sizing:border-box } body { font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; min-height:100vh; background:var(--bg); color:var(--fg); line-height:1.55 }
main { max-width:640px; margin:0 auto; padding:56px 16px } h1 { font-size:28px; letter-spacing:-.02em; margin:0 0 8px }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; margin-top:20px } ol { padding-left:20px; margin:8px 0 0 } li { margin:6px 0 }
a { color:var(--accent); font-weight:600 } .note { color:var(--muted); font-size:14px; margin:0 } .tag { display:inline-block; font-size:12px; font-weight:600; padding:2px 8px; border-radius:99px; background:color-mix(in srgb,var(--accent) 14%,transparent); color:var(--accent) }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px }`;

const shell = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style>${head}</head><body><main>${body}</main></body></html>`;

/** The page behind "Try it now": the real widget.js, bound to one token by a signed flag, on the app's own origin. */
export function previewPage(flag: string): string {
  return shell(
    "Widget preview",
    `<span class="tag">Preview</span><h1>Chat as a visitor</h1>
<p class="note">This is your real widget, running against your real workspace. The chat button is in the bottom corner (it opens on its own).</p>
<div class="card"><ol>
<li>Write a message in the widget as if you were a customer. Use the pre-chat form if it asks for details.</li>
<li>Open the <a href="/inbox" target="_blank" rel="noopener">Inbox</a> in another tab: the conversation is there. Reply as an agent and watch the answer arrive here.</li>
</ol></div>
<p class="note" style="margin-top:16px">Conversations started here are real conversations (a contact called "Visitor"); close or delete them in the Inbox when you are done. This link works for ${PREVIEW_TTL_SECONDS / 60} minutes and only on this address; your site's domain allow-list is not affected.</p>
<script src="/widget.js" data-preview="${esc(flag)}" data-open="true" async></script>`,
  );
}

export const previewExpiredPage = () =>
  shell("Preview link expired", `<h1>This preview link has expired</h1><p class="note">Preview links last ${PREVIEW_TTL_SECONDS / 60} minutes. Open <a href="/settings/widget">Settings &rarr; Widget</a> and choose <em>Try it now</em> again.</p>`);

export const demoRedirectPage = () =>
  shell("Chat widget demo", `<h1>Try the chat widget</h1><p class="note">The demo moved into the app, where it uses your own widget settings and a safe preview link instead of an embed token typed by hand.</p><div class="card"><p>Open <a href="/settings/widget">Settings &rarr; Widget &rarr; Install</a> and choose <strong>Try it now</strong>.</p></div>`);
