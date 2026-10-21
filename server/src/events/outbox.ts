import { nowIso, type AppContext } from "../context.js";
import type { BusEvent, EventBus, Subscription } from "../infra/eventbus.js";
import { newEventId } from "../infra/eventbus.js";

export const TOPIC_MESSAGES = "message.events";

export interface MessageEvent {
  type: "message.created";
  workspace_id: string;
  room_id: string;
  message_id: string;
  seq: number;
  sender_type: string;
  kind: string;
  source: string;
  /** additive: the ticket the message belongs to (null before tickets existed or outside an issue) */
  ticket_id?: string | null;
  created_at: string;
}

/**
 * Write a domain event in the CALLER'S transaction. Call it from inside `ctx.db.tx` so the event commits or rolls back with the change.
 * `key` is the ordering key: events with the same key reach consumers in order.
 */
export async function writeOutbox(ctx: AppContext, topic: string, key: string, payload: unknown): Promise<void> {
  await ctx.db.run("INSERT INTO outbox_events(id, topic, key, payload, created_at) VALUES (?,?,?,?,?)", newEventId(), topic, key, JSON.stringify(payload), nowIso(ctx));
}

/**
 * Publish unpublished outbox rows to the bus, oldest first, then mark them. Crash between publish and mark means the rows are published
 * again next pass (at-least-once): consumers dedupe on the event id. A bus failure leaves the rows untouched for the next pass.
 * Exactly one relay should publish at a time, which `startOutbox` guarantees with a distributed lock; calling this directly is for tests.
 */
export async function relayOutbox(ctx: AppContext, bus: EventBus = ctx.eventBus, batch = 500): Promise<number> {
  const rows = await ctx.db.all<{ ord: number; id: string; topic: string; key: string; payload: string }>(
    "SELECT ord, id, topic, key, payload FROM outbox_events WHERE published_at IS NULL ORDER BY ord LIMIT ?",
    batch,
  );
  if (!rows.length) return 0;
  // commands are issued in order on one connection, so per-key order is preserved even though we do not wait for each reply
  await Promise.all(rows.map((r) => bus.publish(r.topic, r.key, JSON.parse(r.payload), r.id)));
  await ctx.db.run(`UPDATE outbox_events SET published_at = ? WHERE ord IN (${rows.map(() => "?").join(",")})`, nowIso(ctx), ...rows.map((r) => r.ord));
  return rows.length;
}

/** Published rows are only kept for debugging; delete them after `hours`. */
export async function pruneOutbox(ctx: AppContext, hours = 24): Promise<number> {
  const cutoff = new Date(ctx.clock().getTime() - hours * 3600_000).toISOString();
  return (await ctx.db.run("DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < ?", cutoff)).changes;
}

export async function outboxLag(ctx: AppContext): Promise<{ unpublished: number; oldestAgeMs: number }> {
  const r = await ctx.db.get<{ n: number; oldest: string | null }>("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox_events WHERE published_at IS NULL");
  return { unpublished: Number(r?.n ?? 0), oldestAgeMs: r?.oldest ? ctx.clock().getTime() - Date.parse(r.oldest) : 0 };
}

/** Run `fn` once per (consumer, event): the marker and the effect commit together, so redelivery is harmless. Returns false when it was a repeat. */
export async function once(ctx: AppContext, consumer: string, event: BusEvent, fn: () => Promise<void>): Promise<boolean> {
  return ctx.db.tx(async () => {
    const r = await ctx.db.run("INSERT OR IGNORE INTO consumed_events(consumer, event_id, consumed_at) VALUES (?,?,?)", consumer, event.id, nowIso(ctx));
    if (!r.changes) return false;
    await fn();
    return true;
  });
}

/** Rollup consumer: counts messages per workspace/day/channel/direction. A real consumer that Phase 3 analytics reads. */
export async function rollupHandler(ctx: AppContext, event: BusEvent): Promise<void> {
  const e = event.payload as MessageEvent;
  if (e.type !== "message.created" || e.sender_type === "system" || e.sender_type === "bot" || e.kind === "note") return;
  const direction = e.sender_type === "contact" ? "in" : "out";
  await once(ctx, "rollup", event, async () => {
    await ctx.db.run(
      `INSERT INTO rollup_messages_daily(workspace_id, day, channel, direction, messages) VALUES (?,?,?,?,1)
       ON CONFLICT(workspace_id, day, channel, direction) DO UPDATE SET messages = rollup_messages_daily.messages + 1`,
      e.workspace_id,
      e.created_at.slice(0, 10),
      e.source,
      direction,
    );
  });
}

export interface OutboxRuntime {
  stop(): Promise<void>;
}

/**
 * Start the relay (leader-elected with a distributed lock, so every node can run it) and the built-in consumers. The relay polls every
 * `pollMs`; with the lock held it drains until the outbox is empty.
 */
export async function startOutbox(ctx: AppContext, pollMs = 200): Promise<OutboxRuntime> {
  const subs: Subscription[] = [];
  subs.push(await ctx.eventBus.subscribe({ group: "rollup", topics: [TOPIC_MESSAGES], handler: (e) => rollupHandler(ctx, e) }));
  let running = false;
  let stopped = false;
  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await ctx.locks.withLock("outbox-relay", 10_000, async () => {
        for (let i = 0; i < 20 && !stopped; i++) if ((await relayOutbox(ctx)) === 0) break;
      });
    } catch (e) {
      ctx.log.warn("outbox relay pass failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void pass(), pollMs);
  timer.unref();
  const prune = setInterval(() => void pruneOutbox(ctx).catch(() => {}), 3600_000);
  prune.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(prune);
      await Promise.allSettled(subs.map((s) => s.close()));
    },
  };
}
