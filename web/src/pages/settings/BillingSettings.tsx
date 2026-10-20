import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useCredits } from "../../api/settingsHooks";
import { useCan } from "../../auth/AuthContext";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { AlertTriangle, CreditCard, Check, Info } from "lucide-react";
import { Badge, Button, Card, ErrorNotice, Field, Input, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, cn, toast } from "../../ui";
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
      toast({ title: "Billing settings saved", tone: "success" });
    },
  });

  if (q.isPending)
    return (
      <div role="status" aria-label="Loading billing" className="flex flex-col gap-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  if (q.isError || !s) return <ErrorNotice error={q.error} />;

  const money = (c: number) => formatMoney(c, s.currency);
  const customCredits = Number(custom);
  const seatPct = Math.min(100, (s.plan.seats_used / Math.max(1, s.plan.seats)) * 100);

  return (
    <div className="flex flex-col gap-6">
      {!s.configured && (
        <p className="flex items-start gap-2.5 rounded-lg border border-border bg-info-soft px-4 py-3 text-sm text-info-text" role="note">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Online payments are not set up on this server (no Stripe account is connected), so plans and top-ups are unavailable. Credits can be added by an owner under General settings.
        </p>
      )}
      {s.access !== "ok" && (
        <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm", s.access === "locked" ? "border-danger/40 bg-danger-soft text-danger-text" : "border-warning-border bg-warning-soft text-warning-text")} role="alert">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {s.access === "locked"
              ? "Your last payment failed and the grace period has ended, so SMS, email and new seats are paused. Chat and reading conversations still work. Update your payment method to resume."
              : `Your last payment failed. Everything keeps working until ${formatDateTime(s.grace_until!)}; update your payment method before then.`}
          </span>
          <Button size="sm" variant="outline" onClick={() => redirect.mutate({ path: "/billing/portal", body: {} })}>
            Update payment method
          </Button>
        </div>
      )}

      <SettingsSection title="Plan" description="Higher plans raise seat, message, API and AI limits.">
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            <strong className="text-base">{s.plan.name}</strong> · {s.plan.seats_used} of {s.plan.seats} seats used
            {s.plan.monthly_credits > 0 && ` · ${s.plan.monthly_credits} credits every month`}
          </p>
          <div className="h-2 max-w-md overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Seats used" aria-valuemin={0} aria-valuemax={s.plan.seats} aria-valuenow={s.plan.seats_used}>
            <div className={cn("h-full rounded-full", seatPct >= 100 ? "bg-danger" : "bg-primary")} style={{ width: `${seatPct}%` }} />
          </div>
          {s.current_period_end && (
            <p className="text-[13px] text-muted-foreground">
              {s.cancel_at_period_end ? "Ends" : "Renews"} on {formatDateTime(s.current_period_end)} ({s.status.replace("_", " ")})
            </p>
          )}
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {s.plans
            .filter((p) => p.id !== "free")
            .map((p) => {
              const current = s.plan.id === p.id;
              return (
                <li key={p.id}>
                  <Card className={cn("flex h-full flex-col gap-1.5 p-4", current && "border-primary ring-1 ring-primary")}>
                    <div className="flex items-center justify-between">
                      <strong className="text-[15px]">{p.name}</strong>
                      {current && (
                        <Badge tone="primary">
                          <Check className="size-3" aria-hidden="true" /> Current plan
                        </Badge>
                      )}
                    </div>
                    <span className="text-2xl font-semibold tabular-nums">
                      {money(p.priceCents)} <span className="text-sm font-normal text-muted-foreground">per month</span>
                    </span>
                    <span className="mb-2 text-[13px] text-muted-foreground">
                      {p.seats} seats · {p.monthlyCredits} credits a month
                    </span>
                    {!current && (
                      <Button size="sm" className="mt-auto" disabled={!s.configured || redirect.isPending || s.status === "active"} onClick={() => redirect.mutate({ path: "/billing/checkout/subscription", body: { plan: p.id } })}>
                        Choose {p.name}
                      </Button>
                    )}
                  </Card>
                </li>
              );
            })}
        </ul>
        {s.status === "active" || s.status === "past_due" ? (
          <div>
            <Button variant="outline" disabled={redirect.isPending} onClick={() => redirect.mutate({ path: "/billing/portal", body: {} })}>
              <CreditCard aria-hidden="true" /> Manage subscription, invoices and card
            </Button>
          </div>
        ) : null}
        {redirect.isError && <ErrorNotice error={redirect.error} compact />}
      </SettingsSection>

      <SettingsSection title="Credits" description={`Each SMS or email uses credits. One credit costs ${(s.credit_price_cents / 100).toFixed(2)} ${s.currency.toUpperCase()}.`}>
        <p className="text-sm">
          <strong className="text-3xl font-semibold tabular-nums">{s.credit_balance}</strong> credits remaining
        </p>
        <div className="flex flex-wrap gap-2">
          {s.packs.map((p) => (
            <Button key={p.id} variant="outline" disabled={!s.configured || redirect.isPending} onClick={() => redirect.mutate({ path: "/billing/checkout/topup", body: { pack: p.id } })}>
              {p.credits.toLocaleString()} credits · {money(p.amount_cents)}
            </Button>
          ))}
        </div>
        <form
          className="flex max-w-lg flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (Number.isInteger(customCredits)) redirect.mutate({ path: "/billing/checkout/topup", body: { credits: customCredits } });
          }}
        >
          <label className="sr-only" htmlFor="custom-credits">
            Custom number of credits
          </label>
          <Input id="custom-credits" className="min-w-0 flex-1 basis-56" type="number" min={100} max={100000} step={1} value={custom} placeholder="Other amount (100 to 100,000)" onChange={(e) => setCustom(e.target.value)} />
          <Button type="submit" variant="outline" disabled={!s.configured || !(customCredits >= 100 && customCredits <= 100000 && Number.isInteger(customCredits)) || redirect.isPending}>
            Buy {customCredits >= 100 && customCredits <= 100000 ? `${customCredits.toLocaleString()} credits` : "credits"}
          </Button>
        </form>
        {ledger.data && ledger.data.ledger.length > 0 && (
          <Table>
            <caption className="sr-only">Recent credit activity</caption>
            <TableHead>
              <TableRow>
                {["When", "Type", "Change", "Balance"].map((h) => (
                  <TableHeaderCell key={h} scope="col">
                    {h}
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {ledger.data.ledger.slice(0, 10).map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(l.created_at)}</TableCell>
                  <TableCell>{l.kind}</TableCell>
                  <TableCell className={cn("tabular-nums", l.delta > 0 ? "text-success-text" : "text-danger-text")}>{l.delta > 0 ? `+${l.delta}` : l.delta}</TableCell>
                  <TableCell className="tabular-nums">{l.balance_after}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsSection>

      <SettingsSection title="Low balance and auto-recharge" description="Get told before sending stops, or let the saved card top up for you.">
        <form
          className="flex max-w-md flex-col gap-4"
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
            <Input type="number" min={0} value={low} onChange={(e) => setLow(e.target.value)} />
          </Field>
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <CreditCard className="size-4 shrink-0" aria-hidden="true" />
            {s.payment_method ? `Saved card: ${s.payment_method.brand} ending ${s.payment_method.last4}` : "No saved card yet. Buy credits once and the card is kept for auto-recharge."}
          </p>
          <Switch label="Auto-recharge" hint="Charge the saved card automatically when the balance runs low." checked={auto.enabled} disabled={!s.payment_method} onChange={(enabled) => setAuto((a) => ({ ...a, enabled }))} />
          {auto.enabled && (
            <>
              <Field label="Recharge when credits fall to">
                <Input type="number" min={1} value={auto.threshold} onChange={(e) => setAuto((a) => ({ ...a, threshold: e.target.value }))} required />
              </Field>
              <Field label="Credits to buy each time" hint="100 to 100,000">
                <Input type="number" min={100} max={100000} value={auto.credits} onChange={(e) => setAuto((a) => ({ ...a, credits: e.target.value }))} required />
              </Field>
            </>
          )}
          {save.isError && <ErrorNotice error={save.error} />}
          <div className="flex items-center gap-3">
            <Button type="submit" loading={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <span className="text-[13px] text-success-text" role="status">
              {save.isSuccess ? "Saved" : ""}
            </span>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Get paid by customers" description="Connect your own Stripe account to send payment requests inside a conversation. Payments go straight to your Stripe account.">
        <p className="flex items-center gap-2 text-sm">
          <Badge tone={s.connect.connected && s.connect.charges_enabled ? "success" : s.connect.connected ? "warning" : "neutral"}>{s.connect.connected ? (s.connect.charges_enabled ? "Ready" : "Action needed") : "Off"}</Badge>
          {!s.connect.connected ? "Not connected" : s.connect.charges_enabled ? "Connected and ready to take payments" : "Connected, but Stripe still needs details before you can take payments"}
        </p>
        <div className="flex flex-wrap gap-2">
          {!(s.connect.connected && s.connect.charges_enabled) && (
            <Button disabled={!s.configured || redirect.isPending} onClick={() => redirect.mutate({ path: "/billing/connect/onboard", body: {} })}>
              {s.connect.connected ? "Continue setup with Stripe" : "Connect Stripe account"}
            </Button>
          )}
          {s.connect.connected && (
            <Button variant="outline" onClick={() => void api.post("/billing/connect/refresh", {}).then(() => qc.invalidateQueries({ queryKey: keys.billing }))}>
              Check status
            </Button>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
