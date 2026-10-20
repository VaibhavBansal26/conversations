import { describe, expect, it } from "vitest";
import { ensureMessagePartitions, listMessagePartitions } from "../src/db/partitions.js";
import { agentSays, makeCtx, mkRoom, seedWorkspace } from "./helpers.js";

const pg = process.env.TEST_DB === "postgres";

describe.skipIf(!pg)("messages partitioning (PostgreSQL)", () => {
  it("is hash(room_id) -> monthly range, and a room-scoped query prunes to a single hash partition", async () => {
    const ctx = await makeCtx({ MESSAGE_HASH_PARTITIONS: "4" });
    const parts = await listMessagePartitions(ctx.db);
    expect(new Set(parts.map((p) => p.parent)).size).toBe(4);
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    await agentSays(ctx, owner, room.id, "hello");
    const plan = (await ctx.db.explain("SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 30", room.id)) as string;
    const touched = new Set([...plan.matchAll(/on (messages_h\d)(?:_\w+)?/g)].map((m) => m[1]));
    expect(touched.size).toBe(1); // partition pruning: one of the four hash partitions
  });

  it("ensureMessagePartitions is idempotent and creates future months", async () => {
    const ctx = await makeCtx({ MESSAGE_HASH_PARTITIONS: "2", MESSAGE_PARTITION_MONTHS_AHEAD: "0" });
    const first = await ensureMessagePartitions(ctx.db, 8, 0);
    expect(first).toBeGreaterThan(0);
    expect(await ensureMessagePartitions(ctx.db, 8, 0)).toBe(0);
  });

  it("rows that landed in the DEFAULT partition move into a month when it is created later", async () => {
    const ctx = await makeCtx({ MESSAGE_HASH_PARTITIONS: "2", MESSAGE_PARTITION_MONTHS_AHEAD: "0" });
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    ctx.clockCtl.set("2031-05-10T10:00:00.000Z"); // far outside the pre-created months
    await agentSays(ctx, owner, room.id, "from the future");
    const inDefault = async () => Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM messages_h0_default UNION ALL SELECT 0 LIMIT 1")) ? 1 : 0);
    void inDefault;
    const count = async (rel: string) => Number((await ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${rel} WHERE created_at >= '2031-05-01' AND created_at < '2031-06-01'`))!.n);
    const before = (await count("messages_h0_default")) + (await count("messages_h1_default"));
    expect(before).toBeGreaterThan(0);
    await ctx.db.exec("SELECT conv_ensure_message_partitions('2031-05-01'::date, '2031-05-01'::date)");
    expect((await count("messages_h0_default")) + (await count("messages_h1_default"))).toBe(0);
    expect((await count("messages_h0_203105")) + (await count("messages_h1_203105"))).toBe(before);
    const all = await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE room_id = ? AND content_text = 'from the future'", room.id);
    expect(Number(all!.n)).toBe(1);
  });
});
