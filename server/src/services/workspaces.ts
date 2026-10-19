import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { mergeSettings, parseSettings, WorkspaceSettingsPatchSchema, type WorkspaceSettings } from "../domain/settings.js";
import { notFound, paymentRequired } from "../errors.js";
import { newId } from "../util/ids.js";
import type { z } from "zod";

export interface WorkspaceRow {
  id: string;
  name: string;
  settings: string;
  credit_balance: number;
  created_at: string;
}

export async function getWorkspace(ctx: AppContext, id: string): Promise<WorkspaceRow> {
  const row = await ctx.db.get<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id);
  if (!row) throw notFound("Workspace");
  return row;
}

/** Read on almost every request (office hours, region, AI flags): cached briefly, invalidated by updateWorkspace on every node. */
export const getSettings = (ctx: AppContext, id: string): Promise<WorkspaceSettings> =>
  ctx.cache.wrap(`settings:${id}`, async () => parseSettings((await getWorkspace(ctx, id)).settings));

export async function workspaceDto(ctx: AppContext, id: string) {
  const w = await getWorkspace(ctx, id);
  return { id: w.id, name: w.name, created_at: w.created_at, settings: parseSettings(w.settings), credit_balance: w.credit_balance };
}

export async function updateWorkspace(ctx: AppContext, id: string, patch: { name?: string; settings?: z.infer<typeof WorkspaceSettingsPatchSchema> }) {
  const w = await getWorkspace(ctx, id);
  const next = patch.settings ? mergeSettings(parseSettings(w.settings), patch.settings) : parseSettings(w.settings);
  await ctx.db.run("UPDATE workspaces SET name = ?, settings = ? WHERE id = ?", patch.name ?? w.name, JSON.stringify(next), id);
  await ctx.cache.invalidate(`settings:${id}`);
  return await workspaceDto(ctx, id);
}

/** Cost of one outbound send, in credits. */
export const creditCost = (ctx: AppContext, kind: "sms" | "email"): number => (kind === "sms" ? ctx.config.CREDIT_COST_SMS : ctx.config.CREDIT_COST_EMAIL);

/** Throws 402 when credits are enforced and the balance cannot cover the send. */
export async function verifyBalance(ctx: AppContext, workspaceId: string, kind: "sms" | "email"): Promise<void> {
  const w = await getWorkspace(ctx, workspaceId);
  if (!parseSettings(w.settings).credits_enforced) return;
  if (w.credit_balance < creditCost(ctx, kind)) {
    throw paymentRequired("INSUFFICIENT_CREDITS", `Not enough credits to send ${kind === "sms" ? "an SMS" : "an email"}`);
  }
}

/** Append a ledger entry and move the balance in one statement pair. delta is negative for usage. */
export async function recordUsage(ctx: AppContext, workspaceId: string, kind: string, delta: number, ref?: string): Promise<number> {
  return await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE workspaces SET credit_balance = credit_balance + ? WHERE id = ?", delta, workspaceId);
    const bal = (await ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", workspaceId))!.credit_balance;
    await ctx.db.run(
      "INSERT INTO usage_ledger(id, workspace_id, kind, delta, balance_after, ref, created_at) VALUES (?,?,?,?,?,?,?)",
      newId("led"),
      workspaceId,
      kind,
      delta,
      bal,
      ref ?? null,
      nowIso(ctx),
    );
    return bal;
  });
}

export const listLedger = (ctx: AppContext, workspaceId: string, limit = 50) =>
  ctx.db.all(
    "SELECT id, kind, delta, balance_after, ref, created_at FROM usage_ledger WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    workspaceId,
    limit,
  );
