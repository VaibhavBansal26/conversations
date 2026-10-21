import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seed } from "../src/seed.js";
import { loadConfig } from "../src/config.js";
import { closeContext, createContext } from "../src/app-context.js";

async function seeded(extra: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "seed-ai-"));
  const env = { NODE_ENV: "test", JWT_SECRET: "seed-test-secret-seed-test-secret", DATABASE_PATH: join(dir, "s.db"), DATA_DIR: dir, ...extra };
  const log = console.log;
  console.log = () => {};
  try {
    await seed(env);
  } finally {
    console.log = log;
  }
  const ctx = await createContext(loadConfig(env));
  return { ctx, done: async () => (await closeContext(ctx), rmSync(dir, { recursive: true, force: true })) };
}

describe("demo seed", () => {
  it("SEED_AI=1 sets up three departments, a switched-on AI agent, knowledge entries with links and calls", async () => {
    if (process.env.TEST_DB === "postgres") return; // the seed uses its own SQLite file
    const s = await seeded({ SEED_AI: "1" });
    try {
      const names = (await s.ctx.db.all<{ name: string }>("SELECT name FROM inboxes ORDER BY name")).map((i) => i.name);
      expect(names).toEqual(["Billing", "Sales", "Support"]);
      expect(await s.ctx.db.get("SELECT name, enabled FROM ai_agents")).toMatchObject({ name: "Aria", enabled: 1 });
      expect((await s.ctx.db.all("SELECT 1 FROM kb_entries WHERE url IS NOT NULL")).length).toBeGreaterThanOrEqual(4);
      const settings = JSON.parse((await s.ctx.db.get<{ settings: string }>("SELECT settings FROM workspaces"))!.settings);
      expect(settings.calls.browser.enabled).toBe(true);
      expect(settings.widget.visitor_info.fields.email).toBe("ask_when_needed");
    } finally {
      await s.done();
    }
  });

  it("the plain demo has no AI agent and no new departments (the browser tests rely on that)", async () => {
    if (process.env.TEST_DB === "postgres") return;
    const s = await seeded({});
    try {
      expect(await s.ctx.db.all("SELECT 1 FROM ai_agents")).toHaveLength(0);
      expect((await s.ctx.db.all<{ name: string }>("SELECT name FROM inboxes ORDER BY name")).map((i) => i.name)).toEqual(["Sales", "Support"]);
    } finally {
      await s.done();
    }
  });
});
