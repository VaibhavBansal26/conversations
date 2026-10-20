import { describe, expect, it } from "vitest";
import { archiveMessages, purgeWorkspaceMessages, restoreArchive, retentionSweep } from "../src/services/archive.js";
import { detachOldMessagePartitions, restoreMessagePartition } from "../src/db/partitions.js";
import { agentSays, makeCtx, mkRoom, seedWorkspace, setSettings } from "./helpers.js";

async function world(n = 12) {
  const ctx = await makeCtx();
  const { wsId, owner } = await seedWorkspace(ctx);
  const { room } = await mkRoom(ctx, wsId);
  ctx.clockCtl.set("2025-01-10T10:00:00.000Z");
  for (let i = 0; i < n; i++) await agentSays(ctx, owner, room.id, `old ${i}`);
  ctx.clockCtl.set("2026-03-02T10:00:00.000Z");
  await agentSays(ctx, owner, room.id, "recent");
  return { ctx, wsId, owner, room };
}
const count = async (ctx: any, wsId: string) => Number((await ctx.db.get("SELECT COUNT(*) n FROM messages WHERE workspace_id = ?", wsId)).n);

describe("tiering, retention and erasure", () => {
  it("archives old messages to storage, verifies, deletes them, and restores them idempotently", async () => {
    const { ctx, wsId, room } = await world();
    const before = await count(ctx, wsId);
    const r = await archiveMessages(ctx, wsId, new Date("2025-06-01T00:00:00Z"), { batch: 5 });
    expect(r.rows).toBeGreaterThanOrEqual(12);
    expect(r.archives).toBeGreaterThanOrEqual(3); // batched
    expect(await count(ctx, wsId)).toBe(before - r.rows);
    expect(Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE content_text = 'recent'"))!.n)).toBe(1); // newer data untouched
    const manifests = await ctx.db.all<{ id: string }>("SELECT id FROM archive_manifest WHERE workspace_id = ?", wsId);
    let restored = 0;
    for (const m of manifests) restored += (await restoreArchive(ctx, m.id)).restored;
    expect(restored).toBe(r.rows);
    expect(await count(ctx, wsId)).toBe(before);
    for (const m of manifests) expect((await restoreArchive(ctx, m.id)).restored).toBe(0); // second restore is a no-op
    const seqs = (await ctx.db.all<{ seq: number }>("SELECT seq FROM messages WHERE room_id = ? ORDER BY seq", room.id)).map((x) => x.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("refuses to delete when the stored archive does not read back identically", async () => {
    const { ctx, wsId } = await world(4);
    const real = ctx.storage.read.bind(ctx.storage);
    ctx.storage.read = async (k: string) => {
      const b = await real(k);
      return b ? Buffer.concat([b, Buffer.from([0])]) : b;
    };
    const before = await count(ctx, wsId);
    await expect(archiveMessages(ctx, wsId, new Date("2025-06-01T00:00:00Z"))).rejects.toThrow(/verification failed/);
    expect(await count(ctx, wsId)).toBe(before);
  });

  it("a corrupted archive is rejected on restore", async () => {
    const { ctx, wsId } = await world(3);
    await archiveMessages(ctx, wsId, new Date("2025-06-01T00:00:00Z"));
    const m = (await ctx.db.get<{ id: string }>("SELECT id FROM archive_manifest"))!;
    await ctx.db.run("UPDATE archive_manifest SET sha256 = 'deadbeef' WHERE id = ?", m.id);
    await expect(restoreArchive(ctx, m.id)).rejects.toThrow(/checksum/);
  });

  it("per-tenant retention: only workspaces with retention_days are swept, others keep everything", async () => {
    const a = await world(5);
    const other = await seedWorkspace(a.ctx, "Keeper");
    const { room: r2 } = await mkRoom(a.ctx, other.wsId);
    a.ctx.clockCtl.set("2025-01-10T10:00:00.000Z");
    await agentSays(a.ctx, other.owner, r2.id, "ancient");
    a.ctx.clockCtl.set("2026-03-02T10:00:00.000Z");
    await setSettings(a.ctx, a.wsId, { retention_days: 90 });
    const swept = await retentionSweep(a.ctx);
    expect(swept[a.wsId]).toBeGreaterThan(0);
    expect(swept[other.wsId]).toBeUndefined();
    expect(await count(a.ctx, other.wsId)).toBeGreaterThan(0);
  });

  it("GDPR erasure removes every message of a tenant in batches and leaves other tenants alone", async () => {
    const a = await world(10);
    const other = await seedWorkspace(a.ctx, "Other");
    const { room: r2 } = await mkRoom(a.ctx, other.wsId);
    await agentSays(a.ctx, other.owner, r2.id, "mine");
    const n = await purgeWorkspaceMessages(a.ctx, a.wsId, 4);
    expect(n).toBeGreaterThanOrEqual(11);
    expect(await count(a.ctx, a.wsId)).toBe(0);
    expect(await count(a.ctx, other.wsId)).toBeGreaterThan(0);
  });

  it.skipIf(process.env.TEST_DB !== "postgres")("old monthly partitions detach in O(1) and re-attach", async () => {
    const { ctx, wsId } = await world(3);
    const before = await count(ctx, wsId);
    await ctx.db.exec("SELECT conv_ensure_message_partitions('2025-01-01'::date, '2025-01-01'::date)");
    const detached = await detachOldMessagePartitions(ctx.db, 6);
    expect(detached.length).toBeGreaterThan(0);
    expect(await count(ctx, wsId)).toBeLessThan(before); // the 2025 rows left with their partitions
    for (const d of detached) await restoreMessagePartition(ctx.db, d);
    expect(await count(ctx, wsId)).toBe(before);
  });
});
