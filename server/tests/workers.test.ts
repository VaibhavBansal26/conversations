import { afterEach, describe, expect, it } from "vitest";
import { handleInboundEmail } from "../src/services/inbound.js";
import { sendAgentMessage } from "../src/services/messages.js";
import { taskImpl } from "../src/workers/tasks.js";
import { WorkerPool } from "../src/workers/pool.js";
import { addInboundAddressRaw, addSenderRaw, fullApp, messagesOf, mkRoom } from "./helpers.js";

const para = '<p onclick="x()">Hello <b>there</b> <script>alert(1)</script><a href="javascript:alert(1)">bad</a> <a href="https://ok.test">ok</a></p>\n';
const pools: WorkerPool[] = [];
const pool = (n: number, opts?: ConstructorParameters<typeof WorkerPool>[1]) => {
  const p = new WorkerPool(n, opts);
  pools.push(p);
  return p;
};
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});

describe("worker pool", () => {
  it("returns exactly what inline execution returns, for small and large inputs", async () => {
    const p = pool(2);
    for (const reps of [1, 50, 3000]) {
      const html = para.repeat(reps);
      expect(await p.run("sanitizeEmail", { html })).toEqual(taskImpl.sanitizeEmail({ html }));
    }
    expect(p.stats().completed).toBeGreaterThanOrEqual(3);
  });
  it("runs inline when disabled (size 0)", async () => {
    const p = pool(0);
    expect(await p.run("sanitizeEmail", { html: para })).toEqual(taskImpl.sanitizeEmail({ html: para }));
    expect(p.stats().completed).toBe(0);
  });
  it("handles many concurrent tasks and keeps results paired with their inputs", async () => {
    const p = pool(3);
    const inputs = Array.from({ length: 60 }, (_, i) => `<p>message ${i} <script>x</script></p>`);
    const out = await Promise.all(inputs.map((html) => p.run("sanitizeEmail", { html })));
    out.forEach((o, i) => expect(o.text).toBe(`message ${i}`));
  });
  it("falls back to inline when saturated (bounded in-flight work per worker)", async () => {
    const p = pool(1, { maxInFlightPerWorker: 1 });
    const big = para.repeat(4000);
    const results = await Promise.all([p.run("sanitizeEmail", { html: big }), p.run("sanitizeEmail", { html: big }), p.run("sanitizeEmail", { html: big })]);
    expect(new Set(results.map((r) => r.text.length)).size).toBe(1);
    expect(p.stats().completed).toBeLessThan(3); // the overflow ran inline
  });
  it("replaces a crashed worker and keeps serving", async () => {
    const p = pool(1);
    await p.run("sanitizeEmail", { html: "<p>warm</p>" });
    await (p as unknown as { slots: { worker: { terminate(): Promise<number> } }[] }).slots[0]!.worker.terminate();
    await new Promise((r) => setTimeout(r, 300));
    expect(p.stats().restarts).toBe(1);
    expect((await p.run("sanitizeEmail", { html: "<p>again</p>" })).text).toBe("again");
  });
  it("times out a stuck task, restarts the worker and still returns the right answer inline", async () => {
    const p = pool(1, { timeoutMs: 1 });
    const html = para.repeat(6000);
    expect(await p.run("sanitizeEmail", { html })).toEqual(taskImpl.sanitizeEmail({ html }));
    await new Promise((r) => setTimeout(r, 400));
    expect(p.stats().restarts).toBeGreaterThanOrEqual(1);
  });
});

describe("worker pool integration", () => {
  it("sanitises large inbound email bodies on a worker thread with the same result as inline", async () => {
    const f = await fullApp({ WORKER_THRESHOLD_BYTES: "1000" });
    await addInboundAddressRaw(f.ctx, f.wsId, "inbound@parse.acme.test");
    const html = para.repeat(40);
    const mail = (id: string) => ({ from: "Pat <pat@example.test>", to: "inbound@parse.acme.test", subject: "big", html, headers: `Message-ID: <${id}@x>` });
    const inline = await handleInboundEmail(f.ctx, mail("a"));
    const p = pool(2);
    f.ctx.workers = p;
    const threaded = await handleInboundEmail(f.ctx, mail("b"));
    expect(p.stats().completed).toBe(1);
    const rows = (await messagesOf(f.ctx, inline.room_id!)).filter((m) => m.source === "email");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.content).toBe(rows[0]!.content);
    expect(rows[1]!.content_text).toBe(rows[0]!.content_text);
    expect(rows[1]!.content).not.toMatch(/script|onclick|javascript:/);
    expect(threaded.status).toBe("processed");
  });
  it("sanitises large agent-authored HTML the same way", async () => {
    const f = await fullApp({ WORKER_THRESHOLD_BYTES: "1000" });
    await addSenderRaw(f.ctx, f.wsId, "support@acme.test", true, true);
    const { room } = await mkRoom(f.ctx, f.wsId, { contact: { email: "c@example.test" } });
    f.ctx.workers = pool(1);
    const r = await sendAgentMessage(f.ctx, f.owner, room.id, { kind: "text", source: "email", content: para.repeat(20), format: "html" });
    expect(f.ctx.workers.stats().completed).toBe(1);
    expect(r.message.content).not.toMatch(/script|onclick/);
    expect(r.message.content_text).toContain("Hello there");
  });
  it("small bodies never touch the pool", async () => {
    const f = await fullApp();
    await addSenderRaw(f.ctx, f.wsId, "support@acme.test", true, true);
    const { room } = await mkRoom(f.ctx, f.wsId, { contact: { email: "c@example.test" } });
    f.ctx.workers = pool(1);
    await sendAgentMessage(f.ctx, f.owner, room.id, { kind: "text", source: "email", content: para, format: "html" });
    expect(f.ctx.workers.stats().completed).toBe(0);
  });
});
