import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { emitMessage, findMessageRow, postSystemMessage } from "../services/messageStore.js";
import { sendAgentMessage } from "../services/messages.js";
import { canSeeRoom, getRoomRow, getVisibleRoom } from "../services/roomStore.js";
import { parseJson } from "../util/json.js";
import { newId } from "../util/ids.js";
import { formatMoney, notifyMember } from "./notify.js";
import { assertBillingConfigured } from "./credits.js";
import { ensureBilling, getBilling, patchBilling } from "./state.js";
import type { StripeEvent } from "./types.js";

export const MIN_PAYMENT_MINOR = 50;
export const MAX_PAYMENT_MINOR = 99_999_999;

export interface PaymentRequestRow {
  id: string;
  workspace_id: string;
  room_id: string;
  message_id: string | null;
  contact_id: string | null;
  amount: number;
  currency: string;
  description: string;
  status: "open" | "paid" | "expired" | "canceled" | "refunded";
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  connect_account_id: string;
  url: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  paid_at: string | null;
  refunded_at: string | null;
}

export const paymentRequestDto = (r: PaymentRequestRow) => ({
  id: r.id,
  room_id: r.room_id,
  message_id: r.message_id,
  amount: r.amount,
  currency: r.currency,
  description: r.description,
  status: r.status,
  url: r.status === "open" ? r.url : null,
  created_by: r.created_by,
  created_at: r.created_at,
  expires_at: r.expires_at,
  paid_at: r.paid_at,
});

/* ---------------------------------------------------------------- Connect onboarding */

/** Start (or resume) Stripe Connect Standard onboarding: the workspace connects its OWN Stripe account; payments go to it, not to the platform. */
export async function startConnectOnboarding(ctx: AppContext, actor: Actor): Promise<{ url: string }> {
  assertBillingConfigured(ctx);
  const b = await ensureBilling(ctx, actor.workspaceId);
  let accountId = b.connect_account_id;
  if (!accountId) {
    const a = await ctx.billing.createConnectAccount({ workspaceId: actor.workspaceId, email: actor.email });
    await ctx.db.run("UPDATE billing_accounts SET connect_account_id = ?, updated_at = ? WHERE workspace_id = ? AND connect_account_id IS NULL", a.id, nowIso(ctx), actor.workspaceId);
    accountId = (await getBilling(ctx, actor.workspaceId))!.connect_account_id!;
    await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "billing.connect_started", target: accountId });
  }
  const base = ctx.config.PUBLIC_URL.replace(/\/$/, "");
  return await ctx.billing.createConnectLink({ accountId, refreshUrl: `${base}/settings/billing?connect=refresh`, returnUrl: `${base}/settings/billing?connect=return` });
}

/** Ask Stripe whether the account can take payments yet (called when the owner returns from onboarding; `account.updated` keeps it current afterwards). */
export async function refreshConnect(ctx: AppContext, workspaceId: string): Promise<{ connected: boolean; charges_enabled: boolean }> {
  const b = await getBilling(ctx, workspaceId);
  if (!b?.connect_account_id) return { connected: false, charges_enabled: false };
  assertBillingConfigured(ctx);
  const a = await ctx.billing.getConnectAccount(b.connect_account_id);
  await patchBilling(ctx, workspaceId, { connect_charges_enabled: a.chargesEnabled ? 1 : 0 });
  return { connected: true, charges_enabled: a.chargesEnabled };
}

/* ---------------------------------------------------------------- payment requests */

export interface PaymentRequestInput {
  amount: number;
  currency?: string;
  description: string;
  /** channel the card/link is delivered on; defaults to live chat */
  source?: "dm" | "sms" | "email";
  /** 1 to 24 hours (Stripe's Checkout limits are 30 minutes to 24 hours) */
  expires_in_hours?: number;
  client_msg_id?: string;
}

const cardOf = (r: Pick<PaymentRequestRow, "id" | "amount" | "currency" | "description" | "status" | "url" | "paid_at" | "expires_at">) => ({
  type: "payment_request",
  id: r.id,
  amount: r.amount,
  currency: r.currency,
  description: r.description,
  status: r.status,
  url: r.status === "open" ? r.url : null,
  paid_at: r.paid_at,
  expires_at: r.expires_at,
});

/**
 * Ask a customer to pay, inside the conversation. A Stripe Checkout session is created ON THE WORKSPACE'S CONNECTED ACCOUNT (direct
 * charge), a message carrying a payment card is sent through the normal send path (so SMS/email delivery, credits and limits all apply),
 * and webhooks flip the card from open to paid/expired/refunded in real time.
 */
export async function createPaymentRequest(ctx: AppContext, actor: Actor, roomId: string, input: PaymentRequestInput): Promise<{ request: ReturnType<typeof paymentRequestDto>; message_id: string }> {
  assertBillingConfigured(ctx);
  const room = await getVisibleRoom(ctx, actor, roomId);
  const b = await getBilling(ctx, actor.workspaceId);
  if (!b?.connect_account_id || !b.connect_charges_enabled) throw conflict("CONNECT_NOT_READY", "Connect a Stripe account under Settings > Billing before sending payment requests");
  if (!Number.isInteger(input.amount) || input.amount < MIN_PAYMENT_MINOR || input.amount > MAX_PAYMENT_MINOR) throw badRequest("INVALID_AMOUNT", `Amount must be a whole number of cents between ${MIN_PAYMENT_MINOR} and ${MAX_PAYMENT_MINOR}`);
  const description = input.description.trim();
  if (!description) throw badRequest("VALIDATION_ERROR", "Describe what the payment is for");
  const currency = (input.currency ?? ctx.config.BILLING_CURRENCY).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw badRequest("INVALID_CURRENCY", "Currency must be a 3-letter ISO code");
  const hours = Math.min(Math.max(input.expires_in_hours ?? 24, 1), 24);
  const d = await ctx.ratelimit.check("payments.workspace", { key: actor.workspaceId, workspaceId: actor.workspaceId });
  if (!d.allowed) throw new RateLimitedError(d);

  const id = newId("pay");
  const expiresAt = Math.floor(ctx.clock().getTime() / 1000) + hours * 3600;
  const fee = Math.floor((input.amount * ctx.config.CONNECT_APPLICATION_FEE_BPS) / 10_000);
  const base = ctx.config.PUBLIC_URL.replace(/\/$/, "");
  const session = await ctx.billing.createPaymentCheckout({
    accountId: b.connect_account_id,
    amountCents: input.amount,
    currency,
    description,
    feeCents: fee,
    successUrl: `${base}/pay/thanks`,
    cancelUrl: `${base}/pay/cancelled`,
    expiresAt,
    metadata: { payment_request_id: id, workspace_id: actor.workspaceId, room_id: roomId },
  });
  const row: PaymentRequestRow = {
    id,
    workspace_id: actor.workspaceId,
    room_id: roomId,
    message_id: null,
    contact_id: room.contact_id,
    amount: input.amount,
    currency,
    description,
    status: "open",
    checkout_session_id: session.id,
    payment_intent_id: null,
    connect_account_id: b.connect_account_id,
    url: session.url,
    created_by: actor.memberId,
    created_at: nowIso(ctx),
    expires_at: new Date(expiresAt * 1000).toISOString(),
    paid_at: null,
    refunded_at: null,
  };
  await ctx.db.run(
    `INSERT INTO payment_requests(id, workspace_id, room_id, contact_id, amount, currency, description, status, checkout_session_id, connect_account_id, url, created_by, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id, row.workspace_id, row.room_id, row.contact_id, row.amount, row.currency, row.description, row.status, row.checkout_session_id, row.connect_account_id, row.url, row.created_by, row.created_at, row.expires_at,
  );
  let sent;
  try {
    sent = await sendAgentMessage(ctx, actor, roomId, {
      kind: "text",
      source: input.source ?? "dm",
      content: `Payment request: ${description} - ${formatMoney(input.amount, currency)}\nPay securely: ${session.url}`,
      client_msg_id: input.client_msg_id,
    });
  } catch (e) {
    // nothing was sent: do not leave a live payment link behind
    await ctx.db.run("UPDATE payment_requests SET status = 'canceled' WHERE id = ?", id);
    await ctx.billing.expirePaymentCheckout({ accountId: b.connect_account_id, sessionId: session.id }).catch(() => {});
    throw e;
  }
  row.message_id = sent.message.id;
  await ctx.db.run("UPDATE payment_requests SET message_id = ? WHERE id = ?", sent.message.id, id);
  await writeCard(ctx, row);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "payment_request.created", target: id, detail: { room_id: roomId, amount: input.amount, currency } });
  return { request: paymentRequestDto(row), message_id: sent.message.id };
}

/** Rewrite the card inside the message's meta and push `message:updated` to the team and the visitor. */
async function writeCard(ctx: AppContext, r: PaymentRequestRow): Promise<void> {
  if (!r.message_id) return;
  const m = await findMessageRow(ctx, r.workspace_id, r.message_id, r.room_id);
  if (!m) return;
  const meta = { ...parseJson<Record<string, unknown>>(m.meta, {}), card: cardOf(r) };
  await ctx.db.run("UPDATE messages SET meta = ? WHERE room_id = ? AND id = ?", JSON.stringify(meta), r.room_id, r.message_id);
  const fresh = (await findMessageRow(ctx, r.workspace_id, r.message_id, r.room_id))!;
  await emitMessage(ctx, await getRoomRow(ctx, r.workspace_id, r.room_id), fresh, "message:updated");
}

export async function listPaymentRequests(ctx: AppContext, actor: Actor, roomId: string) {
  await getVisibleRoom(ctx, actor, roomId);
  const rows = await ctx.db.all<PaymentRequestRow>("SELECT * FROM payment_requests WHERE room_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 100", roomId, actor.workspaceId);
  return { data: rows.map(paymentRequestDto) };
}

export async function cancelPaymentRequest(ctx: AppContext, actor: Actor, id: string): Promise<ReturnType<typeof paymentRequestDto>> {
  const r = await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE id = ? AND workspace_id = ?", id, actor.workspaceId);
  if (!r || !(await canSeeRoom(ctx, actor, r.room_id))) throw notFound("Payment request");
  if (r.status !== "open") throw conflict("NOT_OPEN", `This payment request is already ${r.status}`);
  // expire at Stripe first: if the customer pays in the meantime Stripe refuses and the request stays open (and becomes paid via webhook)
  try {
    await ctx.billing.expirePaymentCheckout({ accountId: r.connect_account_id, sessionId: r.checkout_session_id! });
  } catch (e) {
    throw new AppError(409, "CANNOT_CANCEL", `Stripe could not cancel this request (${e instanceof Error ? e.message : "unknown"}). It may already be paid or expired.`);
  }
  const res = await ctx.db.run("UPDATE payment_requests SET status = 'canceled' WHERE id = ? AND status = 'open'", id);
  if (!res.changes) throw conflict("NOT_OPEN", "This payment request is no longer open");
  const fresh = (await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE id = ?", id))!;
  await writeCard(ctx, fresh);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "payment_request.canceled", target: id });
  return paymentRequestDto(fresh);
}

/* ---------------------------------------------------------------- Connect webhooks */

/**
 * Apply a Stripe event from a connected account. The request is found by OUR id in the session metadata AND must belong to the account the
 * event came from: an event for one workspace's account can never touch another workspace's request.
 */
export async function applyPaymentEvent(ctx: AppContext, workspaceId: string, account: string, e: StripeEvent): Promise<boolean> {
  const o = e.data.object;
  const find = async () => {
    if (e.type === "charge.refunded") return await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE payment_intent_id = ? AND connect_account_id = ? AND workspace_id = ?", String(o.payment_intent ?? ""), account, workspaceId);
    const pid = o.metadata?.payment_request_id as string | undefined;
    if (pid) return await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE id = ? AND connect_account_id = ? AND workspace_id = ?", pid, account, workspaceId);
    return await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE checkout_session_id = ? AND connect_account_id = ? AND workspace_id = ?", String(o.id ?? ""), account, workspaceId);
  };
  const r = await find();
  if (!r) return false;

  if (e.type === "checkout.session.completed" || e.type === "checkout.session.async_payment_succeeded") {
    if (o.payment_status !== "paid") return false;
    // claim: the first delivery to flip the status posts the line and the notification, a replay finds it already paid
    const res = await ctx.db.run("UPDATE payment_requests SET status = 'paid', paid_at = ?, payment_intent_id = ? WHERE id = ? AND status != 'paid' AND status != 'refunded'", nowIso(ctx), typeof o.payment_intent === "string" ? o.payment_intent : null, r.id);
    if (!res.changes) return true;
    const fresh = (await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE id = ?", r.id))!;
    await writeCard(ctx, fresh);
    await postSystemMessage(ctx, r.room_id, r.workspace_id, `Payment received: ${formatMoney(r.amount, r.currency)} (${r.description})`, { sub_type: "payment", payment_request_id: r.id });
    if (r.created_by) await notifyMember(ctx, r.workspace_id, r.created_by, { type: "payment_received", roomId: r.room_id, title: `Payment received: ${formatMoney(r.amount, r.currency)}`, body: r.description });
    await recordAudit(ctx, { workspaceId: r.workspace_id, actor: { type: "system" }, action: "payment_request.paid", target: r.id, detail: { amount: r.amount, currency: r.currency } });
    return true;
  }
  if (e.type === "checkout.session.expired") {
    const res = await ctx.db.run("UPDATE payment_requests SET status = 'expired' WHERE id = ? AND status = 'open'", r.id);
    if (res.changes) await writeCard(ctx, (await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE id = ?", r.id))!);
    return true;
  }
  if (e.type === "charge.refunded") {
    if (Number(o.amount_refunded ?? 0) < r.amount) return true; // partial refunds leave the request paid
    const res = await ctx.db.run("UPDATE payment_requests SET status = 'refunded', refunded_at = ? WHERE id = ? AND status = 'paid'", nowIso(ctx), r.id);
    if (res.changes) {
      await writeCard(ctx, (await ctx.db.get<PaymentRequestRow>("SELECT * FROM payment_requests WHERE id = ?", r.id))!);
      await postSystemMessage(ctx, r.room_id, r.workspace_id, `Payment refunded: ${formatMoney(r.amount, r.currency)}`, { sub_type: "payment", payment_request_id: r.id });
    }
    return true;
  }
  return false;
}
