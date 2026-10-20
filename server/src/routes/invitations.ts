import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parseBody, type Env } from "../http.js";
import { inviteMember, listInvitations, revokeInvitation } from "../services/accounts.js";

const Invite = z.object({ email: z.string().email().max(254), name: z.string().trim().max(100).optional(), role_id: z.string().min(1).max(64) });

export function invitationRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.get("/invitations", async (c) => c.json({ data: await listInvitations(ctx, c.get("actor").workspaceId) }));
  r.post("/invitations", async (c) => c.json(await inviteMember(ctx, c.get("actor"), await parseBody(c, Invite)), 201));
  r.delete("/invitations/:id", async (c) => {
    await revokeInvitation(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  return r;
}
