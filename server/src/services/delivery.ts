import { getByRef, putRef } from "./messageRefs.js";
import type { AppContext } from "../context.js";
import type { Attachment } from "../domain/types.js";
import { ProviderError } from "../providers/types.js";
import { parseJson } from "../util/json.js";
import { addMinutes, addSeconds } from "../util/time.js";
import { enqueueJob, runDueJobs } from "../jobs/queue.js";
import { emitMessage, findMessageRow, type MessageRow } from "./messageStore.js";
import { getRoomRow } from "./roomStore.js";
import { creditCost, recordUsage } from "./workspaces.js";
import { getContact } from "./contacts.js";

/** exponential backoff capped, with +-20% jitter in production so a provider outage does not turn into synchronised retry waves */
export const retryDelaySeconds = (ctx: AppContext, attempt: number): number => {
  const base = Math.min(ctx.config.SEND_RETRY_CAP_SECONDS, ctx.config.SEND_RETRY_BASE_SECONDS * 2 ** Math.max(0, attempt - 1));
  return ctx.config.SEND_RETRY_JITTER ? Math.max(1, Math.round(base * (0.8 + Math.random() * 0.4))) : base;
};

async function mark(
  ctx: AppContext,
  msg: { id: string; room_id: string; workspace_id: string },
  
  delivery: "sent" | "failed" | "pending",
  fields: { reason?: string | null; providerId?: string | null; retry?: number } = {},
) {
  if (fields.providerId) await putRef(ctx, "provider", fields.providerId, msg);
  await ctx.db.run(
    "UPDATE messages SET delivery = ?, failure_reason = ?, provider_message_id = COALESCE(?, provider_message_id), retry_count = COALESCE(?, retry_count) WHERE room_id = ? AND id = ?",
    delivery,
    fields.reason ?? null,
    fields.providerId ?? null,
    fields.retry ?? null,
    msg.room_id,
    msg.id,
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
export async function deliverMessage(ctx: AppContext, messageId: string, opts: { paced?: boolean } = {}): Promise<MessageRow> {
  const msg = (await getByRef(ctx, "id", messageId))!;
  if (msg.delivery === "sent" || msg.delivery === "delivered") return msg;
  const room = await getRoomRow(ctx, msg.workspace_id, msg.room_id);
  const kind = msg.source === "sms" ? "sms" : "email";
  let failure: { reason: string; retryable: boolean } | null = null;
  if (ctx.config.SEND_PACING && !opts.paced && msg.from_addr) {
    // carrier/provider-friendly pacing: reserve the next slot for this number or sender; when it is not now, park the message (it stays
    // `pending`) and let a delayed job send it, instead of rejecting. A full queue falls through to the normal retry-with-backoff path.
    const r = await ctx.ratelimit.pace(kind === "sms" ? "sms.number" : "email.sender", msg.from_addr, { queueMax: ctx.config.SEND_QUEUE_MAX });
    if (r.full) failure = { reason: "Sending queue for this number is full, will retry", retryable: true };
    else if (r.waitMs > 0) {
      await enqueueJob(ctx, "paced_send", { message_id: msg.id }, { runAt: new Date(ctx.clock().getTime() + r.waitMs), dedupeKey: `paced:${msg.id}`, workspaceId: msg.workspace_id });
      if (r.waitMs <= 60_000 && ctx.queue.kind === "db") {
        // single-node/DB queue: nudge the poller just after the slot opens so pacing does not wait for the next 10 s sweep
        const t = setTimeout(() => void import("../jobs/scheduler.js").then((m) => runDueJobs(ctx, m.jobHandlers)).catch(() => {}), r.waitMs + 25);
        t.unref();
      }
      return msg;
    }
  }
  try {
    if (failure) throw new ProviderError(failure.reason, true, 429);
    const contact = await getContact(ctx, msg.workspace_id, room.contact_id);
    if (msg.source === "sms") {
      if (contact.sms_opt_out) failure = { reason: "Contact has opted out of SMS", retryable: false };
      else {
        const r = await ctx.sms.send({
          to: msg.to_addr!,
          from: msg.from_addr!,
          body: msg.content_text,
          idempotencyKey: msg.id,
          statusCallbackUrl: `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/status`,
        });
        await mark(ctx, msg, "sent", { providerId: r.providerMessageId });
        // delivery receipts normally arrive by webhook; this delayed check covers the ones that never do
        await enqueueJob(ctx, "reconcile_sms", { message_id: msg.id, attempt: 0 }, { runAt: addMinutes(ctx.clock(), 2), dedupeKey: `reconcile:${msg.id}:0` });
      }
    } else if (msg.source === "email") {
      const sender = await ctx.db.get<{ display_name: string }>(
        "SELECT display_name FROM email_senders WHERE workspace_id = ? AND address = ?",
        msg.workspace_id,
        msg.from_addr,
      );
      const inbound = await ctx.db.get<{ address: string }>("SELECT address FROM inbound_addresses WHERE workspace_id = ? ORDER BY created_at LIMIT 1", msg.workspace_id);
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
      await mark(ctx, msg, "sent", { providerId: r.providerMessageId });
    }
    if (!failure) {
      const cost = creditCost(ctx, kind);
      if (cost > 0) await recordUsage(ctx, msg.workspace_id, kind, -cost, msg.id);
    }
  } catch (e) {
    const retryable = e instanceof ProviderError ? e.retryable : true;
    failure = { reason: e instanceof Error ? e.message.slice(0, 300) : "Unknown delivery error", retryable };
    ctx.log.warn("message delivery failed", { message_id: msg.id, source: msg.source, retryable, reason: failure.reason });
  }
  if (failure) {
    const attempts = msg.retry_count + 1;
    await mark(ctx, msg, "failed", { reason: failure.reason, retry: attempts });
    if (failure.retryable && attempts < ctx.config.SEND_RETRY_MAX_ATTEMPTS) {
      await enqueueJob(
        ctx,
        "send_retry",
        { message_id: msg.id },
        { runAt: addSeconds(ctx.clock(), retryDelaySeconds(ctx, attempts)), dedupeKey: `send_retry:${msg.id}:${attempts}`, workspaceId: msg.workspace_id },
      );
    }
  }
  const fresh = (await findMessageRow(ctx, msg.workspace_id, msg.id, msg.room_id))!;
  await emitMessage(ctx, await getRoomRow(ctx, msg.workspace_id, msg.room_id), fresh, "message:updated");
  return fresh;
}

/** Job handler + manual retry share this. */
export async function retryDelivery(ctx: AppContext, messageId: string): Promise<MessageRow | null> {
  const msg = await getByRef(ctx, "id", messageId);
  if (!msg || msg.deleted_at || msg.delivery !== "failed") return msg ?? null;
  await ctx.db.run("UPDATE messages SET delivery = 'pending' WHERE room_id = ? AND id = ?", msg.room_id, messageId);
  return await deliverMessage(ctx, messageId);
}
