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
