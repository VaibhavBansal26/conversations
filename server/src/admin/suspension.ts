import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";

/** Cached (and invalidated on every node by suspend/unsuspend) because every authenticated request and every socket event asks. */
export const workspaceSuspended = (ctx: AppContext, workspaceId: string): Promise<boolean> =>
  ctx.cache.wrap(`suspended:${workspaceId}`, async () => !!(await ctx.db.get("SELECT 1 FROM workspaces WHERE id = ? AND suspended_at IS NOT NULL", workspaceId)));

export async function assertWorkspaceActive(ctx: AppContext, workspaceId: string): Promise<void> {
  if (await workspaceSuspended(ctx, workspaceId)) throw new AppError(403, "WORKSPACE_SUSPENDED", "This workspace has been suspended. Contact support.");
}
