import { describe, expect, it } from "vitest";
import { enqueueJob, runDueJobs } from "../src/jobs/queue.js";
import { makeCtx, mkRoom, seedWorkspace, addSmsNumberRaw } from "./helpers.js";
import { sendAgentMessage } from "../src/services/messages.js";

describe("fair scheduling across tenants", () => {
  it("a tenant with a huge backlog cannot starve a small tenant: each pass takes a bounded share per workspace, interleaved", async () => {
    const ctx = await makeCtx();
    const order: string[] = [];
    const handlers = { t: async (_c: unknown, p: { w: string }) => void order.push(p.w) };
    for (let i = 0; i < 200; i++) await enqueueJob(ctx, "t", { w: "big" }, { workspaceId: "ws_big", dedupeKey: `b${i}` });
    for (let i = 0; i < 3; i++) await enqueueJob(ctx, "t", { w: "small" }, { workspaceId: "ws_small", dedupeKey: `s${i}` });
    await runDueJobs(ctx, handlers as never, 20, 5);
    expect(order.filter((w) => w === "small")).toHaveLength(3); // all of the small tenant's jobs in the first pass
    expect(order.filter((w) => w === "big")).toHaveLength(5); // the big one got its quantum
    expect(order.slice(0, 4)).toEqual(expect.arrayContaining(["big", "small"])); // interleaved, not big-first
  });

  it("per-tenant backpressure: a workspace over its send backlog gets 429, another workspace still sends", async () => {
    const ctx = await makeCtx({ SEND_QUEUE_WORKSPACE_MAX: "3" });
    const a = await seedWorkspace(ctx, "A");
    const b = await seedWorkspace(ctx, "B");
    await addSmsNumberRaw(ctx, a.wsId, "+14155550100", true);
    await addSmsNumberRaw(ctx, b.wsId, "+14155550101", true);
    for (let i = 0; i < 3; i++) await enqueueJob(ctx, "t", {}, { workspaceId: a.wsId, dedupeKey: `a${i}` });
    const ra = await mkRoom(ctx, a.wsId, { contact: { name: "X", phone: "+14155550201" } });
    await expect(sendAgentMessage(ctx, a.owner, ra.room.id, { kind: "text", source: "sms", content: "hi" })).rejects.toMatchObject({ status: 429 });
    const rb = await mkRoom(ctx, b.wsId, { contact: { name: "Y", phone: "+14155550202" } });
    const ok = await sendAgentMessage(ctx, b.owner, rb.room.id, { kind: "text", source: "sms", content: "hi" });
    expect(ok.message.delivery).toBe("sent");
  });

  it("retry delays are jittered in production mode and exact when jitter is off", async () => {
    const { retryDelaySeconds } = await import("../src/services/delivery.js");
    const on = await makeCtx({ SEND_RETRY_JITTER: "true", SEND_RETRY_BASE_SECONDS: "100", SEND_RETRY_CAP_SECONDS: "1000" });
    const seen = new Set(Array.from({ length: 30 }, () => retryDelaySeconds(on, 1)));
    expect(seen.size).toBeGreaterThan(5);
    for (const v of seen) expect(v).toBeGreaterThanOrEqual(80), expect(v).toBeLessThanOrEqual(120);
    const off = await makeCtx({ SEND_RETRY_BASE_SECONDS: "100", SEND_RETRY_CAP_SECONDS: "1000" });
    expect(retryDelaySeconds(off, 2)).toBe(200);
  });
});
