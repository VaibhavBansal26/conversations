import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingSettings } from "./BillingSettings";

let allowed = true;
vi.mock("../../auth/AuthContext", () => ({ useCan: () => allowed }));

const base = {
  configured: true,
  plan: { id: "free", name: "Free", seats: 3, seats_used: 2, monthly_credits: 0, price_cents: 0 },
  plans: [
    { id: "free", name: "Free", seats: 3, monthlyCredits: 0, priceCents: 0 },
    { id: "pro", name: "Pro", seats: 10, monthlyCredits: 500, priceCents: 4900 },
  ],
  status: "none",
  access: "ok",
  grace_until: null,
  current_period_end: null,
  cancel_at_period_end: false,
  credit_balance: 120,
  credit_price_cents: 2,
  currency: "usd",
  packs: [{ id: "pack_1000", credits: 1000, amount_cents: 2000 }],
  payment_method: null,
  automation: { auto_recharge_enabled: false, auto_recharge_threshold: 0, auto_recharge_credits: 0, low_balance_threshold: 0 },
  connect: { connected: false, charges_enabled: false },
};

let summary: Record<string, unknown> = base;
const calls: { url: string; method: string; body?: string }[] = [];
const assign = vi.fn();

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      const path = new URL(url, "http://x").pathname;
      if (path.endsWith("/billing/checkout/topup") || path.endsWith("/billing/portal") || path.endsWith("/billing/checkout/subscription")) return new Response(JSON.stringify({ url: "https://checkout.stripe.test/s" }), { status: 200, headers: { "content-type": "application/json" } });
      if (path.endsWith("/credits")) return new Response(JSON.stringify({ balance: 120, ledger: [] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(summary), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.stubGlobal("location", { ...window.location, assign, search: "" });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BillingSettings />
    </QueryClientProvider>,
  );
}

describe("BillingSettings", () => {
  beforeEach(() => {
    allowed = true;
    summary = base;
    calls.length = 0;
    assign.mockClear();
  });

  it("explains itself to someone without the billing permission and calls nothing", () => {
    allowed = false;
    mount();
    expect(screen.getByText(/need the billing permission/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("shows plan, seats and credits, and sends the buyer to Stripe Checkout for a pack", async () => {
    mount();
    expect(await screen.findByText(/2 of 3 seats used/)).toBeInTheDocument();
    expect(screen.getByText(/credits remaining/)).toHaveTextContent("120");
    await userEvent.click(screen.getByRole("button", { name: /1,000 credits/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/s"));
    const post = calls.find((c) => c.url.endsWith("/billing/checkout/topup"))!;
    expect(JSON.parse(post.body!)).toEqual({ pack: "pack_1000" });
  });

  it("only offers a custom amount inside the allowed range", async () => {
    mount();
    await screen.findByText(/2 of 3 seats used/);
    const buy = screen.getByRole("button", { name: /^buy credits$/i });
    expect(buy).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/custom number of credits/i), "50");
    expect(screen.getByRole("button", { name: /^buy credits$/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/custom number of credits/i));
    await userEvent.type(screen.getByLabelText(/custom number of credits/i), "2500");
    expect(screen.getByRole("button", { name: /buy 2,500 credits/i })).toBeEnabled();
  });

  it("auto-recharge needs a saved card", async () => {
    mount();
    await screen.findByText(/2 of 3 seats used/);
    expect(screen.getByRole("switch", { name: /auto-recharge/i })).toBeDisabled();
    expect(screen.getByText(/no saved card yet/i)).toBeInTheDocument();
  });

  it("with a saved card, saving sends the automation settings", async () => {
    summary = { ...base, payment_method: { brand: "visa", last4: "4242" } };
    mount();
    expect(await screen.findByText(/visa ending 4242/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: /auto-recharge/i }));
    await userEvent.type(screen.getByLabelText(/recharge when credits fall to/i), "100");
    await userEvent.type(screen.getByLabelText(/credits to buy each time/i), "1000");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toMatchObject({ auto_recharge_enabled: true, auto_recharge_threshold: 100, auto_recharge_credits: 1000 });
  });

  it("warns during grace and says what is paused once locked, with a way to fix it", async () => {
    summary = { ...base, access: "grace", grace_until: "2026-03-09T10:00:00.000Z", status: "past_due" };
    const { unmount } = mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(/keeps working until/i);
    unmount();
    summary = { ...base, access: "locked", status: "past_due", grace_until: "2026-03-09T10:00:00.000Z" };
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(/paused/i);
    await userEvent.click(screen.getByRole("button", { name: /update payment method/i }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });

  it("tells the user when online payments are not set up on this server", async () => {
    summary = { ...base, configured: false };
    mount();
    expect(await screen.findByText(/not set up on this server/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1,000 credits/ })).toBeDisabled();
  });

  it("connect shows the three states", async () => {
    summary = { ...base, connect: { connected: true, charges_enabled: false } };
    const { unmount } = mount();
    expect(await screen.findByText(/still needs details/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue setup/i })).toBeInTheDocument();
    unmount();
    summary = { ...base, connect: { connected: true, charges_enabled: true } };
    mount();
    expect(await screen.findByText(/ready to take payments/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect stripe account|continue setup/i })).toBeNull();
  });
});
