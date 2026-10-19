import type { AppContext } from "../context.js";
import { addMinutes } from "../util/time.js";
import { collectDigests, sendDigestEmail } from "../services/digest.js";
import { retryDelivery } from "../services/delivery.js";
import { applyDelivery } from "../services/inbound.js";
import type { MessageRow } from "../services/messageStore.js";
import { notifySnoozeEnded, sendNotificationEmail } from "../services/notifications.js";
import { wakeDueRooms } from "../services/rooms.js";
import { runDueJobs, type JobHandler } from "./queue.js";

export const jobHandlers: Record<string, JobHandler> = {
  send_retry: async (ctx, p: { message_id: string }) => void (await retryDelivery(ctx, p.message_id)),
  notify_email: (ctx, p) => sendNotificationEmail(ctx, p),
  digest_email: (ctx, p) => sendDigestEmail(ctx, p),
};

/**
 * Safety net for missed Twilio status callbacks (replaces the legacy 5-second polling cron): asks the provider about
 * SMS that are still "sent" after a couple of minutes. Providers without fetchStatus are skipped.
 */
export async function reconcileDeliveries(ctx: AppContext, opts: { minAgeMinutes?: number; maxAgeHours?: number; limit?: number } = {}): Promise<number> {
  if (!ctx.sms.fetchStatus) return 0;
  const now = ctx.clock();
  const rows = ctx.db.all<MessageRow>(
    `SELECT * FROM messages WHERE source = 'sms' AND delivery = 'sent' AND provider_message_id IS NOT NULL AND created_at <= ? AND created_at >= ? ORDER BY created_at LIMIT ?`,
    addMinutes(now, -(opts.minAgeMinutes ?? 2)).toISOString(), addMinutes(now, -60 * (opts.maxAgeHours ?? 72)).toISOString(), opts.limit ?? 50,
  );
  let changed = 0;
  for (const m of rows) {
    try {
      const s = await ctx.sms.fetchStatus(m.provider_message_id!);
      if (s.state === "delivered" || s.state === "failed") {
        if (applyDelivery(ctx, m, s.state, s.error) === "updated") changed++;
      }
    } catch (e) {
      ctx.log.warn("delivery reconciliation failed", { message_id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return changed;
}

/** One scheduler pass; exposed so tests (and a manual `kick`) can drive time explicitly. */
export async function tick(ctx: AppContext, parts: { snooze?: boolean; jobs?: boolean; digest?: boolean; reconcile?: boolean } = { snooze: true, jobs: true }) {
  const out = { woken: 0, jobs: 0, digests: 0, reconciled: 0 };
  if (parts.snooze) out.woken = wakeDueRooms(ctx, notifySnoozeEnded.bind(null, ctx));
  if (parts.digest) out.digests = collectDigests(ctx).queued;
  if (parts.jobs) out.jobs = (await runDueJobs(ctx, jobHandlers)).ran;
  if (parts.reconcile) out.reconciled = await reconcileDeliveries(ctx);
  return out;
}

export function startScheduler(ctx: AppContext): () => void {
  let busy = false;
  let n = 0;
  const guard = (fn: () => Promise<unknown>) => async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      ctx.log.error("scheduler pass failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
    }
  };
  const t = setInterval(guard(() => {
    n++;
    return tick(ctx, { snooze: true, jobs: true, digest: n % 6 === 0, reconcile: n % 6 === 3 });
  }), 10_000);
  t.unref();
  return () => clearInterval(t);
}
