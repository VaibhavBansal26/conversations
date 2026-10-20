import type { AppContext } from "../context.js";
import { RateLimitedError } from "./errors.js";

export interface SendLimitInput {
  workspaceId: string;
  roomId: string;
  contactId: string;
  clientMsgId?: string | null;
  /** sms / email leave the platform and have their own quotas; dm stays inside it */
  external?: "sms" | "email" | null;
}

/**
 * Volume limits every message send passes through, REST and socket alike (called from the services, after the idempotency lookup and
 * before any side effect). A retry of the same client_msg_id inside the window is not counted twice.
 */
export async function enforceSendLimits(ctx: AppContext, i: SendLimitInput): Promise<void> {
  if (i.external) {
    // per-tenant backpressure: a workspace whose own send backlog is huge is told to slow down; nobody else is affected
    const depth = await ctx.cache.wrap(`sendq:${i.workspaceId}`, async () => Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ? AND status = 'pending'", i.workspaceId))?.n ?? 0));
    if (depth >= ctx.config.SEND_QUEUE_WORKSPACE_MAX) {
      throw new RateLimitedError({ allowed: false, outcome: "limited", policy: "send.backlog", limit: ctx.config.SEND_QUEUE_WORKSPACE_MAX, windowSec: 0, remaining: 0, retryAfterMs: 30_000, resetMs: 30_000, shed: false });
    }
  }
  const idem = i.clientMsgId ?? undefined;
  const take = async (policy: string, key: string, workspaceId?: string) => {
    const d = await ctx.ratelimit.check(policy, { key, workspaceId }, { idempotencyKey: idem });
    if (!d.allowed) throw new RateLimitedError(d);
  };
  await take("msg.room", i.roomId);
  await take("msg.workspace", i.workspaceId, i.workspaceId);
  if (i.external === "sms") {
    await take("sms.workspace", i.workspaceId, i.workspaceId);
    await take("sms.contact", `${i.workspaceId}|${i.contactId}`);
  } else if (i.external === "email") {
    await take("email.workspace", i.workspaceId, i.workspaceId);
  }
}
