import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useCredits } from "../../api/settingsHooks";
import { useCan } from "../../auth/AuthContext";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../ui";
import { Field } from "../../ui";
import { Switch } from "../../ui";
import { formatDateTime } from "../../lib/time";
import { formatMoney } from "../../lib/money";
import { keys } from "../../state/keys";

interface Summary {
  configured: boolean;
  plan: { id: string; name: string; seats: number; seats_used: number; monthly_credits: number; price_cents: number };
  plans: { id: string; name: string; seats: number; monthlyCredits: number; priceCents: number }[];
  status: string;
  access: "ok" | "grace" | "locked";
  grace_until: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  credit_balance: number;
  credit_price_cents: number;
  currency: string;
  packs: { id: string; credits: number; amount_cents: number }[];
  payment_method: { brand: string; last4: string } | null;
  automation: { auto_recharge_enabled: boolean; auto_recharge_threshold: number; auto_recharge_credits: number; low_balance_threshold: number };
  connect: { connected: boolean; charges_enabled: boolean };
}

const go = (url: string) => window.location.assign(url);

/** Gate: the panel's queries only run for someone who may see billing. */
export function BillingSettings() {
  if (!useCan("billing:manage")) return <SettingsSection title="Billing & credits" description="You need the billing permission to see this page. Ask a workspace owner." children={null} />;
  return <BillingPanel />;
}

function BillingPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.billing, queryFn: () => api.get<Summary>("/billing") });
  const ledger = useCredits();
  const [custom, setCustom] = useState("");
  const [low, setLow] = useState("");
  const [auto, setAuto] = useState({ enabled: false, threshold: "", credits: "" });
  const s = q.data;

  useEffect(() => {
    if (!s) return;
    setLow(String(s.automation.low_balance_threshold || ""));
    setAuto({ enabled: s.automation.auto_recharge_enabled, threshold: String(s.automation.auto_recharge_threshold || ""), credits: String(s.automation.auto_recharge_credits || "") });
  }, [s]);

  // coming back from Stripe: Checkout confirms through a webhook a moment later, so look again a few times; Connect asks Stripe directly
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("connect") === "return") void api.post("/billing/connect/refresh", {}).then(() => qc.invalidateQueries({ queryKey: keys.billing }));
    if (p.get("checkout") === "success") {
      const timers = [1500, 4000, 9000].map((ms) => setTimeout(() => void qc.invalidateQueries({ queryKey: keys.billing }), ms));
      return () => timers.forEach(clearTimeout);
    }
  }, [qc]);

  const redirect = useMutation({ mutationFn: (v: { path: string; body: unknown }) => api.post<{ url: string }>(v.path, v.body), onSuccess: (r) => go(r.url) });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Summary>("/billing/automation", body),
    onSuccess: (r) => {
      qc.setQueryData(keys.billing, r);
      void qc.invalidateQueries({ queryKey: keys.credits });
    },
  });

  if (q.isPending) return <p role="status" className="muted">Loading…</p>;
  if (q.isError || !s) return <ErrorNotice error={q.error} />;

  const money = (c: number) => formatMoney(c, s.currency);
  const customCredits = Number(custom);

  return (
    <>
      {!s.configured && (
        <p className="notice" role="note">
          Online payments are not set up on this server (no Stripe account is connected), so plans and top-ups are unavailable. Credits can be added by an owner under General settings.
        </p>
      )}
      {s.access !== "ok" && (
        <p className={`notice ${s.access === "locked" ? "notice-danger" : "notice-warn"}`} role="alert">
          {s.access === "locked"
            ? "Your last payment failed and the grace period has ended, so SMS, email and new seats are paused. Chat and reading conversations still work. Update your payment method to resume."
            : `Your last payment failed. Everything keeps working until ${formatDateTime(s.grace_until!)}; update your payment method before then.`}
          <button type="button" className="btn btn-sm btn-outline" onClick={() => redirect.mutate({ path: "/billing/portal", body: {} })}>
            Update payment method
          </button>
        </p>
      )}

      <SettingsSection title="Plan" description="Higher plans raise seat, message, API and AI limits.">
        <p className="stat">
          <strong>{s.plan.name}</strong> · {s.plan.seats_used} of {s.plan.seats} seats used
          {s.plan.monthly_credits > 0 && ` · ${s.plan.monthly_credits} credits every month`}
        </p>
        {s.current_period_end && (
          <p className="muted">
            {s.cancel_at_period_end ? "Ends" : "Renews"} on {formatDateTime(s.current_period_end)} ({s.status.replace("_", " ")})
          </p>
        )}
        <ul className="card-list">
          {s.plans
            .filter((p) => p.id !== "free")
            .map((p) => (
              <li key={p.id} className="card column">
                <strong>{p.name}</strong>
                <span>{money(p.priceCents)} per month</span>
                <span className="muted">{p.seats} seats · {p.monthlyCredits} credits a month</span>
                {s.plan.id === p.id ? (
                  <span className="tag">Current plan</span>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" disabled={!s.configured || redirect.isPending || s.status === "active"} onClick={() => redirect.mutate({ path: "/billing/checkout/subscription", body: { plan: p.id } })}>
                    Choose {p.name}
                  </button>
                )}
              </li>
            ))}
        </ul>
        {s.status === "active" || s.status === "past_due" ? (
          <button type="button" className="btn btn-outline" disabled={redirect.isPending} onClick={() => redirect.mutate({ path: "/billing/portal", body: {} })}>
            Manage subscription, invoices and card
          </button>
        ) : null}
        {redirect.isError && <ErrorNotice error={redirect.error} compact />}
      </SettingsSection>

      <SettingsSection title="Credits" description={`Each SMS or email uses credits. One credit costs ${(s.credit_price_cents / 100).toFixed(2)} ${s.currency.toUpperCase()}.`}>
        <p className="stat">
          <strong>{s.credit_balance}</strong> credits remaining
        </p>
        <div className="row wrap">
          {s.packs.map((p) => (
            <button key={p.id} type="button" className="btn btn-outline" disabled={!s.configured || redirect.isPending} onClick={() => redirect.mutate({ path: "/billing/checkout/topup", body: { pack: p.id } })}>
              {p.credits.toLocaleString()} credits · {money(p.amount_cents)}
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (Number.isInteger(customCredits)) redirect.mutate({ path: "/billing/checkout/topup", body: { credits: customCredits } });
          }}
        >
          <label className="sr-only" htmlFor="custom-credits">Custom number of credits</label>
          <input id="custom-credits" type="number" min={100} max={100000} step={1} value={custom} placeholder="Other amount (100 to 100,000)" onChange={(e) => setCustom(e.target.value)} />
          <button type="submit" className="btn btn-outline" disabled={!s.configured || !(customCredits >= 100 && customCredits <= 100000 && Number.isInteger(customCredits)) || redirect.isPending}>
            Buy {customCredits >= 100 && customCredits <= 100000 ? `${customCredits.toLocaleString()} credits` : "credits"}
          </button>
        </form>
        {ledger.data && ledger.data.ledger.length > 0 && (
          <table className="table">
            <caption className="sr-only">Recent credit activity</caption>
            <thead>
              <tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">Change</th><th scope="col">Balance</th></tr>
            </thead>
            <tbody>
              {ledger.data.ledger.slice(0, 10).map((l) => (
                <tr key={l.id}><td>{formatDateTime(l.created_at)}</td><td>{l.kind}</td><td>{l.delta > 0 ? `+${l.delta}` : l.delta}</td><td>{l.balance_after}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsSection>

      <SettingsSection title="Low balance and auto-recharge" description="Get told before sending stops, or let the saved card top up for you.">
        <form
          className="stack narrow"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              low_balance_threshold: Number(low) || 0,
              ...(auto.enabled || s.automation.auto_recharge_enabled ? { auto_recharge_enabled: auto.enabled } : {}),
              ...(auto.threshold ? { auto_recharge_threshold: Number(auto.threshold) } : {}),
              ...(auto.credits ? { auto_recharge_credits: Number(auto.credits) } : {}),
            });
          }}
        >
          <Field label="Email me when credits fall to" hint="0 turns the alert off.">
            <input type="number" min={0} value={low} onChange={(e) => setLow(e.target.value)} />
          </Field>
          <p className="muted">
            {s.payment_method ? `Saved card: ${s.payment_method.brand} ending ${s.payment_method.last4}` : "No saved card yet. Buy credits once and the card is kept for auto-recharge."}
          </p>
          <Switch label="Auto-recharge" hint="Charge the saved card automatically when the balance runs low." checked={auto.enabled} disabled={!s.payment_method} onChange={(enabled) => setAuto((a) => ({ ...a, enabled }))} />
          {auto.enabled && (
            <>
              <Field label="Recharge when credits fall to">
                <input type="number" min={1} value={auto.threshold} onChange={(e) => setAuto((a) => ({ ...a, threshold: e.target.value }))} required />
              </Field>
              <Field label="Credits to buy each time" hint="100 to 100,000">
                <input type="number" min={100} max={100000} value={auto.credits} onChange={(e) => setAuto((a) => ({ ...a, credits: e.target.value }))} required />
              </Field>
            </>
          )}
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
            <span className="saved-note" role="status">{save.isSuccess ? "Saved" : ""}</span>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Get paid by customers" description="Connect your own Stripe account to send payment requests inside a conversation. Payments go straight to your Stripe account.">
        <p className="stat">
          {!s.connect.connected ? "Not connected" : s.connect.charges_enabled ? "Connected and ready to take payments" : "Connected, but Stripe still needs details before you can take payments"}
        </p>
        <div className="row">
          {!(s.connect.connected && s.connect.charges_enabled) && (
            <button type="button" className="btn btn-primary" disabled={!s.configured || redirect.isPending} onClick={() => redirect.mutate({ path: "/billing/connect/onboard", body: {} })}>
              {s.connect.connected ? "Continue setup with Stripe" : "Connect Stripe account"}
            </button>
          )}
          {s.connect.connected && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => void api.post("/billing/connect/refresh", {}).then(() => qc.invalidateQueries({ queryKey: keys.billing }))}
            >
              Check status
            </button>
          )}
        </div>
      </SettingsSection>
    </>
  );
}
