import { Hono } from "hono";
import type { AppContext } from "../context.js";
import type { Env } from "../http.js";
import { callSettings, listRoomCalls } from "../calls/service.js";
import { iceConfig } from "../calls/turn.js";
import { CallsPatchSchema } from "../domain/settings.js";
import { parseBody } from "../http.js";
import { updateWorkspace } from "../services/workspaces.js";

export function callRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  // what the inbox needs to decide whether to show the call buttons, and the one warning worth showing before the first call
  r.get("/calls/config", async (c) => {
    const ws = c.get("actor").workspaceId;
    const s = await callSettings(ctx, ws);
    const ice = s.browser.enabled ? await iceConfig(ctx, ws, s.turn_provider, "probe") : null;
    return c.json({ browser: s.browser, ring_seconds: s.ring_seconds, turn_provider: s.turn_provider, warning: ice?.warning ?? null });
  });
  // the call settings have their own permission (a manager who is not allowed to touch them can still edit the rest of the workspace)
  r.patch("/calls/settings", async (c) => c.json(await updateWorkspace(ctx, c.get("actor").workspaceId, { settings: { calls: await parseBody(c, CallsPatchSchema) } })));
  r.get("/rooms/:id/calls", async (c) => c.json({ data: await listRoomCalls(ctx, c.get("actor"), c.req.param("id")) }));
  return r;
}
