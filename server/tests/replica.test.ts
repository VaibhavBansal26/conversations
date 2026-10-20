import { describe, expect, it } from "vitest";
import { agentSays, isolatedDbEnv, makeCtx, mkRoom, seedWorkspace, trackCtx } from "./helpers.js";
import { listRooms } from "../src/services/rooms.js";

const pg = process.env.TEST_DB === "postgres";

async function withReplica(env: Record<string, string> = {}) {
  const iso = await isolatedDbEnv({});
  const ctx = await makeCtx({ ...iso.env, DATABASE_REPLICA_URL: iso.env.DATABASE_URL!, ...env });
  trackCtx(ctx, iso.schema);
  return ctx;
}
const stats = (ctx: any) => ctx.db.reads as { replica: number; primary: number };

describe.skipIf(!pg)("read replica routing", () => {
  it("serves history reads from the replica once the node has not written recently, and lists still work", async () => {
    const ctx = await withReplica({ DATABASE_READ_AFTER_WRITE_MS: "0" });
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    await agentSays(ctx, owner, room.id, "hello");
    await new Promise((r) => setTimeout(r, 30));
    const before = stats(ctx).replica;
    const page = await listRooms(ctx, owner, { status: "open", sort: "newest", page: 1, limit: 10 });
    expect(page.data.length).toBeGreaterThan(0);
    expect(stats(ctx).replica).toBeGreaterThan(before);
  });

  it("read-your-writes: right after this node writes, reads stay on the primary", async () => {
    const ctx = await withReplica({ DATABASE_READ_AFTER_WRITE_MS: "400" });
    const { wsId, owner } = await seedWorkspace(ctx);
    const { room } = await mkRoom(ctx, wsId);
    await agentSays(ctx, owner, room.id, "fresh");
    const r0 = stats(ctx).replica;
    await listRooms(ctx, owner, { status: "open", sort: "newest", page: 1, limit: 10 });
    expect(stats(ctx).replica).toBe(r0); // primary
    await new Promise((r) => setTimeout(r, 450));
    await listRooms(ctx, owner, { status: "open", sort: "newest", page: 1, limit: 10 });
    expect(stats(ctx).replica).toBeGreaterThan(r0);
  });

  it("inside a transaction and while the replica lags, reads use the primary; the replica view refuses writes", async () => {
    const ctx = await withReplica({ DATABASE_READ_AFTER_WRITE_MS: "0", DATABASE_REPLICA_MAX_LAG_MS: "1" });
    await seedWorkspace(ctx);
    await new Promise((r) => setTimeout(r, 30));
    const view = ctx.db.read();
    await expect(view.run("UPDATE workspaces SET name = name")).rejects.toThrow(/read-only/);
    const r0 = stats(ctx).replica;
    await ctx.db.tx(async () => {
      ctx.db.read();
      await ctx.db.get("SELECT 1");
    });
    expect(stats(ctx).replica).toBe(r0);
  });

  it("an unreachable replica falls back to the primary instead of failing the request", async () => {
    const iso = await isolatedDbEnv({});
    const bad = new URL(iso.env.DATABASE_URL!);
    bad.port = "1";
    const ctx = await makeCtx({ ...iso.env, DATABASE_REPLICA_URL: bad.toString(), DATABASE_READ_AFTER_WRITE_MS: "0" });
    trackCtx(ctx, iso.schema);
    const { owner } = await seedWorkspace(ctx);
    await new Promise((r) => setTimeout(r, 50));
    const page = await listRooms(ctx, owner, { status: "open", sort: "newest", page: 1, limit: 10 });
    expect(Array.isArray(page.data)).toBe(true);
  });
});

describe.skipIf(!pg)("PgBouncer-compatible mode", () => {
  it("never creates named prepared statements, however often a statement repeats", async () => {
    const iso = await isolatedDbEnv({});
    const ctx = await makeCtx({ ...iso.env, DATABASE_PGBOUNCER: "true" });
    trackCtx(ctx, iso.schema);
    const n = await ctx.db.tx(async () => {
      for (let i = 0; i < 30; i++) await ctx.db.get("SELECT ? AS x", i);
      return Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pg_prepared_statements"))!.n);
    });
    expect(n).toBe(0);
  });
  it("default mode does prepare repeated statements (so the flag is what changes behaviour)", async () => {
    const ctx = await makeCtx();
    const n = await ctx.db.tx(async () => {
      for (let i = 0; i < 30; i++) await ctx.db.get("SELECT ? AS x", i);
      return Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pg_prepared_statements"))!.n);
    });
    expect(n).toBeGreaterThan(0);
  });
});
