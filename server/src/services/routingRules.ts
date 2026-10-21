import { z } from "zod";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "./audit.js";
import type { Actor } from "../domain/types.js";

/**
 * Routing rules choose the department of a NEW conversation from what is known about it: the page the visitor is on, their language, the
 * channel, the contact's tags and attributes. The first enabled rule (by position) whose conditions all hold wins. Matching is plain
 * case-insensitive text comparison (no regular expressions: nothing a workspace types here can make matching slow).
 */
export const RULE_FIELDS = ["page_url", "locale", "channel", "tag", "email_domain", "attr"] as const;
export const RULE_OPS = ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "exists"] as const;

export const ConditionSchema = z.object({
  field: z.enum(RULE_FIELDS),
  /** `attr` only: the contact attribute name (`plan`, or an app attribute sent through `session/attributes`) */
  key: z.string().trim().min(1).max(60).optional(),
  op: z.enum(RULE_OPS),
  value: z.string().trim().max(200).default(""),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const RuleBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  conditions: z.array(ConditionSchema).min(1).max(5),
  department_id: z.string().min(1).max(64),
});
export const RulePatchSchema = RuleBodySchema.partial().extend({ position: z.number().int().min(0).max(1000).optional() });

export interface RuleRow {
  id: string;
  workspace_id: string;
  position: number;
  name: string;
  enabled: number;
  conditions: string;
  department_id: string;
  created_at: string;
  updated_at: string;
}

export interface RoutingContext {
  page_url?: string | null;
  locale?: string | null;
  channel?: "dm" | "sms" | "email" | null;
  tags?: string[];
  email?: string | null;
  attrs?: Record<string, unknown>;
}

const MAX_RULES = 50;

export const ruleDto = (r: RuleRow) => ({
  id: r.id,
  position: r.position,
  name: r.name,
  enabled: !!r.enabled,
  conditions: parseJson<Condition[]>(r.conditions, []),
  department_id: r.department_id,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

function actual(c: Condition, x: RoutingContext): string | null {
  switch (c.field) {
    case "page_url":
      return x.page_url ?? null;
    case "locale":
      return x.locale ?? null;
    case "channel":
      return x.channel ?? null;
    case "email_domain":
      return x.email?.includes("@") ? x.email.split("@")[1]!.toLowerCase() : null;
    case "tag":
      return null; // handled below: a tag is a membership test
    case "attr": {
      const raw = x.attrs?.[c.key ?? ""] ?? (x.attrs?.app as Record<string, unknown> | undefined)?.[c.key ?? ""];
      return raw === undefined || raw === null ? null : String(raw);
    }
  }
}

export function conditionHolds(c: Condition, x: RoutingContext): boolean {
  const want = c.value.toLowerCase();
  if (c.field === "tag") {
    const has = (x.tags ?? []).some((t) => t.toLowerCase() === want);
    return c.op === "not_equals" || c.op === "not_contains" ? !has : has;
  }
  const got = actual(c, x)?.toLowerCase() ?? null;
  if (c.op === "exists") return got !== null && got !== "";
  if (got === null) return c.op === "not_equals" || c.op === "not_contains"; // an unknown value is "not" anything
  switch (c.op) {
    case "equals":
      return got === want;
    case "not_equals":
      return got !== want;
    case "contains":
      return got.includes(want);
    case "not_contains":
      return !got.includes(want);
    case "starts_with":
      return got.startsWith(want);
    case "ends_with":
      return got.endsWith(want);
  }
}

export const listRules = (ctx: AppContext, ws: string) => ctx.db.all<RuleRow>("SELECT * FROM routing_rules WHERE workspace_id = ? ORDER BY position, id", ws);

/** The first enabled rule that matches, with the reason a person can read in the test sandbox. */
export async function matchRule(ctx: AppContext, ws: string, x: RoutingContext): Promise<{ rule: RuleRow | null; trace: { rule_id: string; name: string; matched: boolean }[] }> {
  const trace: { rule_id: string; name: string; matched: boolean }[] = [];
  for (const r of await listRules(ctx, ws)) {
    if (!r.enabled) continue;
    const ok = parseJson<Condition[]>(r.conditions, []).every((c) => conditionHolds(c, x));
    trace.push({ rule_id: r.id, name: r.name, matched: ok });
    if (ok) return { rule: r, trace };
  }
  return { rule: null, trace };
}

async function assertDepartment(ctx: AppContext, ws: string, id: string) {
  if (!(await ctx.db.get("SELECT 1 FROM inboxes WHERE id = ? AND workspace_id = ?", id, ws))) throw unprocessable("UNKNOWN_DEPARTMENT", "That department does not exist");
}

function checkConditions(conds: Condition[]) {
  for (const c of conds) {
    if (c.field === "attr" && !c.key) throw unprocessable("ATTR_KEY_REQUIRED", "An attribute condition needs the attribute name");
    if (c.op !== "exists" && !c.value) throw unprocessable("VALUE_REQUIRED", "Give the value to compare with");
  }
}

export async function createRule(ctx: AppContext, actor: Actor, body: z.infer<typeof RuleBodySchema>): Promise<RuleRow> {
  await assertDepartment(ctx, actor.workspaceId, body.department_id);
  checkConditions(body.conditions);
  const rules = await listRules(ctx, actor.workspaceId);
  if (rules.length >= MAX_RULES) throw unprocessable("TOO_MANY_RULES", `At most ${MAX_RULES} routing rules`);
  const id = newId("rul");
  const now = nowIso(ctx);
  await ctx.db.run(
    "INSERT INTO routing_rules(id, workspace_id, position, name, enabled, conditions, department_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id,
    actor.workspaceId,
    (rules[rules.length - 1]?.position ?? -1) + 1,
    body.name,
    body.enabled,
    JSON.stringify(body.conditions),
    body.department_id,
    now,
    now,
  );
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "routing_rule.created", target: id, detail: { department_id: body.department_id } });
  return (await ctx.db.get<RuleRow>("SELECT * FROM routing_rules WHERE id = ?", id))!;
}

export async function updateRule(ctx: AppContext, actor: Actor, id: string, patch: z.infer<typeof RulePatchSchema>): Promise<RuleRow> {
  const cur = await ctx.db.get<RuleRow>("SELECT * FROM routing_rules WHERE id = ? AND workspace_id = ?", id, actor.workspaceId);
  if (!cur) throw notFound("Routing rule");
  if (patch.department_id) await assertDepartment(ctx, actor.workspaceId, patch.department_id);
  if (patch.conditions) checkConditions(patch.conditions);
  await ctx.db.run(
    "UPDATE routing_rules SET name = ?, enabled = ?, conditions = ?, department_id = ?, position = ?, updated_at = ? WHERE id = ?",
    patch.name ?? cur.name,
    patch.enabled ?? !!cur.enabled,
    patch.conditions ? JSON.stringify(patch.conditions) : cur.conditions,
    patch.department_id ?? cur.department_id,
    patch.position ?? cur.position,
    nowIso(ctx),
    id,
  );
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "routing_rule.updated", target: id, detail: { fields: Object.keys(patch) } });
  return (await ctx.db.get<RuleRow>("SELECT * FROM routing_rules WHERE id = ?", id))!;
}

/** The order is the priority: `ids` is the full list, first to last. */
export async function reorderRules(ctx: AppContext, actor: Actor, ids: string[]): Promise<RuleRow[]> {
  const have = await listRules(ctx, actor.workspaceId);
  if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((i) => have.some((r) => r.id === i))) throw unprocessable("INVALID_ORDER", "Send every rule exactly once");
  await ctx.db.tx(async () => {
    for (const [i, id] of ids.entries()) await ctx.db.run("UPDATE routing_rules SET position = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", i, nowIso(ctx), id, actor.workspaceId);
  });
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "routing_rule.reordered", detail: { count: ids.length } });
  return listRules(ctx, actor.workspaceId);
}

export async function deleteRule(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  const res = await ctx.db.run("DELETE FROM routing_rules WHERE id = ? AND workspace_id = ?", id, actor.workspaceId);
  if (!res.changes) throw notFound("Routing rule");
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "routing_rule.deleted", target: id });
}
