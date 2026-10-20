import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FakeBilling } from "../src/billing/fake.js";
import { signStripePayload } from "../src/billing/signature.js";
import { getBilling } from "../src/billing/state.js";
import { jobHandlers } from "../src/jobs/scheduler.js";
import { runDueJobs } from "../src/jobs/queue.js";
import { visitorMessageDto, type MessageRow } from "../src/services/messageStore.js";
import { addMember } from "../src/services/members.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { setMemberRole } from "../src/services/roles.js";
import { addMemberRaw, addSmsNumberRaw, client, makeCtx, mkRoom, seedWorkspace, setSettings, tokenFor } from "./helpers.js";

const ENV = { STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_BUSINESS: "price_biz", BILLING_GRACE_DAYS: "7" };

async function setup(env: Record<string, string> = {}) {
  const billing = new FakeBilling();
  const ctx = await makeCtx({ ...ENV, ...env }, { billing });
  const app = createApp(ctx);
  const http = client(app);
  const { wsId, owner } = await seedWorkspace(ctx);
  const token = await tokenFor(ctx, owner);
  const hook = async (kind: "platform" | "connect", e: Parameters<FakeBilling["signed"]>[1]) => {
    const s = billing.signed(kind, e);
    const r = await http.call("POST", kind === "platform" ? "/webhooks/stripe" : "/webhooks/stripe/connect", { raw: s.body, headers: { "stripe-signature": s.signature, "content-type": "application/json" } });
    await ctx.background.settle();
    return { ...r, id: s.event.id };
  };
  const balance = async () => (await ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", wsId))!.credit_balance;
  const ledger = (kind?: string) => ctx.db.all<{ kind: string; delta: number; idem_key: string | null }>(`SELECT kind, delta, idem_key FROM usage_ledger WHERE workspace_id = ? ${kind ? "AND kind = ?" : ""}`, wsId, ...(kind ? [kind] : []));
  const notifications = (type: string) => ctx.db.all<{ title: string }>("SELECT title FROM notifications WHERE workspace_id = ? AND type = ?", wsId, type);
  const runJobs = async () => {
    const r = await runDueJobs(ctx, jobHandlers);
    await ctx.background.settle();
    return r;
  };
  /** the workspace's effective per-minute API limit: it is plan-scaled, so it shows which tier the limiter resolved */
  const apiLimit = async () => (await ctx.ratelimit.check("api.workspace", { key: `probe-${Math.random()}`, workspaceId: wsId })).limit;
  const customerId = async () => {
    if (!(await getBilling(ctx, wsId))?.stripe_customer_id) await http.post("/api/billing/checkout/topup", { credits: 100 }, token);
    return (await getBilling(ctx, wsId))!.stripe_customer_id!;
  };
  const subscription = (cust: string, o: Record<string, unknown> = {}) => ({
    id: "sub_1",
    status: "active",
    customer: cust,
    metadata: { workspace_id: wsId, plan: "pro" },
    items: { data: [{ price: { id: "price_pro" } }] },
    current_period_end: 1_900_000_000,
    cancel_at_period_end: false,
    ...o,
  });
  const invoice = (cust: string, o: Record<string, unknown> = {}) => ({ id: "in_1", customer: cust, subscription_details: { metadata: { workspace_id: wsId } }, lines: { data: [{ price: { id: "price_pro" } }] }, amount_paid: 4900, ...o });
  return { billing, ctx, app, http, wsId, owner, token, hook, balance, ledger, notifications, runJobs, customerId, subscription, invoice, apiLimit };
}

describe("webhook signature", () => {
  it("refuses a missing, forged, wrong-secret or stale signature, and changes nothing", async () => {
    const t = await setup();
    const cust = await t.customerId();
    const event = { type: "checkout.session.completed", object: { id: "cs_x", mode: "payment", payment_status: "paid", customer: cust, metadata: { workspace_id: t.wsId, kind: "topup", credits: "500" } } };
    const s = t.billing.signed("platform", event);
    const post = (headers: Record<string, string>, raw = s.body) => t.http.call("POST", "/webhooks/stripe", { raw, headers: { "content-type": "application/json", ...headers } });
    expect((await post({})).status).toBe(401);
    expect((await post({ "stripe-signature": "t=1,v1=deadbeef" })).status).toBe(401);
    expect((await post({ "stripe-signature": signStripePayload("whsec_other", s.body) })).status).toBe(401);
    expect((await post({ "stripe-signature": signStripePayload(t.billing.platformSecret, s.body, Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401); // replay of an old capture
    expect((await post({ "stripe-signature": s.signature }, s.body + " ")).status).toBe(401); // body altered after signing
    expect((await post({ "stripe-signature": signStripePayload(t.billing.connectSecret, s.body) })).status).toBe(401); // the Connect secret does not open the platform endpoint
    expect(await t.balance()).toBe(0);
    expect(await t.ctx.db.get("SELECT 1 FROM stripe_events")).toBeUndefined();
    expect((await post({ "stripe-signature": s.signature })).status).toBe(200);
    expect(await t.balance()).toBe(500);
  });

  it("repeated signature failures from one address are blocked like any other webhook abuse", async () => {
    const t = await setup();
    let blocked = false;
    for (let i = 0; i < 30 && !blocked; i++) {
      const r = await t.http.call("POST", "/webhooks/stripe", { raw: "{}", headers: { "stripe-signature": "bad", "x-forwarded-for": "203.0.113.9" } });
      blocked = r.status === 429 || r.status === 403;
    }
    expect(blocked).toBe(true);
  });

  it("answers 401 when the server has no Stripe credentials", async () => {
    const ctx = await makeCtx();
    const r = await client(createApp(ctx)).call("POST", "/webhooks/stripe", { raw: "{}", headers: { "stripe-signature": "t=1,v1=a" } });
    expect(r.status).toBe(401);
  });
});

describe("billing not configured", () => {
  it("checkout, portal and Connect answer 503 BILLING_NOT_CONFIGURED; the summary still works and says so", async () => {
    const ctx = await makeCtx();
    const app = createApp(ctx);
    const http = client(app);
    const { owner } = await seedWorkspace(ctx);
    const token = await tokenFor(ctx, owner);
    for (const [path, body] of [["/api/billing/checkout/subscription", { plan: "pro" }], ["/api/billing/checkout/topup", { credits: 500 }], ["/api/billing/portal", {}], ["/api/billing/connect/onboard", {}]] as const) {
      const r = await http.post(path, body, token);
      expect(r.status, path).toBe(503);
      expect(r.body.error.code).toBe("BILLING_NOT_CONFIGURED");
    }
    const s = await http.get("/api/billing", token);
    expect(s.status).toBe(200);
    expect(s.body.configured).toBe(false);
    expect(s.body.plan.id).toBe("free");
  });
});

describe("top-ups", () => {
  it("validates the request, creates a checkout for the right amount, and adds the credits once however often Stripe delivers the event", async () => {
    const t = await setup({ CREDIT_PRICE_CENTS: "2" });
    for (const bad of [{ credits: 99 }, { credits: 100001 }, { credits: 12.5 }, { pack: "nope" }, {}]) expect((await t.http.post("/api/billing/checkout/topup", bad, t.token)).status, JSON.stringify(bad)).toBe(400);
    const r = await t.http.post("/api/billing/checkout/topup", { pack: "pack_1000" }, t.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ credits: 1000, amount_cents: 2000 });
    const session = [...t.billing.sessions.values()].at(-1)!;
    expect(session.input).toMatchObject({ mode: "payment", amountCents: 2000, credits: 1000, metadata: { workspace_id: t.wsId, kind: "topup", credits: "1000" } });

    const cust = (await getBilling(t.ctx, t.wsId))!.stripe_customer_id;
    const event = { id: "evt_topup_1", type: "checkout.session.completed", object: { id: "cs_paid", mode: "payment", payment_status: "paid", customer: cust, metadata: { workspace_id: t.wsId, kind: "topup", credits: "1000" } } };
    expect((await t.hook("platform", event)).body.result).toBe("processed");
    expect((await t.hook("platform", event)).body.result).toBe("duplicate");
    // a different event id for the same checkout session (Stripe sends both completed and async_succeeded for some methods) must not credit twice
    expect((await t.hook("platform", { ...event, id: "evt_topup_2", type: "checkout.session.async_payment_succeeded" })).status).toBe(200);
    expect(await t.balance()).toBe(1000);
    expect(await t.ledger("topup")).toHaveLength(1);
    const b = (await getBilling(t.ctx, t.wsId))!;
    expect([b.payment_method_brand, b.payment_method_last4]).toEqual(["visa", "4242"]);
  });

  it("does not credit an unpaid (asynchronous) checkout until the payment succeeds", async () => {
    const t = await setup();
    const cust = await t.customerId();
    const obj = { id: "cs_async", mode: "payment", payment_status: "unpaid", customer: cust, metadata: { workspace_id: t.wsId, kind: "topup", credits: "300" } };
    await t.hook("platform", { type: "checkout.session.completed", object: obj });
    expect(await t.balance()).toBe(0);
    await t.hook("platform", { type: "checkout.session.async_payment_succeeded", object: { ...obj, payment_status: "paid" } });
    expect(await t.balance()).toBe(300);
  });

  it("never applies an event for a workspace to a different Stripe customer's account", async () => {
    const t = await setup();
    await t.customerId();
    await t.hook("platform", { type: "checkout.session.completed", object: { id: "cs_evil", mode: "payment", payment_status: "paid", customer: "cus_someone_else", metadata: { workspace_id: t.wsId, kind: "topup", credits: "999" } } });
    expect(await t.balance()).toBe(0);
  });

  it("a webhook that fails halfway is retried by Stripe and then applies exactly once", async () => {
    const t = await setup();
    const cust = await t.customerId();
    const original = t.billing.getCheckoutPaymentMethod.bind(t.billing);
    let calls = 0;
    t.ctx.billing.getCheckoutPaymentMethod = async (id: string) => {
      if (calls++ === 0) throw new Error("stripe down");
      return original();
    };
    // the first attempt credits, then fails while saving the card; the handler tolerates that (card lookup is best-effort)
    const event = { id: "evt_flaky", type: "checkout.session.completed", object: { id: "cs_flaky", mode: "payment", payment_status: "paid", customer: cust, metadata: { workspace_id: t.wsId, kind: "topup", credits: "250" } } };
    expect((await t.hook("platform", event)).status).toBe(200);
    expect((await t.hook("platform", event)).body.result).toBe("duplicate");
    expect(await t.balance()).toBe(250);
    // a genuinely failing handler leaves the event retryable
    t.ctx.db.trace = null;
    const failing = { id: "evt_fail", type: "customer.subscription.updated", object: t.subscription(cust) };
    const real = t.ctx.db.run.bind(t.ctx.db);
    let armed = true;
    t.ctx.db.run = (async (sql: string, ...p: never[]) => {
      if (armed && /UPDATE billing_accounts SET plan/.test(sql)) {
        armed = false;
        throw new Error("db blip");
      }
      return real(sql, ...p);
    }) as never;
    expect((await t.hook("platform", failing)).status).toBe(500);
    expect((await t.ctx.db.get<{ status: string }>("SELECT status FROM stripe_events WHERE id = 'evt_fail'"))!.status).toBe("failed");
    expect((await t.hook("platform", failing)).body.result).toBe("processed");
    expect((await getBilling(t.ctx, t.wsId))!.plan).toBe("pro");
  });
});

describe("subscriptions and plans", () => {
  it("checkout is created for pro/business only, and not while a subscription is active", async () => {
    const t = await setup();
    expect((await t.http.post("/api/billing/checkout/subscription", { plan: "free" }, t.token)).status).toBe(400);
    expect((await t.http.post("/api/billing/checkout/subscription", { plan: "platinum" }, t.token)).status).toBe(400);
    const r = await t.http.post("/api/billing/checkout/subscription", { plan: "pro" }, t.token);
    expect(r.status).toBe(200);
    expect(r.body.url).toContain("checkout.stripe.test");
    expect([...t.billing.sessions.values()].at(-1)!.input).toMatchObject({ mode: "subscription", plan: "pro", metadata: { workspace_id: t.wsId, plan: "pro" } });
    const cust = (await getBilling(t.ctx, t.wsId))!.stripe_customer_id!;
    await t.hook("platform", { type: "customer.subscription.created", object: t.subscription(cust) });
    expect((await t.http.post("/api/billing/checkout/subscription", { plan: "business" }, t.token)).status).toBe(409);
    expect((await t.http.post("/api/billing/portal", {}, t.token)).body.url).toContain(`/portal/${cust}`);
  });

  it("subscription events set the plan (and with it every plan-scaled limit), the invoice grants the monthly credits once, cancellation returns to free", async () => {
    const t = await setup();
    const cust = await t.customerId();
    expect(await t.apiLimit()).toBe(1200);
    await t.hook("platform", { type: "customer.subscription.created", created: 100, object: t.subscription(cust) });
    let b = (await getBilling(t.ctx, t.wsId))!;
    expect([b.plan, b.status, b.stripe_subscription_id, b.cancel_at_period_end]).toEqual(["pro", "active", "sub_1", 0]);
    expect((await t.ctx.db.get<{ plan: string }>("SELECT plan FROM workspaces WHERE id = ?", t.wsId))!.plan).toBe("pro");
    expect(await t.apiLimit()).toBe(6000);

    const paid = { id: "evt_inv_1", type: "invoice.paid", object: t.invoice(cust) };
    await t.hook("platform", paid);
    await t.hook("platform", paid); // redelivery
    await t.hook("platform", { ...paid, id: "evt_inv_1b" }); // same invoice under a new event id
    expect(await t.balance()).toBe(500);
    await t.hook("platform", { type: "invoice.paid", object: t.invoice(cust, { id: "in_2" }) }); // next month
    expect(await t.balance()).toBe(1000);

    await t.hook("platform", { type: "customer.subscription.updated", created: 200, object: t.subscription(cust, { items: { data: [{ price: { id: "price_biz" } }] }, metadata: { workspace_id: t.wsId } }) });
    expect((await getBilling(t.ctx, t.wsId))!.plan).toBe("business");
    await t.hook("platform", { type: "customer.subscription.updated", created: 300, object: t.subscription(cust, { cancel_at_period_end: true, items: { data: [{ price: { id: "price_biz" } }] } }) });
    expect((await getBilling(t.ctx, t.wsId))!.cancel_at_period_end).toBe(1);
    await t.hook("platform", { type: "customer.subscription.deleted", created: 400, object: t.subscription(cust, { status: "canceled" }) });
    b = (await getBilling(t.ctx, t.wsId))!;
    expect([b.plan, b.status, b.stripe_subscription_id]).toEqual(["free", "canceled", null]);
    expect(await t.apiLimit()).toBe(1200);
    const audit = await t.ctx.db.all<{ detail: string }>("SELECT detail FROM audit_log WHERE workspace_id = ? AND action = 'billing.plan_changed' ORDER BY created_at, id", t.wsId);
    expect(audit.map((a) => JSON.parse(a.detail).to)).toEqual(["pro", "business", "free"]);
  });

  it("an older subscription event arriving late does not undo a newer one", async () => {
    const t = await setup();
    const cust = await t.customerId();
    await t.hook("platform", { type: "customer.subscription.updated", created: 500, object: t.subscription(cust, { items: { data: [{ price: { id: "price_biz" } }] } }) });
    await t.hook("platform", { type: "customer.subscription.updated", created: 400, object: t.subscription(cust) }); // pro, older
    expect((await getBilling(t.ctx, t.wsId))!.plan).toBe("business");
  });

  it("seat limits follow the plan when plans are enforced", async () => {
    const t = await setup({ PLAN_ENFORCEMENT: "true" });
    await addMemberRaw(t.ctx, t.wsId, { name: "A" });
    await addMemberRaw(t.ctx, t.wsId, { name: "B" });
    const add = (n: number) => addMember(t.ctx, t.owner, { email: `new${n}@example.test`, name: `New ${n}`, password: "password123", role: "agent" });
    await expect(add(1)).rejects.toMatchObject({ status: 402, code: "SEAT_LIMIT" }); // free: 3 seats (owner + 2)
    const invite = await t.http.post("/api/invitations", { email: "x@example.test", role_id: "role_agent" }, t.token);
    expect(invite.status).toBe(402);
    const cust = await t.customerId();
    await t.hook("platform", { type: "customer.subscription.created", object: t.subscription(cust) });
    await expect(add(2)).resolves.toBeDefined();
    const s = await t.http.get("/api/billing", t.token);
    expect(s.body.plan).toMatchObject({ id: "pro", seats: 10, seats_used: 4 });
  });

  it("without PLAN_ENFORCEMENT nothing is limited by plan", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) await addMember(t.ctx, t.owner, { email: `u${i}@example.test`, name: `U${i}`, password: "password123", role: "agent" });
  });
});

describe("failed payments: grace period and soft lock", () => {
  it("keeps working during grace, soft-locks external sends after it, never blocks chat or billing, and unlocks the moment an invoice is paid", async () => {
    const t = await setup({ PLAN_ENFORCEMENT: "true" });
    const cust = await t.customerId();
    await t.hook("platform", { type: "customer.subscription.created", object: t.subscription(cust) });
    await addSmsNumberRaw(t.ctx, t.wsId, "+15550001111", true);
    const { room } = await mkRoom(t.ctx, t.wsId, { contact: { name: "Pat", phone: "+14155552671", email: "pat@example.test" } });
    let token = t.token;
    const sms = () => t.http.post(`/api/rooms/${room.id}/messages`, { kind: "text", source: "sms", content: "hello" }, token);
    const dm = () => t.http.post(`/api/rooms/${room.id}/messages`, { kind: "text", source: "dm", content: "hi" }, token);

    const failed = { type: "invoice.payment_failed", object: t.invoice(cust) };
    await t.hook("platform", { ...failed, id: "evt_pf1" });
    await t.hook("platform", { ...failed, id: "evt_pf2" }); // Stripe retries the charge: still one alert
    const b = (await getBilling(t.ctx, t.wsId))!;
    expect(b.status).toBe("past_due");
    expect(b.grace_until).toBe(new Date(t.ctx.clock().getTime() + 7 * 86_400_000).toISOString());
    expect(await t.notifications("payment_failed")).toHaveLength(1);
    expect((await t.http.get("/api/billing", t.token)).body.access).toBe("grace");
    expect((await sms()).status).toBe(201);

    t.ctx.clockCtl.advance(7 * 86_400_000 + 1000);
    token = await tokenFor(t.ctx, t.owner); // access tokens live 15 minutes
    const locked = await sms();
    expect(locked.status).toBe(402);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    expect((await dm()).status).toBe(201); // live chat still works
    expect((await t.http.get(`/api/rooms/${room.id}/messages`, token)).status).toBe(200);
    const summary = await t.http.get("/api/billing", token);
    expect([summary.status, summary.body.access]).toEqual([200, "locked"]);
    expect((await t.http.post("/api/billing/portal", {}, token)).status).toBe(200);
    expect(await t.ctx.db.get("SELECT 1 FROM usage_ledger WHERE kind = 'sms' AND idem_key IS NULL AND delta < 0")).toBeDefined(); // the earlier in-grace send was billed normally

    await t.hook("platform", { type: "invoice.paid", object: t.invoice(cust) });
    expect((await getBilling(t.ctx, t.wsId))!.grace_until).toBeNull();
    expect((await sms()).status).toBe(201);
    expect((await t.http.get("/api/billing", token)).body.access).toBe("ok");
  });

  it("locking only applies when PLAN_ENFORCEMENT is on", async () => {
    const t = await setup();
    const cust = await t.customerId();
    await t.hook("platform", { type: "invoice.payment_failed", object: t.invoice(cust) });
    t.ctx.clockCtl.advance(30 * 86_400_000);
    const { assertNotLocked } = await import("../src/billing/state.js");
    await expect(assertNotLocked(t.ctx, t.wsId)).resolves.toBeUndefined();
  });
});

describe("low balance and auto-recharge", () => {
  it("alerts the owners once when the balance falls to the threshold, and re-arms after a top-up", async () => {
    const t = await setup();
    await t.customerId();
    await t.ctx.db.run("UPDATE workspaces SET credit_balance = 52 WHERE id = ?", t.wsId);
    await t.http.patch("/api/billing/automation", { low_balance_threshold: 50 }, t.token);
    const { recordUsage } = await import("../src/services/workspaces.js");
    await recordUsage(t.ctx, t.wsId, "sms", -1);
    await t.ctx.background.settle();
    expect(await t.notifications("low_balance")).toHaveLength(0);
    await recordUsage(t.ctx, t.wsId, "sms", -1);
    await recordUsage(t.ctx, t.wsId, "sms", -1);
    await t.ctx.background.settle();
    expect(await t.notifications("low_balance")).toHaveLength(1);
    expect(t.ctx.email instanceof Object && (t.ctx.email as unknown as { sent: { subject: string }[] }).sent.some((m) => /running low/.test(m.subject))).toBe(true);
    const cust = (await getBilling(t.ctx, t.wsId))!.stripe_customer_id;
    await t.hook("platform", { type: "checkout.session.completed", object: { id: "cs_t", mode: "payment", payment_status: "paid", customer: cust, metadata: { workspace_id: t.wsId, kind: "topup", credits: "500" } } });
    expect((await getBilling(t.ctx, t.wsId))!.low_balance_notified_at).toBeNull();
    await t.ctx.db.run("UPDATE workspaces SET credit_balance = 51 WHERE id = ?", t.wsId);
    await recordUsage(t.ctx, t.wsId, "sms", -2);
    await t.ctx.background.settle();
    expect(await t.notifications("low_balance")).toHaveLength(2);
  });

  async function withCard(t: Awaited<ReturnType<typeof setup>>) {
    const cust = await t.customerId();
    await t.hook("platform", { type: "checkout.session.completed", object: { id: "cs_card", mode: "payment", payment_status: "paid", customer: cust, metadata: { workspace_id: t.wsId, kind: "topup", credits: "100" } } });
    return cust;
  }

  it("turning auto-recharge on needs a saved card and sane numbers", async () => {
    const t = await setup();
    const no = await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 }, t.token);
    expect([no.status, no.body.error.code]).toEqual([409, "NO_PAYMENT_METHOD"]);
    await withCard(t);
    expect((await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 10 }, t.token)).status).toBe(400);
    expect((await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_credits: 1000 }, t.token)).body.error.code).toBe("INVALID_THRESHOLD");
    const ok = await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 }, t.token);
    expect(ok.status).toBe(200);
    expect(ok.body.automation).toMatchObject({ auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 });
    expect(ok.body.payment_method).toEqual({ brand: "visa", last4: "4242" });
    expect(JSON.stringify(ok.body)).not.toMatch(/pm_fake|cus_/); // ids stay server-side
  });

  it("charges the saved card once when the balance drops, credits once even when the payment_intent webhook also arrives, and does not charge again in the same window", async () => {
    const t = await setup({ CREDIT_PRICE_CENTS: "2" });
    await withCard(t);
    await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 }, t.token);
    const before = await t.balance();
    const { recordUsage } = await import("../src/services/workspaces.js");
    await recordUsage(t.ctx, t.wsId, "sms", -(before - 90)); // 90 left
    await t.ctx.background.settle();
    await recordUsage(t.ctx, t.wsId, "sms", -1);
    await t.ctx.background.settle();
    expect((await runJobsOnce(t)).ran).toBe(1); // two drops, one job (same window)
    expect(t.billing.charges).toHaveLength(1);
    expect(t.billing.charges[0]).toMatchObject({ amountCents: 2000 });
    expect(await t.balance()).toBe(89 + 1000);

    const pi = t.billing.charges[0]!.id;
    await t.hook("platform", { type: "payment_intent.succeeded", object: { id: pi, customer: t.billing.charges[0]!.customerId, metadata: { workspace_id: t.wsId, kind: "auto_recharge", credits: "1000" } } });
    expect(await t.balance()).toBe(89 + 1000);
    expect((await t.ledger("topup")).filter((l) => l.idem_key === `pi:${pi}`)).toHaveLength(1);

    // balance high again: a stray job does nothing
    expect(await (await import("../src/billing/credits.js")).runAutoRecharge(t.ctx, { workspace_id: t.wsId, bucket: 1 })).toBe("skipped");
  });

  it("a payment_intent webhook that arrives before the job's own bookkeeping still credits only once", async () => {
    const t = await setup();
    await withCard(t);
    await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 }, t.token);
    await t.ctx.db.run("UPDATE workspaces SET credit_balance = 10 WHERE id = ?", t.wsId);
    const cust = (await getBilling(t.ctx, t.wsId))!.stripe_customer_id!;
    await t.hook("platform", { type: "payment_intent.succeeded", object: { id: "pi_early", customer: cust, metadata: { workspace_id: t.wsId, kind: "auto_recharge", credits: "1000" } } });
    expect(await t.balance()).toBe(1010);
    const { addPurchasedCredits } = await import("../src/billing/credits.js");
    expect((await addPurchasedCredits(t.ctx, t.wsId, 1000, "pi:pi_early", "auto-recharge")).applied).toBe(false);
    expect(await t.balance()).toBe(1010);
  });

  it("a declined card is retried later, and after three declines auto-recharge switches itself off and tells the owner", async () => {
    const t = await setup();
    await withCard(t);
    await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 }, t.token);
    t.billing.chargeOutcome = "failed";
    const { recordUsage } = await import("../src/services/workspaces.js");
    for (let i = 0; i < 3; i++) {
      await recordUsage(t.ctx, t.wsId, "sms", -1);
      await t.ctx.background.settle();
      await runJobsOnce(t);
      t.ctx.clockCtl.advance(11 * 60_000); // next window
    }
    const b = (await getBilling(t.ctx, t.wsId))!;
    expect([b.auto_recharge_enabled, b.auto_recharge_failures]).toEqual([0, 3]);
    expect(await t.notifications("auto_recharge_failed")).toHaveLength(3);
    expect((await t.notifications("auto_recharge_failed")).at(-1)!.title).toBe("Auto-recharge was turned off");
    expect(await t.balance()).toBeLessThan(100);
  });

  it("a card that needs authentication (3-D Secure) turns auto-recharge off at once", async () => {
    const t = await setup();
    await withCard(t);
    await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 }, t.token);
    t.billing.chargeOutcome = "requires_action";
    await t.ctx.db.run("UPDATE workspaces SET credit_balance = 5 WHERE id = ?", t.wsId);
    const { runAutoRecharge } = await import("../src/billing/credits.js");
    expect(await runAutoRecharge(t.ctx, { workspace_id: t.wsId, bucket: 1 })).toBe("failed");
    expect((await getBilling(t.ctx, t.wsId))!.auto_recharge_enabled).toBe(0);
  });

  it("does not auto-recharge a soft-locked workspace", async () => {
    const t = await setup({ PLAN_ENFORCEMENT: "true" });
    const cust = await withCard(t);
    await t.http.patch("/api/billing/automation", { auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 }, t.token);
    await t.hook("platform", { type: "invoice.payment_failed", object: t.invoice(cust) });
    t.ctx.clockCtl.advance(8 * 86_400_000);
    await t.ctx.db.run("UPDATE workspaces SET credit_balance = 5 WHERE id = ?", t.wsId);
    const { runAutoRecharge } = await import("../src/billing/credits.js");
    expect(await runAutoRecharge(t.ctx, { workspace_id: t.wsId, bucket: 9 })).toBe("skipped");
    expect(t.billing.charges).toHaveLength(0);
  });
});

async function runJobsOnce(t: Awaited<ReturnType<typeof setup>>) {
  const r = await runDueJobs(t.ctx, jobHandlers);
  await t.ctx.background.settle();
  return r;
}

describe("permissions", () => {
  it("only roles with billing:manage see or change billing; payments:request is separate", async () => {
    const t = await setup();
    const agent = await addMemberRaw(t.ctx, t.wsId, { role: "agent" });
    const viewer = await addMemberRaw(t.ctx, t.wsId, { role: "agent" });
    await setMemberRole(t.ctx, t.owner, viewer.memberId, "role_viewer");
    const manager = await addMemberRaw(t.ctx, t.wsId, { role: "manager" });
    await setMemberRole(t.ctx, t.owner, manager.memberId, "role_manager");
    const tok = async (a: typeof agent) => tokenFor(t.ctx, actorFromRow(await getMember(t.ctx, t.wsId, a.memberId)));
    for (const who of [agent, viewer, manager]) {
      const token = await tok(who);
      for (const [m, p, body] of [["GET", "/api/billing"], ["POST", "/api/billing/portal", {}], ["POST", "/api/billing/checkout/topup", { credits: 500 }], ["PATCH", "/api/billing/automation", { low_balance_threshold: 5 }], ["POST", "/api/billing/connect/onboard", {}]] as const) {
        const r = await t.http.call(m, p, { token, json: body });
        expect([r.status, r.body.error.code], `${who.roleKey} ${m} ${p}`).toEqual([403, "PERMISSION_DENIED"]);
      }
    }
    expect((await t.http.get("/api/billing", t.token)).status).toBe(200);
  });
});

describe("customer payment requests (Connect)", () => {
  async function connected(t: Awaited<ReturnType<typeof setup>>) {
    const r = await t.http.post("/api/billing/connect/onboard", {}, t.token);
    expect(r.status).toBe(200);
    const acct = (await getBilling(t.ctx, t.wsId))!.connect_account_id!;
    return { acct, link: r.body.url as string };
  }
  const enable = async (t: Awaited<ReturnType<typeof setup>>, acct: string) => {
    await t.hook("connect", { type: "account.updated", object: { id: acct, charges_enabled: true } });
  };
  const messageOf = (t: Awaited<ReturnType<typeof setup>>, id: string) => t.ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id) as Promise<MessageRow>;

  it("onboards the workspace's own account, and refuses payment requests until Stripe says charges are enabled", async () => {
    const t = await setup();
    const { room } = await mkRoom(t.ctx, t.wsId);
    const body = { amount: 2500, description: "Deposit" };
    const early = await t.http.post(`/api/rooms/${room.id}/payment-requests`, body, t.token);
    expect([early.status, early.body.error.code]).toEqual([409, "CONNECT_NOT_READY"]);
    const { acct, link } = await connected(t);
    expect(link).toContain(acct);
    expect((await t.http.post("/api/billing/connect/onboard", {}, t.token)).body.url).toContain(acct); // resuming reuses the account
    expect(t.billing.accounts.size).toBe(1);
    expect((await t.http.post(`/api/rooms/${room.id}/payment-requests`, body, t.token)).status).toBe(409);
    await enable(t, acct);
    expect((await t.http.get("/api/billing", t.token)).body.connect).toEqual({ connected: true, charges_enabled: true });
    expect((await t.http.post(`/api/rooms/${room.id}/payment-requests`, body, t.token)).status).toBe(201);
  });

  it("refresh asks Stripe directly (the owner returning from onboarding)", async () => {
    const t = await setup();
    const { acct } = await connected(t);
    expect((await t.http.post("/api/billing/connect/refresh", {}, t.token)).body).toEqual({ connected: true, charges_enabled: false });
    t.billing.accounts.set(acct, { chargesEnabled: true, detailsSubmitted: true });
    expect((await t.http.post("/api/billing/connect/refresh", {}, t.token)).body).toEqual({ connected: true, charges_enabled: true });
  });

  it("creates a checkout on the connected account, posts a card message, and the webhook turns it paid exactly once", async () => {
    const t = await setup({ CONNECT_APPLICATION_FEE_BPS: "100" });
    const { acct } = await connected(t);
    await enable(t, acct);
    const { room } = await mkRoom(t.ctx, t.wsId);
    const r = await t.http.post(`/api/rooms/${room.id}/payment-requests`, { amount: 2500, currency: "usd", description: "Deposit for the install" }, t.token);
    expect(r.status).toBe(201);
    const pr = r.body.request;
    expect(pr).toMatchObject({ amount: 2500, currency: "usd", status: "open", room_id: room.id });
    const session = [...t.billing.sessions.values()].at(-1)!;
    expect(session.account).toBe(acct);
    expect(session.input).toMatchObject({ amountCents: 2500, feeCents: 25, metadata: { payment_request_id: pr.id, workspace_id: t.wsId, room_id: room.id } });

    const m = await messageOf(t, r.body.message_id);
    expect(m.content_text).toContain("Payment request: Deposit for the install - $25.00");
    expect(m.content_text).toContain(session.url);
    expect(JSON.parse(m.meta).card).toMatchObject({ type: "payment_request", id: pr.id, status: "open", amount: 2500, url: session.url });
    // the visitor's copy carries the card (that is how the widget renders the Pay button) but none of the team-only meta
    expect(visitorMessageDto(t.ctx, m, 0).meta).toMatchObject({ card: { id: pr.id, status: "open" } });

    const done = { id: "evt_paid", type: "checkout.session.completed", account: acct, object: { id: session.id, payment_status: "paid", payment_intent: "pi_cust_1", metadata: { payment_request_id: pr.id, workspace_id: t.wsId } } };
    const emitted: string[] = [];
    const orig = t.ctx.bus.toRoom.bind(t.ctx.bus);
    t.ctx.bus.toRoom = ((ws: string, rid: string, ev: string, ...rest: unknown[]) => (emitted.push(ev), (orig as (...a: unknown[]) => unknown)(ws, rid, ev, ...rest))) as never;
    expect((await t.hook("connect", done)).body.result).toBe("processed");
    expect(emitted).toContain("message:updated");
    expect((await t.hook("connect", done)).body.result).toBe("duplicate");
    expect((await t.hook("connect", { ...done, id: "evt_paid_2", type: "checkout.session.async_payment_succeeded" })).status).toBe(200); // a second event for the same payment
    const fresh = JSON.parse((await messageOf(t, r.body.message_id)).meta).card;
    expect(fresh).toMatchObject({ status: "paid", url: null });
    expect(fresh.paid_at).toBeTruthy();
    const lines = await t.ctx.db.all<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = ? AND sender_type = 'system' AND content_text LIKE 'Payment received%'", room.id);
    expect(lines.map((l) => l.content_text)).toEqual(["Payment received: $25.00 (Deposit for the install)"]);
    expect(await t.notifications("payment_received")).toHaveLength(1);
    const list = await t.http.get(`/api/rooms/${room.id}/payment-requests`, t.token);
    expect(list.body.data[0]).toMatchObject({ id: pr.id, status: "paid", url: null });
  });

  it("an event from one workspace's connected account cannot touch another workspace's request", async () => {
    const a = await setup();
    const { acct: acctA } = await connected(a);
    await enable(a, acctA);
    const { room } = await mkRoom(a.ctx, a.wsId);
    const r = await a.http.post(`/api/rooms/${room.id}/payment-requests`, { amount: 1000, description: "x" }, a.token);
    const session = [...a.billing.sessions.values()].at(-1)!;
    // a second connected account (same platform) claims to have been paid for A's request
    const other = await a.ctx.db.run("INSERT INTO billing_accounts(workspace_id, plan, status, connect_account_id, connect_charges_enabled, created_at, updated_at) SELECT id, 'free', 'none', 'acct_other', 1, ?, ? FROM workspaces WHERE id <> ? LIMIT 1", "x", "x", a.wsId).catch(() => ({ changes: 0 }));
    const w2 = await seedWorkspace(a.ctx, "Other");
    await a.ctx.db.run("INSERT INTO billing_accounts(workspace_id, plan, status, connect_account_id, connect_charges_enabled, created_at, updated_at) VALUES (?, 'free', 'none', 'acct_other', 1, 'x', 'x')", w2.wsId);
    void other;
    const res = await a.hook("connect", { type: "checkout.session.completed", account: "acct_other", object: { id: session.id, payment_status: "paid", metadata: { payment_request_id: r.body.request.id, workspace_id: a.wsId } } });
    expect(res.body.result).toBe("ignored");
    expect((await a.ctx.db.get<{ status: string }>("SELECT status FROM payment_requests WHERE id = ?", r.body.request.id))!.status).toBe("open");
    // and an event for an account we do not know at all is ignored
    expect((await a.hook("connect", { type: "checkout.session.completed", account: "acct_nobody", object: { id: session.id, payment_status: "paid", metadata: { payment_request_id: r.body.request.id } } })).body.result).toBe("ignored");
  });

  it("expiry, refund (full only) and cancellation update the card", async () => {
    const t = await setup();
    const { acct } = await connected(t);
    await enable(t, acct);
    const { room } = await mkRoom(t.ctx, t.wsId);
    const mk = async (amount: number) => {
      const r = await t.http.post(`/api/rooms/${room.id}/payment-requests`, { amount, description: `job ${amount}` }, t.token);
      return { id: r.body.request.id as string, msg: r.body.message_id as string, session: [...t.billing.sessions.values()].at(-1)! };
    };
    const card = async (msg: string) => JSON.parse((await messageOf(t, msg)).meta).card;

    const a = await mk(1000);
    await t.hook("connect", { type: "checkout.session.expired", account: acct, object: { id: a.session.id, metadata: { payment_request_id: a.id } } });
    expect((await card(a.msg)).status).toBe("expired");
    expect((await t.http.post(`/api/payment-requests/${a.id}/cancel`, {}, t.token)).status).toBe(409);

    const b = await mk(2000);
    await t.hook("connect", { type: "checkout.session.completed", account: acct, object: { id: b.session.id, payment_status: "paid", payment_intent: "pi_b", metadata: { payment_request_id: b.id } } });
    await t.hook("connect", { type: "charge.refunded", account: acct, object: { payment_intent: "pi_b", amount_refunded: 500 } });
    expect((await card(b.msg)).status).toBe("paid"); // partial refund: still paid
    await t.hook("connect", { type: "charge.refunded", account: acct, object: { payment_intent: "pi_b", amount_refunded: 2000 } });
    expect((await card(b.msg)).status).toBe("refunded");

    const c = await mk(3000);
    const cancelled = await t.http.post(`/api/payment-requests/${c.id}/cancel`, {}, t.token);
    expect([cancelled.status, cancelled.body.status]).toEqual([200, "canceled"]);
    expect(c.session.expired).toBe(true);
    expect((await card(c.msg)).status).toBe("canceled");
    expect((await card(c.msg)).url).toBeNull();
    // a payment racing a cancellation still lands: money received is never ignored
    await t.hook("connect", { type: "checkout.session.completed", account: acct, object: { id: c.session.id, payment_status: "paid", metadata: { payment_request_id: c.id } } });
    expect((await card(c.msg)).status).toBe("paid");
  });

  it("validates amount, currency and description; and respects who may see the room and who may request payments", async () => {
    const t = await setup();
    const { acct } = await connected(t);
    await enable(t, acct);
    const { room } = await mkRoom(t.ctx, t.wsId);
    const post = (body: unknown, token = t.token, id = room.id) => t.http.post(`/api/rooms/${id}/payment-requests`, body, token);
    for (const bad of [{ amount: 49, description: "x" }, { amount: 100_000_000, description: "x" }, { amount: 10.5, description: "x" }, { amount: 100, description: "" }, { amount: 100, description: "x", currency: "dollars" }, { amount: 100 }]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const agent = await addMemberRaw(t.ctx, t.wsId, { role: "agent" }); // not assigned to the room
    const agentToken = await tokenFor(t.ctx, agent);
    expect((await post({ amount: 1000, description: "x" }, agentToken)).status).toBe(404); // cannot see the room, so it does not exist for them
    const viewer = await addMemberRaw(t.ctx, t.wsId, { role: "agent" });
    await setMemberRole(t.ctx, t.owner, viewer.memberId, "role_viewer");
    const viewerToken = await tokenFor(t.ctx, actorFromRow(await getMember(t.ctx, t.wsId, viewer.memberId)));
    expect((await post({ amount: 1000, description: "x" }, viewerToken)).body.error.code).toBe("PERMISSION_DENIED");
    expect((await t.http.get(`/api/rooms/${room.id}/payment-requests`, viewerToken)).status).toBe(200); // viewers can see them, not create them
    expect((await post({ amount: 1000, description: "x" }, t.token, "room_missing")).status).toBe(404);
  });

  it("a request whose message could not be sent leaves no live payment link behind", async () => {
    const t = await setup();
    const { acct } = await connected(t);
    await enable(t, acct);
    const { room } = await mkRoom(t.ctx, t.wsId, { contact: { name: "No phone", email: "np@example.test" } });
    const r = await t.http.post(`/api/rooms/${room.id}/payment-requests`, { amount: 1000, description: "x", source: "sms" }, t.token);
    expect(r.status).toBe(422); // contact has no phone
    const row = await t.ctx.db.get<{ status: string }>("SELECT status FROM payment_requests WHERE room_id = ?", room.id);
    expect(row!.status).toBe("canceled");
    expect([...t.billing.sessions.values()].at(-1)!.expired).toBe(true);
  });

  it("payment requests are rate limited per workspace and plan", async () => {
    const t = await setup();
    const { acct } = await connected(t);
    await enable(t, acct);
    const { room } = await mkRoom(t.ctx, t.wsId);
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await t.http.post(`/api/rooms/${room.id}/payment-requests`, { amount: 1000 + i, description: "x" }, t.token)).status === 429) limited++;
    expect(limited).toBe(5); // free plan: 20 per hour
  });
});

describe("ledger idempotency", () => {
  it("two concurrent deliveries of the same business event add the credits once", async () => {
    const t = await setup();
    const { applyLedger } = await import("../src/services/workspaces.js");
    const results = await Promise.all(Array.from({ length: 8 }, () => applyLedger(t.ctx, t.wsId, "topup", 100, { idemKey: "same" })));
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await t.balance()).toBe(100);
  });
});

void setSettings;
