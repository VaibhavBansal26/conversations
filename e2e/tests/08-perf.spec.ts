import { expect, test } from "@playwright/test";
import { loginApi } from "../support/api.mjs";
import { startStack } from "../support/stack.mjs";

// Own stack so thousands of rooms do not leak into the other specs.
const ROOMS = Number(process.env.E2E_PERF_ROOMS ?? 3000);
let stack: Awaited<ReturnType<typeof startStack>>;

test.describe("room list with thousands of conversations", () => {
  test.setTimeout(240_000);

  test.beforeAll(async () => {
    process.env.E2E_NO_ENRICH = "1";
    stack = await startStack();
    const api = await loginApi(stack.base);
    let done = 0;
    const worker = async () => {
      while (done < ROOMS) {
        const n = done++;
        await api.post("/rooms", { contact: { name: `Perf Contact ${String(n).padStart(4, "0")}`, email: `perf${n}@example.test` }, message: { kind: "text", source: "dm", content: `Message number ${n} about order ${10000 + n}`, client_msg_id: crypto.randomUUID() } });
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
  });
  test.afterAll(async () => {
    await stack?.stop();
    delete process.env.E2E_NO_ENRICH;
  });

  test("renders a window of rows, stays smooth while scrolling the whole list, and keeps selection reachable", async ({ page }) => {
    await page.goto(`${stack.base}/login`);
    await page.getByLabel("Email").fill("demo@example.test");
    await page.getByLabel("Password", { exact: true }).fill("demo-password-123");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    const list = page.getByRole("tabpanel");
    await expect(list.getByRole("link").first()).toBeVisible();

    // load every page by scrolling to the bottom repeatedly
    const loaded = async () => list.evaluate((el) => Math.round(el.scrollHeight / 84));
    for (let i = 0; i < 400 && (await loaded()) < ROOMS; i++) {
      await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(60);
    }
    expect(await loaded()).toBeGreaterThanOrEqual(ROOMS);

    // only a window is in the DOM
    const rendered = await list.getByRole("link").count();
    expect(rendered).toBeLessThan(60);

    // frame pacing while flinging from the bottom to the top and back
    const stats = await list.evaluate(async (el) => {
      const frames: number[] = [];
      let last = performance.now();
      let longTasks = 0;
      const po = new PerformanceObserver((l) => (longTasks += l.getEntries().length));
      try {
        po.observe({ entryTypes: ["longtask"] });
      } catch {
        /* unsupported */
      }
      const total = el.scrollHeight - el.clientHeight;
      const run = (from: number, to: number, ms: number) =>
        new Promise<void>((resolve) => {
          const t0 = performance.now();
          const tick = (now: number) => {
            frames.push(now - last);
            last = now;
            const p = Math.min(1, (now - t0) / ms);
            el.scrollTop = from + (to - from) * p;
            if (p < 1) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
      await run(total, 0, 2500);
      await run(0, total, 2500);
      po.disconnect();
      frames.shift();
      frames.sort((a, b) => a - b);
      const pick = (q: number) => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))]!;
      return { frames: frames.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: frames[frames.length - 1]!, longTasks, over32: frames.filter((f) => f > 33.4).length };
    });
    test.info().annotations.push({ type: "frame stats (ms)", description: JSON.stringify(stats) });
    console.log(`room list scroll, ${ROOMS} rooms:`, JSON.stringify(stats));
    expect(stats.p95).toBeLessThan(25);
    expect(stats.over32 / stats.frames).toBeLessThan(0.05);

    // keyboard navigation near the bottom keeps the selected row in view
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await list.getByRole("link").last().click();
    await page.keyboard.press("k");
    await expect(list.getByRole("link", { current: "true" })).toBeInViewport();
  });
});
