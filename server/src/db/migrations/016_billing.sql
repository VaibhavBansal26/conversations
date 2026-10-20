-- Billing: one account row per workspace (Stripe customer + subscription state + credit automation + Connect), an event journal that makes
-- webhooks idempotent, and customer payment requests. Money amounts are integers in the currency's minor unit; credits are integers.

CREATE TABLE billing_accounts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  -- none = never subscribed; active/trialing/past_due/unpaid/canceled mirror Stripe
  status TEXT NOT NULL DEFAULT 'none',
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  -- set when a payment fails; the workspace keeps working until this passes, then it is soft-locked (see billing/state.ts)
  grace_until TEXT,
  payment_method_id TEXT,
  payment_method_brand TEXT,
  payment_method_last4 TEXT,
  auto_recharge_enabled INTEGER NOT NULL DEFAULT 0,
  auto_recharge_threshold INTEGER NOT NULL DEFAULT 0,
  auto_recharge_credits INTEGER NOT NULL DEFAULT 0,
  auto_recharge_failures INTEGER NOT NULL DEFAULT 0,
  low_balance_threshold INTEGER NOT NULL DEFAULT 0,
  low_balance_notified_at TEXT,
  -- unix seconds of the newest customer.subscription.* event applied: Stripe does not guarantee delivery order, an older event must not undo a newer one
  sub_event_at INTEGER NOT NULL DEFAULT 0,
  connect_account_id TEXT,
  connect_charges_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_billing_customer ON billing_accounts(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX ux_billing_connect ON billing_accounts(connect_account_id) WHERE connect_account_id IS NOT NULL;
CREATE INDEX ix_billing_subscription ON billing_accounts(stripe_subscription_id);

-- Every Stripe event id is recorded before it is applied; a redelivery finds the row and is acknowledged without doing the work twice.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  account TEXT,
  workspace_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

-- Credits are only ever added once per business event: the idempotency key (Stripe session / invoice / payment intent id) is unique per workspace.
ALTER TABLE usage_ledger ADD COLUMN idem_key TEXT;
CREATE UNIQUE INDEX ux_ledger_idem ON usage_ledger(workspace_id, idem_key) WHERE idem_key IS NOT NULL;

CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  message_id TEXT,
  contact_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  -- open -> paid | expired | canceled | refunded
  status TEXT NOT NULL DEFAULT 'open',
  checkout_session_id TEXT,
  payment_intent_id TEXT,
  connect_account_id TEXT NOT NULL,
  url TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  paid_at TEXT,
  refunded_at TEXT
);
CREATE INDEX ix_payreq_ws ON payment_requests(workspace_id, created_at);
CREATE INDEX ix_payreq_room ON payment_requests(room_id, created_at);
CREATE UNIQUE INDEX ux_payreq_session ON payment_requests(checkout_session_id) WHERE checkout_session_id IS NOT NULL;
