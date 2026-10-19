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

export function getWorkspace(ctx: AppContext, id: string): WorkspaceRow {
  const row = ctx.db.get<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id);
  if (!row) throw notFound("Workspace");
  return row;
}

export const getSettings = (ctx: AppContext, id: string): WorkspaceSettings => parseSettings(getWorkspace(ctx, id).settings);

export function workspaceDto(ctx: AppContext, id: string) {
  const w = getWorkspace(ctx, id);
  return { id: w.id, name: w.name, created_at: w.created_at, settings: parseSettings(w.settings), credit_balance: w.credit_balance };
}

export function updateWorkspace(ctx: AppContext, id: string, patch: { name?: string; settings?: z.infer<typeof WorkspaceSettingsPatchSchema> }) {
  const w = getWorkspace(ctx, id);
  const next = patch.settings ? mergeSettings(parseSettings(w.settings), patch.settings) : parseSettings(w.settings);
  ctx.db.run("UPDATE workspaces SET name = ?, settings = ? WHERE id = ?", patch.name ?? w.name, JSON.stringify(next), id);
  return workspaceDto(ctx, id);
}

/** Cost of one outbound send, in credits. */
export const creditCost = (ctx: AppContext, kind: "sms" | "email"): number =>
  kind === "sms" ? ctx.config.CREDIT_COST_SMS : ctx.config.CREDIT_COST_EMAIL;

/** Throws 402 when credits are enforced and the balance cannot cover the send. */
export function verifyBalance(ctx: AppContext, workspaceId: string, kind: "sms" | "email"): void {
  const w = getWorkspace(ctx, workspaceId);
  if (!parseSettings(w.settings).credits_enforced) return;
  if (w.credit_balance < creditCost(ctx, kind)) {
    throw paymentRequired("INSUFFICIENT_CREDITS", `Not enough credits to send ${kind === "sms" ? "an SMS" : "an email"}`);
  }
}

/** Append a ledger entry and move the balance in one statement pair. delta is negative for usage. */
export function recordUsage(ctx: AppContext, workspaceId: string, kind: string, delta: number, ref?: string): number {
  return ctx.db.tx(() => {
    ctx.db.run("UPDATE workspaces SET credit_balance = credit_balance + ? WHERE id = ?", delta, workspaceId);
    const bal = ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", workspaceId)!.credit_balance;
    ctx.db.run(
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
  ctx.db.all("SELECT id, kind, delta, balance_after, ref, created_at FROM usage_ledger WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", workspaceId, limit);
