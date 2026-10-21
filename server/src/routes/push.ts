import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parseBody, requireLiveSeat, type Env } from "../http.js";
import { deleteSubscription, listSubscriptions, pushConfig, PUSH_EVENTS, subscribe, testSubscription, updateSubscription } from "../push/service.js";

const Events = z.array(z.enum(PUSH_EVENTS)).max(PUSH_EVENTS.length);
export const PushSubscribeBody = z.object({
  subscription: z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(30) }) }),
  label: z.string().trim().max(60).optional(),
  events: Events.optional(),
});
export const PushPatchBody = z.object({ events: Events.optional(), label: z.string().trim().max(60).optional() });

/** Web Push devices of the signed-in member (docs/NOTIFICATIONS.md). Every route acts on the caller's own devices only. */
export function pushRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  r.use("/push/*", requireLiveSeat);
  r.get("/push/config", (c) => c.json(pushConfig(ctx)));
  r.get("/push/subscriptions", async (c) => c.json(await listSubscriptions(ctx, c.get("actor"))));
  r.post("/push/subscriptions", async (c) => {
    const b = await parseBody(c, PushSubscribeBody);
    return c.json(await subscribe(ctx, c.get("actor"), { ...b.subscription, label: b.label, events: b.events }, c.req.header("user-agent") ?? ""), 201);
  });
  r.patch("/push/subscriptions/:id", async (c) => c.json(await updateSubscription(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, PushPatchBody))));
  r.delete("/push/subscriptions/:id", async (c) => c.json(await deleteSubscription(ctx, c.get("actor"), c.req.param("id"))));
  r.post("/push/subscriptions/:id/test", async (c) => c.json(await testSubscription(ctx, c.get("actor"), c.req.param("id"))));
  return r;
}
