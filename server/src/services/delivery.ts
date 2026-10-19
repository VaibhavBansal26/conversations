import type { AppContext } from "../context.js";
import type { Attachment } from "../domain/types.js";
import { ProviderError } from "../providers/types.js";
import { parseJson } from "../util/json.js";
import { addSeconds } from "../util/time.js";
import { enqueueJob } from "../jobs/queue.js";
import { emitMessage, findMessageRow, type MessageRow } from "./messageStore.js";
import { getRoomRow } from "./roomStore.js";
import { creditCost, recordUsage } from "./workspaces.js";
import { getContact } from "./contacts.js";

export const retryDelaySeconds = (ctx: AppContext, attempt: number): number =>
  Math.min(ctx.config.SEND_RETRY_CAP_SECONDS, ctx.config.SEND_RETRY_BASE_SECONDS * 2 ** Math.max(0, attempt - 1));

function mark(ctx: AppContext, id: string, delivery: "sent" | "failed" | "pending", fields: { reason?: string | null; providerId?: string | null; retry?: number } = {}) {
  ctx.db.run(
    "UPDATE messages SET delivery = ?, failure_reason = ?, provider_message_id = COALESCE(?, provider_message_id), retry_count = COALESCE(?, retry_count) WHERE id = ?",
    delivery, fields.reason ?? null, fields.providerId ?? null, fields.retry ?? null, id,
  );
}

async function attachmentBuffers(ctx: AppContext, atts: Attachment[]) {
  const out: { filename: string; contentType: string; content: Buffer }[] = [];
  for (const a of atts) {
    const content = await ctx.storage.read(a.key);
    if (content) out.push({ filename: a.file_name, contentType: a.content_type, content });
  }
  return out;
}

/**
 * Hand an already-stored outgoing sms/email message to the provider.
 * Never throws: failures keep the message (delivery=failed + reason) and, when transient, schedule an
 * exponential-backoff retry job (capped). The caller broadcasts the resulting state.
 */
export async function deliverMessage(ctx: AppContext, messageId: string): Promise<MessageRow> {
  const msg = ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", messageId)!;
  if (msg.delivery === "sent" || msg.delivery === "delivered") return msg;
  const room = getRoomRow(ctx, msg.workspace_id, msg.room_id);
  const kind = msg.source === "sms" ? "sms" : "email";
  let failure: { reason: string; retryable: boolean } | null = null;
  try {
    const contact = getContact(ctx, msg.workspace_id, room.contact_id);
    if (msg.source === "sms") {
      if (contact.sms_opt_out) failure = { reason: "Contact has opted out of SMS", retryable: false };
      else {
        const r = await ctx.sms.send({
          to: msg.to_addr!, from: msg.from_addr!, body: msg.content_text, idempotencyKey: msg.id,
          statusCallbackUrl: `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/status`,
        });
        mark(ctx, msg.id, "sent", { providerId: r.providerMessageId });
      }
    } else if (msg.source === "email") {
      const sender = ctx.db.get<{ display_name: string }>("SELECT display_name FROM email_senders WHERE workspace_id = ? AND address = ?", msg.workspace_id, msg.from_addr);
      const inbound = ctx.db.get<{ address: string }>("SELECT address FROM inbound_addresses WHERE workspace_id = ? ORDER BY created_at LIMIT 1", msg.workspace_id);
      const refs = (msg.references_hdr ?? "").split(/\s+/).filter(Boolean);
      const r = await ctx.email.send({
        from: { address: msg.from_addr!, name: sender?.display_name || undefined },
        to: msg.to_addr!,
        subject: msg.subject ?? "(no subject)",
        html: msg.content,
        text: msg.content_text,
        messageId: msg.rfc_message_id!,
        inReplyTo: msg.in_reply_to ?? undefined,
        references: refs.length ? refs : undefined,
        replyTo: inbound?.address,
        attachments: await attachmentBuffers(ctx, parseJson<Attachment[]>(msg.attachments, [])),
      });
      mark(ctx, msg.id, "sent", { providerId: r.providerMessageId });
    }
    if (!failure) {
      const cost = creditCost(ctx, kind);
      if (cost > 0) recordUsage(ctx, msg.workspace_id, kind, -cost, msg.id);
    }
  } catch (e) {
    const retryable = e instanceof ProviderError ? e.retryable : true;
    failure = { reason: e instanceof Error ? e.message.slice(0, 300) : "Unknown delivery error", retryable };
    ctx.log.warn("message delivery failed", { message_id: msg.id, source: msg.source, retryable, reason: failure.reason });
  }
  if (failure) {
    const attempts = msg.retry_count + 1;
    mark(ctx, msg.id, "failed", { reason: failure.reason, retry: attempts });
    if (failure.retryable && attempts < ctx.config.SEND_RETRY_MAX_ATTEMPTS) {
      enqueueJob(ctx, "send_retry", { message_id: msg.id }, { runAt: addSeconds(ctx.clock(), retryDelaySeconds(ctx, attempts)), dedupeKey: `send_retry:${msg.id}:${attempts}` });
    }
  }
  const fresh = findMessageRow(ctx, msg.workspace_id, msg.id)!;
  emitMessage(ctx, getRoomRow(ctx, msg.workspace_id, msg.room_id), fresh, "message:updated");
  return fresh;
}

/** Job handler + manual retry share this. */
export async function retryDelivery(ctx: AppContext, messageId: string): Promise<MessageRow | null> {
  const msg = ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", messageId);
  if (!msg || msg.deleted_at || msg.delivery !== "failed") return msg ?? null;
  ctx.db.run("UPDATE messages SET delivery = 'pending' WHERE id = ?", messageId);
  return deliverMessage(ctx, messageId);
}

