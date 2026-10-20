import type { AppContext } from "../src/context.js";
import { newId } from "../src/util/ids.js";

/** A bare workspace row for benchmarks that need a workspace id but no members. */
export async function seedWorkspaceRaw(ctx: AppContext): Promise<string> {
  const id = newId("ws");
  await ctx.db.run("INSERT INTO workspaces(id, name, settings, created_at) VALUES (?,?,?,?)", id, "Bench", "{}", new Date().toISOString());
  return id;
}
