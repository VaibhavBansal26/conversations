import { Hono } from "hono";
import type { AppContext } from "../context.js";
import type { Env } from "../http.js";
import { callSettings, listRoomCalls } from "../calls/service.js";
import { iceConfig } from "../calls/turn.js";
import { assertCallerId, hangupPhoneCall, phoneReadiness, placePhoneCall, requestCallConsent } from "../calls/phone.js";
import { PhoneCallBody } from "../calls/phoneSchemas.js";
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
    return c.json({ browser: s.browser, ring_seconds: s.ring_seconds, turn_provider: s.turn_provider, warning: ice?.warning ?? null, phone: await phoneReadiness(ctx, ws) });
  });
  // the call settings have their own permission (a manager who is not allowed to touch them can still edit the rest of the workspace)
  r.patch("/calls/settings", async (c) => {
    const ws = c.get("actor").workspaceId;
    const body = await parseBody(c, CallsPatchSchema);
    await assertCallerId(ctx, ws, body.phone?.caller_id);
    return c.json(await updateWorkspace(ctx, ws, { settings: { calls: body } }));
  });
  r.post("/rooms/:id/phone-call", async (c) => c.json(await placePhoneCall(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, PhoneCallBody))));
  r.post("/rooms/:id/phone-call/consent", async (c) => c.json(await requestCallConsent(ctx, c.get("actor"), c.req.param("id"))));
  r.post("/calls/:id/hangup", async (c) => c.json(await hangupPhoneCall(ctx, c.get("actor"), c.req.param("id"))));
  r.get("/rooms/:id/calls", async (c) => c.json({ data: await listRoomCalls(ctx, c.get("actor"), c.req.param("id")) }));
  return r;
}
