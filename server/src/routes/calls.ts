import { Hono } from "hono";
import type { AppContext } from "../context.js";
import type { Env } from "../http.js";
import { callSettings, listRoomCalls } from "../calls/service.js";
import { iceConfig } from "../calls/turn.js";
import { liveTeamCallOf, teamCallSettings } from "../calls/teamCall.js";
import { createCallLink, linkDto, listCallLinks, revokeCallLink, sendCallLink } from "../calls/links.js";
import { getVisibleRoom } from "../services/roomStore.js";
import { CallLinkCreateBody } from "../schemas.js";
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
    return c.json({
      browser: s.browser,
      ring_seconds: s.ring_seconds,
      turn_provider: s.turn_provider,
      warning: ice?.warning ?? null,
      phone: await phoneReadiness(ctx, ws),
      // what this installation can do for AI calls: the realtime engine needs a key and a model on the server and its instance switch on (the key itself is never reported)
      links: s.links,
      ai: { enabled: s.ai.enabled, engine: s.ai_engine, realtime_available: !!ctx.realtime && !!ctx.config.OPENAI_REALTIME_MODEL && ctx.config.AI_REALTIME_ENABLED, realtime_switched_off: !ctx.config.AI_REALTIME_ENABLED },
    });
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
  // calls between teammates: what the app needs to decide whether to show the call buttons, and a call this member is already in (a tab that opens in the middle of one)
  r.get("/team-calls/config", async (c) => {
    const actor = c.get("actor");
    const s = await teamCallSettings(ctx, actor.workspaceId);
    const ice = s.enabled ? await iceConfig(ctx, actor.workspaceId, (await callSettings(ctx, actor.workspaceId)).turn_provider, "probe") : null;
    return c.json({ ...s, warning: ice?.warning ?? null, live_call: await liveTeamCallOf(ctx, actor) });
  });
  // call links (ADR 0037): the address is returned once, here, and is not stored; the visitor's own copy of the chat derives it
  r.post("/rooms/:id/call-links", async (c) => {
    const actor = c.get("actor");
    const roomId = c.req.param("id");
    const b = await parseBody(c, CallLinkCreateBody);
    await getVisibleRoom(ctx, actor, roomId);
    const made = await createCallLink(ctx, { workspaceId: actor.workspaceId, roomId, mode: b.mode, kind: b.kind, ttlMinutes: b.ttl_minutes, by: { type: "member", id: actor.memberId, name: actor.name } });
    const sent = b.send ? await sendCallLink(ctx, actor, roomId, b.send, made.url, made.link) : null;
    return c.json({ ...linkDto(ctx, made.link), url: made.url, sent }, 201);
  });
  r.get("/rooms/:id/call-links", async (c) => c.json({ data: await listCallLinks(ctx, c.get("actor"), c.req.param("id")) }));
  r.delete("/rooms/:id/call-links/:linkId", async (c) => c.json(await revokeCallLink(ctx, c.get("actor"), c.req.param("id"), c.req.param("linkId"))));
  r.get("/rooms/:id/calls", async (c) => c.json({ data: await listRoomCalls(ctx, c.get("actor"), c.req.param("id")) }));
  return r;
}
