import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parseBody, parseQuery, type Env } from "../http.js";
import { memberDto } from "../services/members.js";
import { listAudit } from "../services/audit.js";
import { createRole, deleteRole, listRoles, setMemberRole, updateRole } from "../services/roles.js";

export const RoleBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).optional(),
  base_role: z.enum(["manager", "agent"]),
  permissions: z.array(z.string()).max(60),
});
export const RolePatch = RoleBody.partial();
export const MemberRoleBody = z.object({ role_id: z.string().min(1).max(64) });
export const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional(), action: z.string().max(60).optional() });

export function roleRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.get("/roles", async (c) => c.json({ data: await listRoles(ctx, c.get("actor").workspaceId) }));
  r.post("/roles", async (c) => c.json(await createRole(ctx, c.get("actor"), await parseBody(c, RoleBody)), 201));
  r.patch("/roles/:id", async (c) => c.json(await updateRole(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, RolePatch))));
  r.delete("/roles/:id", async (c) => {
    await deleteRole(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.put("/members/:id/role", async (c) => c.json(await memberDto(ctx, await setMemberRole(ctx, c.get("actor"), c.req.param("id"), (await parseBody(c, MemberRoleBody)).role_id))));
  r.get("/audit", async (c) => c.json(await listAudit(ctx, c.get("actor").workspaceId, parseQuery(c, AuditQuery))));
  return r;
}
