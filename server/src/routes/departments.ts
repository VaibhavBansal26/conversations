import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parseBody, type Env } from "../http.js";
import { id } from "../schemas.js";
import { DepartmentPatchSchema, departmentStatus, getDepartment, listDepartments, updateDepartment } from "../services/departments.js";
import type { InboxRow } from "../services/inboxes.js";
import { createRule, deleteRule, listRules, matchRule, reorderRules, RuleBodySchema, RulePatchSchema, ruleDto, updateRule } from "../services/routingRules.js";

export const RuleOrderBody = z.object({ ids: z.array(id).max(50) });
export const RuleTestBody = z.object({
  page_url: z.string().max(500).optional(),
  locale: z.string().max(20).optional(),
  channel: z.enum(["dm", "sms", "email"]).optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
  email: z.string().max(254).optional(),
  attrs: z.record(z.string().max(60), z.unknown()).optional(),
});

export function departmentRoutes(ctx: AppContext) {
  const r = new Hono<Env>();

  r.get("/departments", async (c) => c.json({ data: await listDepartments(ctx, c.get("actor")) }));
  // who is open and who is free right now, for every department of the workspace (the transfer menu, the queue overview): names and counts only
  r.get("/department-status", async (c) => {
    const rows = await ctx.db.all<InboxRow>("SELECT * FROM inboxes WHERE workspace_id = ? ORDER BY name, id", c.get("actor").workspaceId);
    return c.json({ data: await Promise.all(rows.map((d) => departmentStatus(ctx, d))) });
  });
  r.get("/departments/:id", async (c) => c.json(await getDepartment(ctx, c.get("actor"), c.req.param("id"))));
  r.patch("/departments/:id", async (c) => c.json(await updateDepartment(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, DepartmentPatchSchema))));

  r.get("/routing-rules", async (c) => c.json({ data: (await listRules(ctx, c.get("actor").workspaceId)).map(ruleDto) }));
  r.put("/routing-rules/order", async (c) => c.json({ data: (await reorderRules(ctx, c.get("actor"), (await parseBody(c, RuleOrderBody)).ids)).map(ruleDto) }));
  // the sandbox: which department would a conversation like this go to, and which rules were looked at
  r.post("/routing-rules/test", async (c) => {
    const a = c.get("actor");
    const x = await parseBody(c, RuleTestBody);
    const m = await matchRule(ctx, a.workspaceId, x);
    return c.json({ department_id: m.rule?.department_id ?? null, rule: m.rule ? ruleDto(m.rule) : null, evaluated: m.trace });
  });
  r.post("/routing-rules", async (c) => c.json(ruleDto(await createRule(ctx, c.get("actor"), await parseBody(c, RuleBodySchema))), 201));
  r.patch("/routing-rules/:id", async (c) => c.json(ruleDto(await updateRule(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, RulePatchSchema)))));
  r.delete("/routing-rules/:id", async (c) => {
    await deleteRule(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  return r;
}
