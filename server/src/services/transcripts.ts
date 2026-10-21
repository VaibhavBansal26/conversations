import { createHmac } from "node:crypto";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound } from "../errors.js";
import { redactPii } from "../ai/text.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { safeEqual } from "../util/crypto.js";
import { recordAudit } from "./audit.js";
import { getContact, patchContact, type ContactRow } from "./contacts.js";
import { VISITOR_VISIBLE_SQL, type MessageRow } from "./messageStore.js";
import { getRoomRow, getVisibleRoom, type RoomRow } from "./roomStore.js";
import { liveTicketOf, type TicketRow } from "./tickets.js";
import type { SessionRow } from "./visitors.js";
import { getVisitorRoom } from "./visitorChat.js";
import { getSettings } from "./workspaces.js";

/**
 * A copy of a conversation by email (docs/TRANSCRIPTS.md). Off by default (Settings > Tickets > Transcripts). The rules:
 *  - it goes ONLY to the email address of the contact of this conversation, and only when that address is confirmed for the visitor: their session
 *    is verified (a code by email or SMS, or a signed identity), or they gave the address in this conversation with consent (the details form).
 *    Otherwise the visitor is asked to confirm it with a code (VERIFY_EMAIL_FIRST) or to give it (EMAIL_REQUIRED, the form is shown);
 *  - what the visitor saw, nothing else: no internal notes, no internal system lines, nothing about the AI's reasoning; attachments by name only;
 *  - personal data masked when the workspace asks (the transcript's own switch or "redact personal data" of the AI settings);
 *  - 3 copies per contact per hour; one automatic copy per ticket after it is resolved (optional);
 *  - every send is in the audit log and in `transcript_sends`; in test mode nothing leaves and the answer says so.
 */
export interface TranscriptSettings {
  enabled: boolean;
  send_after_resolve: boolean;
  redact: boolean;
}

const hint = (email: string) => {
  const [u, d] = email.split("@");
  return `${(u ?? "").slice(0, 1)}…@${d ?? ""}`;
};

/** May this contact receive a transcript without a code? */
async function confirmed(ctx: AppContext, contact: ContactRow, session: SessionRow | null): Promise<boolean> {
  if (session?.verified) return true;
  // consent given in the details form together with this very address (not one typed in the pre-chat form, which anyone can type)
  const attrs = parseJson<{ contact_consent?: { at?: string; email?: string | null; via?: string } }>(contact.attrs, {});
  if (attrs.contact_consent?.at && contact.email && attrs.contact_consent.via !== "prechat" && attrs.contact_consent.email === contact.email) return true;
  // a verified session of the same contact (another device that did confirm the address) also counts
  return !!(await ctx.db.get("SELECT 1 FROM visitor_sessions WHERE contact_id = ? AND workspace_id = ? AND verified = 1 LIMIT 1", contact.id, contact.workspace_id));
}

/** What the visitor saw, as text and as simple HTML. */
export async function buildTranscript(ctx: AppContext, room: RoomRow, o: { ticketId?: string | null; redact: boolean; workspaceName: string }) {
  const rows = await ctx.db.all<MessageRow>(
    `SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND ${VISITOR_VISIBLE_SQL} ${o.ticketId ? "AND ticket_id = ?" : ""} ORDER BY seq LIMIT 500`,
    room.id,
    ...(o.ticketId ? [o.ticketId] : []),
  );
  const lines: { at: string; who: string; text: string }[] = [];
  for (const m of rows) {
    const meta = parseJson<{ internal?: boolean; card?: { type?: string } }>(m.meta, {});
    if (meta.internal) continue;
    const files = parseJson<{ file_name?: string }[]>(m.attachments, []).map((a) => `[attachment: ${a.file_name ?? "file"}]`);
    let text = [m.content_text?.trim(), ...files].filter(Boolean).join(" ");
    if (!text) continue;
    if (o.redact) text = redactPii(text);
    const who = m.sender_type === "contact" ? "You" : m.sender_type === "system" ? o.workspaceName : m.sender_type === "bot" ? `${m.sender_name || "Assistant"} (AI)` : m.sender_name || o.workspaceName;
    lines.push({ at: m.created_at, who, text });
  }
  const fmt = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = lines.map((l) => `[${fmt(l.at)}] ${l.who}: ${l.text}`).join("\n\n");
  const html = lines.map((l) => `<p><small>${esc(fmt(l.at))}</small><br><strong>${esc(l.who)}</strong>: ${esc(l.text).replace(/\n/g, "<br>")}</p>`).join("\n");
  return { text, html, count: lines.length };
}

/** A link that stops automatic copies to this contact (it does not stop copies they ask for). Signed, so it cannot be forged for another contact. */
export function unsubscribeToken(ctx: AppContext, ws: string, contactId: string): string {
  const body = Buffer.from(`${ws}.${contactId}`).toString("base64url");
  const sig = createHmac("sha256", ctx.config.JWT_SECRET).update(`transcript-unsub|${body}`).digest("base64url").slice(0, 32);
  return `${body}.${sig}`;
}
export async function unsubscribeByToken(ctx: AppContext, token: string): Promise<boolean> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const expect = createHmac("sha256", ctx.config.JWT_SECRET).update(`transcript-unsub|${body}`).digest("base64url").slice(0, 32);
  if (!safeEqual(expect, sig)) return false;
  const [ws, contactId] = Buffer.from(body, "base64url").toString().split(".");
  if (!ws || !contactId) return false;
  const c = await ctx.db.get<ContactRow>("SELECT * FROM contacts WHERE id = ? AND workspace_id = ?", contactId, ws);
  if (!c) return false;
  await patchContact(ctx, ws, c.id, { unsubscribed: true });
  await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "contact.unsubscribed", target: c.id, detail: { via: "transcript_link" } });
  return true;
}

type By = { type: "visitor" } | { type: "member"; actor: Actor } | { type: "ai"; agentId: string } | { type: "after_resolve" };
export interface SendResult {
  status: "sent" | "not_sent_test_mode" | "failed";
  to: string;
  messages: number;
}

/** The send itself (the checks are done by the callers). */
async function send(ctx: AppContext, room: RoomRow, contact: ContactRow, ticket: TicketRow | null | undefined, by: By): Promise<SendResult> {
  const ws = room.workspace_id;
  const settings = await getSettings(ctx, ws);
  const t = settings.transcripts;
  const wsRow = (await ctx.db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", ws))!;
  const tr = await buildTranscript(ctx, room, { ticketId: null, redact: t.redact || settings.ai_redact_pii, workspaceName: wsRow.name });
  if (!tr.count) throw new AppError(409, "NOTHING_TO_SEND", "There is nothing in this conversation yet");
  const to = contact.email!;
  const base = ctx.config.PUBLIC_URL.replace(/\/$/, "");
  const auto = by.type === "after_resolve";
  const footer = auto
    ? `You receive this copy because ${wsRow.name} sends one after a conversation is resolved. To stop these copies: ${base}/public/transcripts/unsubscribe/${unsubscribeToken(ctx, ws, contact.id)}`
    : `You receive this copy because it was asked for in this conversation with ${wsRow.name}. It is a one-time copy, not a subscription.`;
  const subject = `Your conversation with ${wsRow.name}${ticket ? ` (#${ticket.number})` : ""}`;
  const route = await ctx.providers.email(ws);
  const sender = await ctx.db.get<{ address: string; display_name: string }>("SELECT address, display_name FROM email_senders WHERE workspace_id = ? AND verified = 1 ORDER BY is_default DESC, created_at LIMIT 1", ws);
  const from = sender ? { address: sender.address, name: sender.display_name || wsRow.name } : { address: ctx.config.SYSTEM_EMAIL_FROM, name: wsRow.name };
  let status: SendResult["status"] = "sent";
  try {
    await route.provider.send({
      from,
      to,
      subject,
      text: `${subject}\n\n${tr.text}\n\n--\n${footer}`,
      html: `<p><strong>${subject.replace(/</g, "&lt;")}</strong></p>\n${tr.html}\n<hr><p><small>${footer.replace(/</g, "&lt;").replace(/(https?:\/\/\S+)/, '<a href="$1">$1</a>')}</small></p>`,
      messageId: `<${newId("tr")}@${from.address.split("@")[1] ?? "localhost"}>`,
      extraHeaders: { "Auto-Submitted": auto ? "auto-generated" : "auto-replied" },
    });
    if (route.simulated) status = "not_sent_test_mode";
  } catch (e) {
    ctx.log.warn("transcript email failed", { room_id: room.id, error: e instanceof Error ? e.name : "error" });
    status = "failed";
  }
  const id = newId("trs");
  await ctx.db.run(
    "INSERT INTO transcript_sends(id, workspace_id, room_id, ticket_id, contact_id, requested_by, member_id, to_hint, status, messages, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    id, ws, room.id, ticket?.id ?? null, contact.id, by.type, by.type === "member" ? by.actor.memberId : null, hint(to), status, tr.count, nowIso(ctx),
  );
  await recordAudit(ctx, {
    workspaceId: ws,
    actor: by.type === "member" ? { type: "member", id: by.actor.memberId } : by.type === "visitor" ? { type: "anonymous", id: contact.id } : { type: "system" },
    action: "transcript.sent",
    target: room.id,
    detail: { by: by.type, status, messages: tr.count, to: hint(to), ticket_id: ticket?.id ?? null },
  });
  const who = { visitor: "asked by the visitor", member: "sent by a team member", ai: "asked through the AI agent", after_resolve: "sent automatically after the resolution" }[by.type];
  const { postSystemMessage } = await import("./messageStore.js");
  await postSystemMessage(ctx, room.id, ws, status === "sent" ? `A copy of this conversation was emailed to ${hint(to)} (${who}).` : status === "not_sent_test_mode" ? `A copy of this conversation was NOT emailed (test mode: email is not connected) (${who}).` : `A copy of this conversation could not be emailed (${who}).`, { sub_type: "transcript_sent", internal: true, status });
  if (status === "failed") throw new AppError(502, "TRANSCRIPT_NOT_SENT", "The email could not be sent. Please try again later.");
  return { status, to: hint(to), messages: tr.count };
}

async function contactLimit(ctx: AppContext, ws: string, contactId: string) {
  const rl = await ctx.ratelimit.check("transcript.contact", { key: `${ws}:${contactId}`, workspaceId: ws });
  if (!rl.allowed) throw new RateLimitedError(rl);
}

/** The visitor asks (the button in the chat, or the AI on their behalf). */
export async function visitorRequestTranscript(ctx: AppContext, session: SessionRow, roomId: string, by: By = { type: "visitor" }): Promise<SendResult> {
  const room = await getVisitorRoom(ctx, session, roomId);
  const settings = await getSettings(ctx, room.workspace_id);
  if (!settings.transcripts.enabled) throw new AppError(403, "TRANSCRIPTS_DISABLED", "Copies of conversations by email are not available");
  const contact = await getContact(ctx, room.workspace_id, room.contact_id);
  const ticket = await liveTicketOf(ctx, room.id);
  if (!contact.email) {
    // ask for the address in the chat, with the workspace's consent wording; the visitor tries again once it is given
    if (ticket) {
      const { requestVisitorInfo } = await import("./visitorInfo.js");
      await requestVisitorInfo(ctx, ticket.id, "agent", { only: ["email"], force: true, text: "To send you a copy of this conversation, what is your email address?" }).catch(() => null);
    }
    throw new AppError(409, "EMAIL_REQUIRED", "Share your email address in the chat first");
  }
  if (!(await confirmed(ctx, contact, session))) throw new AppError(409, "VERIFY_EMAIL_FIRST", "Confirm your email address with a code first", { channel: "email" });
  await contactLimit(ctx, room.workspace_id, contact.id);
  return send(ctx, await getRoomRow(ctx, room.workspace_id, room.id), contact, ticket, by);
}

/** A team member sends a copy to the contact's own address on file (permission conversations:reply). */
export async function agentSendTranscript(ctx: AppContext, actor: Actor, roomId: string): Promise<SendResult> {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const contact = await getContact(ctx, actor.workspaceId, room.contact_id);
  if (!contact.email) throw new AppError(409, "CONTACT_EMAIL_REQUIRED", "This contact has no email address");
  const rl = await ctx.ratelimit.check("transcript.member", { key: `${actor.workspaceId}:${actor.memberId}`, workspaceId: actor.workspaceId });
  if (!rl.allowed) throw new RateLimitedError(rl);
  await contactLimit(ctx, actor.workspaceId, contact.id);
  return send(ctx, await getRoomRow(ctx, actor.workspaceId, room.id), contact, await liveTicketOf(ctx, room.id), { type: "member", actor });
}

/** The optional automatic copy after a ticket is resolved: once per ticket, only to a confirmed address, never to a contact who unsubscribed. */
export async function maybeSendAfterResolve(ctx: AppContext, ticketId: string): Promise<SendResult | null> {
  const t = await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", ticketId);
  if (!t || (t.status !== "resolved" && t.status !== "closed")) return null;
  const settings = await getSettings(ctx, t.workspace_id);
  if (!settings.transcripts.enabled || !settings.transcripts.send_after_resolve) return null;
  const room = await ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ?", t.room_id);
  if (!room) return null;
  const contact = await getContact(ctx, t.workspace_id, room.contact_id);
  if (!contact.email || contact.unsubscribed || !(await confirmed(ctx, contact, null))) return null;
  if (await ctx.db.get("SELECT 1 FROM transcript_sends WHERE ticket_id = ? AND requested_by = 'after_resolve'", t.id)) return null;
  try {
    return await send(ctx, room, contact, t, { type: "after_resolve" });
  } catch (e) {
    if (isUniqueViolation(e) || (e instanceof AppError && e.code === "NOTHING_TO_SEND")) return null;
    throw e;
  }
}

/** The team's list of copies sent from a conversation. */
export async function listTranscriptSends(ctx: AppContext, actor: Actor, roomId: string) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  if (!room) throw notFound("Conversation");
  const rows = await ctx.db.all<{ id: string; requested_by: string; to_hint: string; status: string; messages: number; created_at: string; ticket_id: string | null }>(
    "SELECT id, requested_by, to_hint, status, messages, created_at, ticket_id FROM transcript_sends WHERE room_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 20",
    room.id, actor.workspaceId,
  );
  return { data: rows };
}

/** The AI agent's tool: the same checks as the visitor's button, without a session (only an address confirmed by consent or a verified session counts). */
export async function visitorRequestTranscriptForContact(ctx: AppContext, room: RoomRow, agentId: string): Promise<{ ok: boolean; detail: string }> {
  const settings = await getSettings(ctx, room.workspace_id);
  if (!settings.transcripts.enabled) return { ok: false, detail: "copies by email are switched off" };
  const contact = await getContact(ctx, room.workspace_id, room.contact_id);
  const ticket = await liveTicketOf(ctx, room.id);
  if (!contact.email) {
    if (ticket) {
      const { requestVisitorInfo } = await import("./visitorInfo.js");
      await requestVisitorInfo(ctx, ticket.id, "agent", { only: ["email"], force: true, text: "To send you a copy of this conversation, what is your email address?" }).catch(() => null);
    }
    return { ok: false, detail: "no email address yet: the visitor was asked for one" };
  }
  if (!(await confirmed(ctx, contact, null))) return { ok: false, detail: "the address is not confirmed: the visitor can confirm it with a code and use Email me a copy" };
  try {
    await contactLimit(ctx, room.workspace_id, contact.id);
    const r = await send(ctx, room, contact, ticket, { type: "ai", agentId });
    return { ok: true, detail: r.status === "sent" ? `to ${r.to}` : "test mode: not sent" };
  } catch (e) {
    return { ok: false, detail: e instanceof AppError ? e.message : "it could not be sent" };
  }
}
