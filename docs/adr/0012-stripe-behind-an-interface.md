# 0012. Stripe behind an interface, with an event journal and idempotent ledger

Status: accepted

## Context

The product takes money three ways: subscriptions and prepaid credits (the workspace pays the platform) and customer payments (the customer pays the workspace). Stripe delivers webhooks at least once, out of order, and sometimes twice under different event ids for one payment. There is no Stripe account in the development environment or in CI.

## Decision

* One `BillingProvider` interface is the only code that knows Stripe. Implementations: the real SDK, an in-memory fake that builds correctly signed events, and a null provider that answers 503 when no key is configured.
* Every Stripe event id is inserted into `stripe_events` before it is applied. A redelivery is acknowledged without doing the work; a failed attempt is claimed and re-run.
* Every credit movement carries an idempotency key derived from the Stripe object (`cs:`, `inv:`, `pi:`) with a unique index on `(workspace_id, idem_key)`, so the same payment seen through two events, or through a webhook and a background job, credits once.
* Subscription events carry a timestamp and an older event never overwrites a newer state.
* The soft lock is derived lazily from `grace_until` and the clock; there is no sweep job that can miss it.
* Customer payments use Connect Standard direct charges on the workspace's own account, matched to our request id and to the account the event came from.

## Alternatives

* Calling the SDK from services: untestable without Stripe, and every test would need network access.
* Deduplicating only with an in-memory set or only with handler idempotency: the first loses on restart, the second leaves races between a webhook and a job.
* Destination charges on the platform account: the platform would carry the customers' disputes and funds flow.

## Consequences

Billing is fully testable offline (40 tests: scenarios plus request shapes against a recording SDK stub). The price is that the real Stripe API is exercised only by a manual run in Stripe test mode, which [STRIPE.md](../STRIPE.md) lists as the verification step before going live.
