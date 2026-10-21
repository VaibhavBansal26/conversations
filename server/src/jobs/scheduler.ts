import { getByRef } from "../services/messageRefs.js";
import type { AppContext } from "../context.js";
import { addMinutes } from "../util/time.js";
import { collectDigests, sendDigestEmail } from "../services/digest.js";
import { retryDelivery, deliverMessage } from "../services/delivery.js";
import { applyDelivery } from "../services/inbound.js";
import type { MessageRow } from "../services/messageStore.js";
import type { RoomRow } from "../services/roomStore.js";
import { notifySnoozeEnded, sendNotificationEmail } from "../services/notifications.js";
import { wakeDueRooms, wakeRoom } from "../services/rooms.js";
import { nowIso } from "../context.js";
import { ensureMessagePartitions } from "../db/partitions.js";
import { retentionSweep } from "../services/archive.js";
import { ticketSweep } from "../services/tickets.js";
import { drainQueue, slaSweep } from "../services/routing.js";
import { teamRetentionSweep } from "../services/teamChat.js";
import { runAutoRecharge } from "../billing/credits.js";
import { enqueueJob, runDueJobs, type JobHandler } from "./queue.js";

export const jobHandlers: Record<string, JobHandler> = {
  send_retry: async (ctx, p: { message_id: string }) => void (await retryDelivery(ctx, p.message_id)),
  paced_send: async (ctx, p: { message_id: string }) => void (await deliverMessage(ctx, p.message_id, { paced: true })),
  notify_email: (ctx, p) => sendNotificationEmail(ctx, p),
  auto_recharge: async (ctx, p: { workspace_id: string; bucket: number }) => void (await runAutoRecharge(ctx, p)),
  digest_email: (ctx, p) => sendDigestEmail(ctx, p),
  wake_room: async (ctx, p: { room_id: string; until: string }) => {
    const r = await ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ? AND archived = 0", p.room_id);
    if (r?.snooze_until && r.snooze_until <= nowIso(ctx)) await wakeRoom(ctx, r, (room, by) => notifySnoozeEnded(ctx, room, by));
  },
  reconcile_sms: async (ctx, p: { message_id: string; attempt: number }) => {
    const m = await getByRef(ctx, "id", p.message_id);
    if (!m || m.delivery !== "sent" || !m.provider_message_id) return;
    const sms = (await ctx.providers.sms(m.workspace_id)).provider;
    if (!sms.fetchStatus) return;
    const s = await sms.fetchStatus(m.provider_message_id);
    if (s.state === "delivered" || s.state === "failed") {
      await applyDelivery(ctx, m, s.state, s.error);
      return;
    }
    // still in flight: look again later (2, 4, 8 ... minutes), a few times; status webhooks normally settle it first
    if (p.attempt < 5) await enqueueJob(ctx, "reconcile_sms", { message_id: m.id, attempt: p.attempt + 1 }, { runAt: addMinutes(ctx.clock(), 2 ** (p.attempt + 1)), dedupeKey: `reconcile:${m.id}:${p.attempt + 1}` });
  },
};

/**
 * Safety net for missed Twilio status callbacks (replaces the legacy 5-second polling cron): asks the provider about
 * SMS that are still "sent" after a couple of minutes. Providers without fetchStatus are skipped.
 */
export async function reconcileDeliveries(ctx: AppContext, opts: { minAgeMinutes?: number; maxAgeHours?: number; limit?: number } = {}): Promise<number> {
  const now = ctx.clock();
  const rows = await ctx.db.all<MessageRow>(
    `SELECT * FROM messages WHERE source = 'sms' AND delivery = 'sent' AND provider_message_id IS NOT NULL AND created_at <= ? AND created_at >= ? ORDER BY created_at LIMIT ?`,
    addMinutes(now, -(opts.minAgeMinutes ?? 2)).toISOString(),
    addMinutes(now, -60 * (opts.maxAgeHours ?? 72)).toISOString(),
    opts.limit ?? 50,
  );
  let changed = 0;
  for (const m of rows) {
    try {
      const sms = (await ctx.providers.sms(m.workspace_id)).provider;
      if (!sms.fetchStatus) continue;
      const s = await sms.fetchStatus(m.provider_message_id!);
      if (s.state === "delivered" || s.state === "failed") {
        if ((await applyDelivery(ctx, m, s.state, s.error)) === "updated") changed++;
      }
    } catch (e) {
      ctx.log.warn("delivery reconciliation failed", { message_id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return changed;
}

/** One scheduler pass; exposed so tests (and a manual `kick`) can drive time explicitly. */
export async function tick(ctx: AppContext, parts: { snooze?: boolean; jobs?: boolean; digest?: boolean; reconcile?: boolean; tickets?: boolean } = { snooze: true, jobs: true }) {
  const out = { woken: 0, jobs: 0, digests: 0, reconciled: 0, tickets: { resolved: 0, closed: 0, escalated: 0, resolution_breaches: 0, assigned: 0 } };
  if (parts.snooze) out.woken = await wakeDueRooms(ctx, notifySnoozeEnded.bind(null, ctx));
  if (parts.digest) out.digests = (await collectDigests(ctx)).queued;
  if (parts.jobs) out.jobs = (await runDueJobs(ctx, jobHandlers)).ran;
  if (parts.reconcile) out.reconciled = await reconcileDeliveries(ctx);
  if (parts.tickets) {
    const idle = await ticketSweep(ctx);
    const sla = await slaSweep(ctx);
    // anyone who became free (or a shift that started) since the last pass takes from the queues, oldest ticket first
    const workspaces = await ctx.db.all<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM tickets WHERE status = 'waiting_for_human' AND handler IS NULL LIMIT 200");
    let assigned = 0;
    for (const w of workspaces) assigned += await drainQueue(ctx, w.workspace_id);
    out.tickets = { ...idle, ...sla, assigned };
  }
  return out;
}

/**
 * Starts background processing. Job execution is the queue's business (BullMQ workers when Redis is configured, otherwise this
 * process polls the jobs table). The periodic sweep - safety-net snooze wake, digests, delivery reconciliation - runs under a
 * distributed lock so a cluster performs it once per interval, not once per node.
 */
export async function startScheduler(ctx: AppContext): Promise<() => void> {
  await ctx.queue.start(jobHandlers);
  let busy = false;
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
  const pull = setInterval(guard(async () => (ctx.queue.kind === "db" ? await runDueJobs(ctx, jobHandlers) : undefined)), 5_000);
  const sweep = setInterval(
    guard(async () => {
      await ctx.locks.withLock("scheduler-sweep", 50_000, () => tick(ctx, { snooze: true, digest: true, reconcile: true, tickets: true }));
    }),
    60_000,
  );
  // daily housekeeping: partitions for the coming months, retention/archival, expired idempotency keys
  const daily = setInterval(
    guard(async () => {
      await ctx.locks.withLock("scheduler-daily", 3_600_000, async () => {
        await ensureMessagePartitions(ctx.db, ctx.config.MESSAGE_PARTITION_MONTHS_AHEAD);
        await retentionSweep(ctx);
        await teamRetentionSweep(ctx);
      });
    }),
    6 * 3600_000,
  );
  pull.unref();
  sweep.unref();
  daily.unref();
  return () => {
    clearInterval(pull);
    clearInterval(sweep);
    clearInterval(daily);
  };
}
