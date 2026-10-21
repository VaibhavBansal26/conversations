import { getByRef } from "./messageRefs.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";

import { AppError } from "../errors.js";
import { classifySmsKeyword, lockChannel } from "../channels/rules.js";
import { sanitizeBody } from "./messages.js";
import { claimEvent } from "../webhooks/signatures.js";
import { cleanPlainText, htmlToText, textToHtml } from "../util/html.js";
import { sha256 } from "../util/crypto.js";
import { normalizeEmail, normalizePhone } from "../util/phone.js";
import { findByEmail, findOrCreateContact, setSmsOptOut, type ContactRow } from "./contacts.js";
import { markOpened } from "./rooms.js";
import { findRoomRow, getRoomRow, type RoomRow } from "./roomStore.js";
import { emitInserted, emitMessage, findMessageRow, insertMessage, postSystemMessage, type MessageRow } from "./messageStore.js";
import { onContactMessage } from "./postProcess.js";
import { findOrCreateRoom } from "./rooms.js";
import { getSettings } from "./workspaces.js";

const defaultInbox = async (ctx: AppContext, ws: string, col: "default_sms_inbound" | "default_email_inbound") =>
  (await ctx.db.get<{ id: string }>(`SELECT id FROM inboxes WHERE workspace_id = ? AND ${col} = 1`, ws))?.id ?? null;

export interface InboundSms {
  From: string;
  To: string;
  Body: string;
  MessageSid: string;
}

/** Set when the request came in on a workspace's own webhook URL (verified with THAT workspace's credentials): nothing outside it may be touched. */
export interface InboundScope {
  workspaceId: string;
}

export type InboundResult = { status: "processed" | "duplicate" | "ignored"; room_id?: string; message_id?: string; keyword?: "opt_out" | "opt_in" };

/** Twilio inbound SMS. Idempotent on MessageSid. */
export async function handleInboundSms(ctx: AppContext, p: InboundSms, scope?: InboundScope): Promise<InboundResult> {
  const num = await ctx.db.get<{ workspace_id: string }>("SELECT workspace_id FROM sms_numbers WHERE e164 = ?", p.To);
  // a request that arrived on one workspace's webhook can only deliver to that workspace's numbers
  if (!num || (scope && num.workspace_id !== scope.workspaceId)) return { status: "ignored" };
  const ws = num.workspace_id;
  if (!(await claimEvent(ctx, "twilio_inbound", p.MessageSid))) return { status: "duplicate" };
  const from = normalizePhone(p.From, (await getSettings(ctx, ws)).default_region);
  if (!from) return { status: "ignored" };
  const body = cleanPlainText(p.Body ?? "").trim();
  const keyword = classifySmsKeyword(body);

  const { contact } = await findOrCreateContact(ctx, ws, { phone: from, source: "sms" });
  if (keyword === "opt_out") await setSmsOptOut(ctx, ws, contact.id, true);
  if (keyword === "opt_in") await setSmsOptOut(ctx, ws, contact.id, false);

  let room: RoomRow | undefined;
  const lock = await ctx.db.get<{ room_id: string }>(
    "SELECT room_id FROM message_locks WHERE workspace_id = ? AND type = 'sms' AND from_addr = ? AND to_addr = ?",
    ws,
    p.To,
    from,
  );
  if (lock) room = await findRoomRow(ctx, ws, lock.room_id);
  if (!room) room = (await findOrCreateRoom(ctx, ws, { contactId: contact.id, inboxId: await defaultInbox(ctx, ws, "default_sms_inbound"), roomType: "inbound" })).room;
  try {
    await lockChannel(ctx, ws, room.id, "sms", p.To, from);
  } catch (e) {
    // pair already pinned by another room: routing still works by contact
    if (!(e instanceof AppError)) throw e;
  }
  if (!body) return { status: "ignored", room_id: room.id };

  const r = await insertMessage(ctx, {
    workspaceId: ws,
    roomId: room.id,
    senderType: "contact",
    senderId: contact.id,
    senderName: contact.name || from,
    kind: "text",
    source: "sms",
    content: body,
    contentText: body,
    providerMessageId: p.MessageSid,
    fromAddr: from,
    toAddr: p.To,
    meta: keyword ? { keyword } : {},
  });
  await emitInserted(ctx, r);
  if (keyword) {
    await postSystemMessage(ctx, room.id, ws, keyword === "opt_out" ? "Contact opted out of SMS. Further texts are blocked." : "Contact opted back in to SMS.", {
      sub_type: "sms_consent",
      keyword,
    });
  }
  await onContactMessage(ctx, r.room, r.message);
  return { status: "processed", room_id: room.id, message_id: r.message.id, keyword: keyword ?? undefined };
}

/** Twilio delivery callback. Never downgrades delivered -> sent, so out-of-order callbacks are harmless. */
export async function handleTwilioStatus(
  ctx: AppContext,
  p: { MessageSid: string; MessageStatus: string; ErrorCode?: string },
  scope?: InboundScope,
): Promise<"updated" | "ignored" | "duplicate"> {
  if (!(await claimEvent(ctx, "twilio_status", `${p.MessageSid}:${p.MessageStatus}`))) return "duplicate";
  const m = await getByRef(ctx, "provider", p.MessageSid, { source: "sms" });
  if (!m || (scope && m.workspace_id !== scope.workspaceId)) return "ignored";
  return await applyDelivery(ctx, m, p.MessageStatus, p.ErrorCode ? `Carrier error ${p.ErrorCode}` : undefined);
}

export async function applyDelivery(ctx: AppContext, m: MessageRow, status: string, reason?: string): Promise<"updated" | "ignored"> {
  if (status === "delivered") {
    await ctx.db.run("UPDATE messages SET delivery = 'delivered', delivered_at = COALESCE(delivered_at, ?), failure_reason = NULL WHERE room_id = ? AND id = ?", nowIso(ctx), m.room_id, m.id);
  } else if (status === "failed" || status === "undelivered" || status === "bounce" || status === "dropped") {
    if (m.delivery === "delivered") return "ignored";
    await ctx.db.run("UPDATE messages SET delivery = 'failed', failure_reason = ? WHERE room_id = ? AND id = ?", reason ?? `Provider reported ${status}`, m.room_id, m.id);
  } else if (status === "sent" && m.delivery === "pending") {
    await ctx.db.run("UPDATE messages SET delivery = 'sent' WHERE room_id = ? AND id = ?", m.room_id, m.id);
  } else return "ignored";
  await emitMessage(ctx, await getRoomRow(ctx, m.workspace_id, m.room_id), (await findMessageRow(ctx, m.workspace_id, m.id, m.room_id))!, "message:updated");
  return "updated";
}

export interface InboundEmail {
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: string;
}

export function parseAddress(v: string): { address: string; name: string } | null {
  const m = v.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/) ?? v.match(/^\s*()([^\s<>,]+@[^\s<>,]+)\s*$/);
  const address = normalizeEmail(m?.[2]);
  return address ? { address, name: (m?.[1] ?? "").trim() } : null;
}

export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const ids = (v: string | undefined): string[] => v?.match(/<[^>]+>/g) ?? [];

/** SendGrid inbound parse. Idempotent on Message-ID. */
export async function handleInboundEmail(ctx: AppContext, p: InboundEmail, scope?: InboundScope): Promise<InboundResult> {
  const sender = parseAddress(p.from);
  if (!sender) return { status: "ignored" };
  let ws: string | undefined;
  for (const raw of p.to.split(",")) {
    const a = parseAddress(raw);
    const hit = a && (await ctx.db.get<{ workspace_id: string }>("SELECT workspace_id FROM inbound_addresses WHERE address = ?", a.address));
    if (hit && (!scope || hit.workspace_id === scope.workspaceId)) {
      ws = hit.workspace_id;
      break;
    }
  }
  if (!ws) return { status: "ignored" };
  const headers = parseHeaders(p.headers);
  const rfcId = ids(headers["message-id"])[0] ?? `<${sha256(`${sender.address}|${p.to}|${p.subject}|${p.text}`).slice(0, 32)}@generated.local>`;
  if (!(await claimEvent(ctx, `email_inbound:${ws}`, rfcId))) return { status: "duplicate" };

  const inReplyTo = ids(headers["in-reply-to"]);
  const refs = ids(headers["references"]);
  let room: RoomRow | undefined;
  const candidates = [...inReplyTo, ...[...refs].reverse()];
  for (const id of candidates) {
    const m = await ctx.db.get<{ room_id: string }>("SELECT room_id FROM message_refs WHERE kind = 'rfc' AND ref = ? AND workspace_id = ?", id, ws);
    if (m) {
      room = await findRoomRow(ctx, ws, m.room_id);
      if (room) break;
    }
  }
  let contact: ContactRow | undefined;
  if (!room) {
    const lock = await ctx.db.get<{ room_id: string }>("SELECT room_id FROM message_locks WHERE workspace_id = ? AND type = 'email' AND to_addr = ?", ws, sender.address);
    if (lock) room = await findRoomRow(ctx, ws, lock.room_id);
  }
  if (room) contact = await ctx.db.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", room.contact_id);
  if (!room || !contact) {
    contact = (await findByEmail(ctx, ws, sender.address)) ?? (await findOrCreateContact(ctx, ws, { name: sender.name, email: sender.address, source: "email" })).contact;
    room = (
      await findOrCreateRoom(ctx, ws, {
        contactId: contact.id,
        inboxId: await defaultInbox(ctx, ws, "default_email_inbound"),
        roomType: "inbound",
        subject: p.subject?.trim() || null,
      })
    ).room;
  }
  let html: string;
  let text: string;
  if (p.html?.trim()) {
    const body = await sanitizeBody(ctx, p.html);
    html = body.html;
    text = p.text?.trim() ? cleanPlainText(p.text).trim() : body.text;
  } else {
    html = textToHtml(cleanPlainText(p.text ?? ""));
    text = p.text?.trim() ? cleanPlainText(p.text).trim() : htmlToText(html);
  }
  if (!text && !html) return { status: "ignored", room_id: room.id };
  if (!room.subject && p.subject?.trim()) await ctx.db.run("UPDATE rooms SET subject = ? WHERE id = ?", p.subject.trim(), room.id);

  const r = await insertMessage(ctx, {
    workspaceId: ws,
    roomId: room.id,
    senderType: "contact",
    senderId: contact.id,
    senderName: contact.name || sender.address,
    kind: "text",
    source: "email",
    content: html,
    contentText: text,
    subject: p.subject?.trim() || null,
    rfcMessageId: rfcId,
    inReplyTo: inReplyTo[0] ?? null,
    referencesHdr: refs.join(" ") || null,
    fromAddr: sender.address,
    toAddr: p.to,
  });
  await emitInserted(ctx, r);
  await onContactMessage(ctx, r.room, r.message);
  return { status: "processed", room_id: room.id, message_id: r.message.id };
}

export interface SendgridEvent {
  event?: string;
  sg_event_id?: string;
  sg_message_id?: string;
  "smtp-id"?: string;
  reason?: string;
}

/** SendGrid event webhook: delivered / open / bounce / dropped for outgoing email. Idempotent on sg_event_id. */
export async function handleSendgridEvents(ctx: AppContext, events: SendgridEvent[], scope?: InboundScope): Promise<{ processed: number; ignored: number }> {
  let processed = 0;
  let ignored = 0;
  for (const ev of events) {
    const type = ev.event;
    if (!type || (ev.sg_event_id && !(await claimEvent(ctx, "sendgrid_event", ev.sg_event_id)))) {
      ignored++;
      continue;
    }
    const providerId = ev.sg_message_id?.split(".")[0];
    const m =
      (providerId && (await getByRef(ctx, "provider", providerId, { source: "email" }))) ||
      (ev["smtp-id"] && (await getByRef(ctx, "rfc", ev["smtp-id"], { source: "email" }))) ||
      undefined;
    if (!m || (scope && m.workspace_id !== scope.workspaceId)) {
      ignored++;
      continue;
    }
    if (type === "open") {
      await markOpened(ctx, m.workspace_id, m);
      processed++;
    } else if ((await applyDelivery(ctx, m, type, ev.reason)) === "updated") processed++;
    else ignored++;
  }
  return { processed, ignored };
}
