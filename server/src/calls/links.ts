import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { cleanPlainText } from "../util/html.js";
import { sha256 } from "../util/crypto.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "../services/audit.js";
import { getContact } from "../services/contacts.js";
import { sendAgentMessage } from "../services/messages.js";
import { emitInserted, emitMessage, insertMessage, postSystemMessage, type MessageRow } from "../services/messageStore.js";
import { getRoomRow, getVisibleRoom, type RoomRow } from "../services/roomStore.js";
import { assertWorkspaceActive } from "../admin/suspension.js";
import type { SessionRow } from "../services/visitors.js";
import { aiCallAvailability } from "./aiCall.js";
import { callSettings, requestCall } from "./service.js";

/**
 * Call links (docs/CALLS.md, ADR 0037): a link that lets a visitor join a voice or video call without logging in or giving any contact details.
 *
 * The token is a random 128-bit id plus an HMAC of it under a server secret (so at least 128 bits to guess). The database stores only the SHA-256 of
 * the whole token, never the token: the visitor's own copy of the chat shows the link by deriving it again from the link id, which only this server
 * can do. A link belongs to ONE conversation, expires (30 minutes unless set otherwise, 24 hours at most), can be revoked, is opened by one device at
 * a time, and is used up when the call started through it ends. Opening it mints a session that can do nothing but take part in that call.
 */

export interface CallLinkRow {
  id: string;
  workspace_id: string;
  room_id: string;
  mode: "ai" | "team";
  kind: "voice" | "video";
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  redeemed_at: string | null;
  device_hash: string | null;
  display_name: string | null;
  consumed_at: string | null;
  message_id: string | null;
  meta: string;
}

export const LINK_TTL_MAX_MINUTES = 1440;
/** a call that is running when its link expires may go on for this long (the session lives that much longer) */
export const LINK_CALL_GRACE_MINUTES = 120;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
export const LINK_UNAVAILABLE = () => new AppError(404, "LINK_UNAVAILABLE", "This link is not available.");

/* ---------- the token ---------- */

const mac = (ctx: AppContext, id: string) => createHmac("sha256", ctx.config.JWT_SECRET).update(`calllink|${id}`).digest("base64url");
export const tokenOf = (ctx: AppContext, id: string) => `${id}.${mac(ctx, id)}`;
export const linkUrl = (ctx: AppContext, id: string) => `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/call/${tokenOf(ctx, id)}`;

/** the link id inside a well-formed token whose second half is the right HMAC; anything else is null (without touching the database) */
export function idFromToken(ctx: AppContext, token: unknown): string | null {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const [id, m] = token.split(".") as [string, string];
  const want = Buffer.from(mac(ctx, id));
  const got = Buffer.from(m);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

export type LinkStatus = "active" | "in_use" | "expired" | "revoked" | "used";
export function statusOf(ctx: AppContext, l: Pick<CallLinkRow, "expires_at" | "revoked_at" | "consumed_at" | "redeemed_at">): LinkStatus {
  if (l.revoked_at) return "revoked";
  if (l.consumed_at) return "used";
  if (l.expires_at <= nowIso(ctx)) return "expired";
  return l.redeemed_at ? "in_use" : "active";
}

export const linkDto = (ctx: AppContext, l: CallLinkRow) => ({ id: l.id, room_id: l.room_id, mode: l.mode, kind: l.kind, created_by: l.created_by, created_at: l.created_at, expires_at: l.expires_at, status: statusOf(ctx, l), redeemed_at: l.redeemed_at, display_name: l.display_name });

/* ---------- creating ---------- */

export interface LinkAuthor {
  type: "member" | "bot";
  id: string;
  name: string;
}

const cardOf = (l: Pick<CallLinkRow, "id" | "mode" | "kind" | "expires_at">, status: LinkStatus, label?: string) => ({ type: "call_link", link_id: l.id, mode: l.mode, kind: l.kind, expires_at: l.expires_at, status, ...(label ? { label } : {}) });
const cardText = (l: Pick<CallLinkRow, "mode" | "kind">) => `${l.mode === "ai" ? "Talk to our AI assistant" : "Join a call with our team"} (${l.kind === "video" ? "video" : "voice"}): use the Join button. The link works for a short time and for one call.`;

export async function createCallLink(
  ctx: AppContext,
  o: { workspaceId: string; roomId: string; mode: "ai" | "team"; kind: "voice" | "video"; by: LinkAuthor; ttlMinutes?: number; agent?: { id: string; name: string; label: string } },
): Promise<{ link: CallLinkRow; url: string }> {
  const ws = o.workspaceId;
  const s = (await callSettings(ctx, ws)).links;
  if (!s.enabled) throw new AppError(403, "CALL_LINKS_DISABLED", "Call links are switched off for this workspace");
  if ((o.mode === "ai" && !s.allow_ai) || (o.mode === "team" && !s.allow_team)) throw new AppError(403, "CALL_LINKS_DISABLED", `Call links with ${o.mode === "ai" ? "the AI assistant" : "the team"} are switched off`);
  const room = await getRoomRow(ctx, ws, o.roomId);
  if (room.archived) throw notFound("Conversation");
  const calls = await callSettings(ctx, ws);
  if (o.mode === "team" && (!calls.browser.enabled || !calls.browser[o.kind])) throw new AppError(403, "CALLS_DISABLED", `${o.kind === "video" ? "Video" : "Voice"} calls are switched off for this workspace`);
  if (o.mode === "ai") {
    const a = await aiCallAvailability(ctx, ws, room.inbox_id);
    if (!a.enabled || !a[o.kind]) throw new AppError(409, "AI_CALL_UNAVAILABLE", "The AI assistant is not available for calls right now");
  }
  const rate = await ctx.ratelimit.check("calls.link.create", { key: `${ws}:${o.roomId}`, workspaceId: ws });
  if (!rate.allowed) throw new RateLimitedError(rate);
  const ttl = Math.min(Math.max(Math.round(o.ttlMinutes ?? s.ttl_minutes), 5), LINK_TTL_MAX_MINUTES);
  const now = nowIso(ctx);
  const expires = new Date(ctx.clock().getTime() + ttl * 60_000).toISOString();
  const id = randomBytes(16).toString("base64url");
  const token = tokenOf(ctx, id);
  // one active link per conversation: a new one replaces the old
  const older = await ctx.db.all<CallLinkRow>("SELECT * FROM call_links WHERE room_id = ? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?", o.roomId, now);
  for (const l of older) await revokeRow(ctx, l, "replaced");
  await ctx.db.run(
    "INSERT INTO call_links(id, workspace_id, room_id, mode, kind, token_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, ws, o.roomId, o.mode, o.kind, sha256(token), `${o.by.type}:${o.by.id}`, now, expires,
  );
  let link = (await ctx.db.get<CallLinkRow>("SELECT * FROM call_links WHERE id = ?", id))!;
  const text = cardText(link);
  // the card is how the visitor gets the link: it names the link, never holds the token (the visitor's copy of the thread derives the address)
  const r =
    o.by.type === "bot" && o.agent
      ? await insertMessage(ctx, { workspaceId: ws, roomId: o.roomId, senderType: "bot", senderId: o.agent.id, senderName: o.agent.name, kind: "text", source: "dm", content: text, contentText: text, meta: { ai: true, agent: { id: o.agent.id, name: o.agent.name, label: o.agent.label }, card: cardOf(link, "active", o.mode === "ai" ? o.agent.label : undefined) } })
      : await insertMessage(ctx, { workspaceId: ws, roomId: o.roomId, senderType: "system", kind: "system", source: "dm", content: text, contentText: text, meta: { sub_type: "call_link", card: cardOf(link, "active") } });
  await emitInserted(ctx, r);
  await ctx.db.run("UPDATE call_links SET message_id = ? WHERE id = ?", r.message.id, id);
  link = (await ctx.db.get<CallLinkRow>("SELECT * FROM call_links WHERE id = ?", id))!;
  await recordAudit(ctx, { workspaceId: ws, actor: o.by.type === "member" ? { type: "member", id: o.by.id } : { type: "system" }, action: "call_link.created", target: id, detail: { room_id: o.roomId, mode: o.mode, kind: o.kind, ttl_minutes: ttl, by: `${o.by.type}:${o.by.id}`, replaced: older.length } });
  return { link, url: linkUrl(ctx, id) };
}

/** keep the card in the thread in step with the link */
async function refreshCard(ctx: AppContext, l: CallLinkRow, status: LinkStatus): Promise<void> {
  if (!l.message_id) return;
  const m = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND room_id = ?", l.message_id, l.room_id);
  if (!m) return;
  const meta = parseJson<{ card?: Record<string, unknown> } & Record<string, unknown>>(m.meta, {});
  if (!meta.card) return;
  await ctx.db.run("UPDATE messages SET meta = ? WHERE id = ? AND room_id = ?", JSON.stringify({ ...meta, card: { ...meta.card, status } }), m.id, m.room_id);
  const fresh = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND room_id = ?", m.id, m.room_id);
  if (fresh) await emitMessage(ctx, await getRoomRow(ctx, l.workspace_id, l.room_id), fresh, "message:updated");
}

async function expireSessions(ctx: AppContext, linkId: string): Promise<void> {
  await ctx.db.run("UPDATE visitor_sessions SET expired = 1 WHERE call_link_id = ?", linkId);
}

async function revokeRow(ctx: AppContext, l: CallLinkRow, why: string): Promise<void> {
  await ctx.db.run("UPDATE call_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", nowIso(ctx), l.id);
  await expireSessions(ctx, l.id);
  // a call that was started through it stops with it
  const live = await ctx.db.get<{ id: string; state: string }>("SELECT id, state FROM calls WHERE room_id = ? AND state IN ('ringing','connecting','active') AND meta LIKE ?", l.room_id, `%"link_id":"${l.id}"%`);
  if (live) {
    const { stepCall } = await import("./service.js");
    const row = (await ctx.db.get<import("./service.js").CallRow>("SELECT * FROM calls WHERE id = ?", live.id))!;
    await stepCall(ctx, row, row.state === "ringing" ? "cancel" : "end", { ended_by: "system", end_reason: "link_revoked" }).catch(() => {});
  }
  await refreshCard(ctx, l, "revoked");
  void why;
}

export async function revokeCallLink(ctx: AppContext, actor: Actor, roomId: string, linkId: string): Promise<ReturnType<typeof linkDto>> {
  await getVisibleRoom(ctx, actor, roomId);
  const l = await ctx.db.get<CallLinkRow>("SELECT * FROM call_links WHERE id = ? AND room_id = ? AND workspace_id = ?", linkId, roomId, actor.workspaceId);
  if (!l) throw notFound("Call link");
  if (!l.revoked_at) {
    await revokeRow(ctx, l, "revoked");
    await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "call_link.revoked", target: l.id, detail: { room_id: roomId } });
  }
  return linkDto(ctx, (await ctx.db.get<CallLinkRow>("SELECT * FROM call_links WHERE id = ?", l.id))!);
}

export async function listCallLinks(ctx: AppContext, actor: Actor, roomId: string) {
  await getVisibleRoom(ctx, actor, roomId);
  return (await ctx.db.all<CallLinkRow>("SELECT * FROM call_links WHERE room_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 20", roomId, actor.workspaceId)).map((l) => linkDto(ctx, l));
}

/* ---------- opening (no login) ---------- */

async function usable(ctx: AppContext, token: unknown): Promise<{ link: CallLinkRow; room: RoomRow }> {
  const id = idFromToken(ctx, token);
  if (!id) throw LINK_UNAVAILABLE();
  const link = await ctx.db.get<CallLinkRow>("SELECT * FROM call_links WHERE token_hash = ?", sha256(token as string));
  if (!link || link.id !== id) throw LINK_UNAVAILABLE();
  const st = statusOf(ctx, link);
  if (st !== "active" && st !== "in_use") throw LINK_UNAVAILABLE();
  try {
    await assertWorkspaceActive(ctx, link.workspace_id);
  } catch {
    throw LINK_UNAVAILABLE();
  }
  const room = await ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ? AND workspace_id = ? AND archived = 0", link.room_id, link.workspace_id);
  if (!room) throw LINK_UNAVAILABLE();
  return { link, room };
}

/** who is on the other end, in the words of the page: the AI assistant with its label, or the team */
async function counterpart(ctx: AppContext, link: CallLinkRow, room: RoomRow) {
  const ws = await ctx.db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", link.workspace_id);
  if (link.mode === "ai") {
    const a = await aiCallAvailability(ctx, link.workspace_id, room.inbox_id);
    const row = a.agent;
    return { workspace_name: ws?.name ?? "", who: row ? { name: row.name, label: row.label, avatar_url: row.avatar_url, avatar_alt: row.avatar_alt } : null, ai_available: a.enabled && a[link.kind], ai_config: a };
  }
  return { workspace_name: ws?.name ?? "", who: null, ai_available: false, ai_config: null };
}

/** What the page shows before the visitor agrees to join. A link that is not usable answers with the one generic refusal. */
export async function previewCallLink(ctx: AppContext, token: unknown) {
  const { link, room } = await usable(ctx, token);
  const c = await counterpart(ctx, link, room);
  if (link.mode === "ai" && !c.ai_available) throw LINK_UNAVAILABLE();
  return { mode: link.mode, kind: link.kind, workspace_name: c.workspace_name, ai: c.who, ai_config: c.ai_config, expires_at: link.expires_at };
}

const deviceHash = (device: string) => sha256(`calllink-device|${device}`);

/**
 * Opening the link: checks it again, binds it to the first device that opens it, and mints a session that can only take part in this call. For a call
 * with the team it also tells the team the visitor is waiting (the usual call request, with "Call now").
 */
export async function redeemCallLink(ctx: AppContext, o: { token: unknown; device_id: string; ip: string | null; name?: string }) {
  const { link, room } = await usable(ctx, o.token);
  const dh = deviceHash(o.device_id);
  if (link.device_hash && link.device_hash !== dh) throw LINK_UNAVAILABLE(); // in use on another device
  if (link.mode === "ai" && !(await counterpart(ctx, link, room)).ai_available) throw LINK_UNAVAILABLE();
  const name = o.name ? cleanPlainText(o.name).trim().slice(0, 60) : "";
  const now = nowIso(ctx);
  // claim the device once (two first opens at the same moment: one wins, the other is refused)
  if (!link.device_hash) {
    const claimed = await ctx.db.run("UPDATE call_links SET device_hash = ?, redeemed_at = ?, display_name = ? WHERE id = ? AND device_hash IS NULL", dh, now, name || null, link.id);
    if (!claimed.changes) throw LINK_UNAVAILABLE();
  } else if (name) await ctx.db.run("UPDATE call_links SET display_name = ? WHERE id = ?", name, link.id);
  await expireSessions(ctx, link.id);
  const secret = randomBytes(32).toString("base64url");
  const sid = `ses_${randomBytes(12).toString("hex")}`;
  const expires = new Date(Math.max(Date.parse(link.expires_at), ctx.clock().getTime()) + LINK_CALL_GRACE_MINUTES * 60_000).toISOString();
  await ctx.db.run(
    `INSERT INTO visitor_sessions(id, workspace_id, contact_id, token_id, secret_hash, device_id, ip, verified, user_info, expires_at, expired, created_at, call_link_id)
     VALUES (?,?,?,NULL,?,?,?,0,?,?,0,?,?)`,
    sid, link.workspace_id, room.contact_id, sha256(secret), o.device_id, o.ip, JSON.stringify(name ? { name } : {}), expires, now, link.id,
  );
  await refreshCard(ctx, link, "in_use");
  await postSystemMessage(ctx, room.id, link.workspace_id, `The visitor opened the ${link.mode === "ai" ? "AI assistant" : "team"} call link${name ? ` as "${name}"` : ""}.`, { sub_type: "call_link_opened", link_id: link.id });
  await recordAudit(ctx, { workspaceId: link.workspace_id, actor: { type: "system" }, action: "call_link.opened", target: link.id, detail: { room_id: room.id, mode: link.mode, kind: link.kind } });
  const session = (await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", sid))!;
  if (link.mode === "team") {
    // the team learns that the visitor is waiting: the usual call request with "Call now" (best effort: calls may have been switched off since)
    await requestCall(ctx, session, room.id, link.kind).catch(() => null);
  }
  const c = await counterpart(ctx, link, room);
  return { session_token: secret, device_id: o.device_id, workspace_id: link.workspace_id, room_id: room.id, mode: link.mode, kind: link.kind, workspace_name: c.workspace_name, ai: c.who, ai_config: c.ai_config, expires_at: expires, link_expires_at: link.expires_at, display_name: name || null };
}

/** The call that was started through a link ended: the link is used up and its session closes. */
export async function consumeCallLink(ctx: AppContext, linkId: string): Promise<void> {
  const l = await ctx.db.get<CallLinkRow>("SELECT * FROM call_links WHERE id = ?", linkId);
  if (!l || l.consumed_at) return;
  await ctx.db.run("UPDATE call_links SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", nowIso(ctx), linkId);
  await expireSessions(ctx, linkId);
  await refreshCard(ctx, l, "used");
}

/* ---------- sending it by email or SMS (consent first) ---------- */

/**
 * Send the link through the workspace's own channels, only to a contact who agreed to be contacted (and who did not opt out): the same delivery path as any
 * message, so test mode says `not_sent_test_mode` instead of pretending. The message holds the address, so it stays in the conversation like any message.
 */
export async function sendCallLink(ctx: AppContext, actor: Actor, roomId: string, via: "email" | "sms", url: string, link: CallLinkRow) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const contact = await getContact(ctx, actor.workspaceId, room.contact_id);
  const attrs = parseJson<{ contact_consent?: { at?: string }; call_consent?: { phone?: string } }>(contact.attrs, {});
  if (contact.unsubscribed) throw unprocessable("NO_CONSENT", "This contact unsubscribed: nothing is sent to them");
  if (via === "email") {
    if (!contact.email) throw unprocessable("CONTACT_EMAIL_REQUIRED", "This contact has no email address");
    if (!attrs.contact_consent) throw unprocessable("NO_CONSENT", "This contact has not agreed to be contacted: ask them in the chat first");
  } else {
    if (!contact.phone) throw unprocessable("CONTACT_PHONE_REQUIRED", "This contact has no phone number");
    if (contact.sms_opt_out) throw unprocessable("NO_CONSENT", "This contact opted out of SMS");
    if (!attrs.contact_consent && attrs.call_consent?.phone !== contact.phone) throw unprocessable("NO_CONSENT", "This contact has not agreed to be contacted on this number: ask them in the chat first");
  }
  const when = new Date(link.expires_at).toISOString().slice(11, 16);
  const body = `Join the ${link.kind} call${link.mode === "ai" ? " with our AI assistant" : " with our team"}: ${url}\nThe link works until ${when} UTC, once, on one device.`;
  const sent = await sendAgentMessage(ctx, actor, roomId, via === "email" ? { kind: "text", source: "email", subject: "Your call link", content: body } : { kind: "text", source: "sms", content: body });
  return { channel: via, delivery: sent.message.delivery, message_id: sent.message.id };
}

/** the address of a call-link card, for the visitor's own copy of the thread only */
export function withLinkUrl(ctx: AppContext, card: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!card || card.type !== "call_link" || typeof card.link_id !== "string") return card;
  // a link that is used up or revoked has no address to show any more
  if (card.status === "revoked" || card.status === "used") return card;
  return { ...card, url: linkUrl(ctx, card.link_id) };
}

/** `/call/<token>` -> `/call/[link]`, for logs and error reports */
export const scrubCallPath = (path: string): string => path.replace(/\/call\/[^/?#\s]+/g, "/call/[link]");
