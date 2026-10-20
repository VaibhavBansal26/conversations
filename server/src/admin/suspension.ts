import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";

interface Gate {
  suspended: boolean;
  region: string | null;
}

/** Cached (and invalidated on every node by suspend/unsuspend/region changes) because every authenticated request and every socket event asks. */
const gate = (ctx: AppContext, workspaceId: string): Promise<Gate> =>
  ctx.cache.wrap(`suspended:${workspaceId}`, async () => {
    const w = await ctx.db.get<{ suspended_at: string | null; home_region: string | null }>("SELECT suspended_at, home_region FROM workspaces WHERE id = ?", workspaceId);
    return { suspended: !!w?.suspended_at, region: w?.home_region ?? null };
  });

export const workspaceSuspended = async (ctx: AppContext, workspaceId: string): Promise<boolean> => (await gate(ctx, workspaceId)).suspended;

/** Suspended workspaces and workspaces homed in another region are refused at every entry point. */
export async function assertWorkspaceActive(ctx: AppContext, workspaceId: string): Promise<void> {
  const g = await gate(ctx, workspaceId);
  if (g.suspended) throw new AppError(403, "WORKSPACE_SUSPENDED", "This workspace has been suspended. Contact support.");
  if (ctx.config.REGION && g.region && g.region !== ctx.config.REGION) throw new AppError(421, "WRONG_REGION", "This workspace lives in another region", { region: g.region });
}
