import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import AdminApp from "./AdminApp";
import { getAdminToken, setAdminToken } from "./adminApi";

type Call = { method: string; path: string; body: any; auth: string | null; headers: Record<string, string> };
let calls: Call[];
let role: "superadmin" | "support";
let enrolled: boolean;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const detail = {
  id: "ws_1", name: "Acme Plumbing", plan: "pro", created_at: "2026-03-01T10:00:00.000Z", suspended: false, suspended_reason: null, credit_balance: 120, seats: { used: 2, limit: 10 },
  billing: { status: "active", current_period_end: null, grace_until: null, cancel_at_period_end: false, auto_recharge: false, connect_charges_enabled: false }, tier_override: null,
  usage_30d: { conversations_started: 4, messages_in_those_conversations: 19 }, totals: { rooms: 9, contacts: 7 },
  members: [{ id: "m1", name: "Olivia", email: "olivia@acme.test", role: "owner", live_seat: true }], ledger: [], audit: [],
};

function install() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace("/admin/api", "");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const c: Call = { method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body as string) : undefined, auth: headers.Authorization ?? null, headers };
      calls.push(c);
      const key = `${c.method} ${path.split("?")[0]}`;
      if (key === "POST /login") return json(enrolled ? { mfa_required: true, mfa_token: "step-token-verify-xxxxxxxxxxxxxxxx" } : { mfa_setup_required: true, mfa_token: "step-token-enrol-xxxxxxxxxxxxxxxxx" });
      if (key === "POST /mfa/setup") return json({ secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/x" });
      if (key === "POST /mfa/enable" || key === "POST /mfa/verify") return c.body.code === "123456" ? json({ token: "admin-access-token", expires_in: 1800, admin: { id: "adm_1", email: "ops@example.test", name: "Ops", role } }) : json({ error: { code: "INVALID_CODE", message: "That code is not valid" } }, 401);
      if (key === "GET /stats") return json({ workspaces: 42, suspended: 1, new_last_7_days: 3, members: 120, past_due: 2, credits_outstanding: 9000, by_plan: {} });
      if (key === "GET /workspaces") return json({ data: [{ id: "ws_1", name: "Acme Plumbing", plan: "pro", created_at: "2026-03-01T10:00:00.000Z", suspended: false, credit_balance: 120, members: 2, billing_status: "active" }], next_cursor: null });
      if (key === "POST /monitoring/test") return json({ enabled: false, delivered: false });
      if (key === "GET /workspaces/ws_1") return json(detail);
      if (key === "POST /workspaces/ws_1/impersonate") return json({ token: "imp.token.value", expires_in: 900, read_only: true });
      if (key.startsWith("POST /workspaces/ws_1/")) return new Response(null, { status: 204 });
      return json({ error: { code: "NOT_FOUND", message: "x" } }, 404);
    }),
  );
}

function mount(path = "/admin") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/*" element={<AdminApp />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const signIn = async () => {
  await userEvent.type(screen.getByLabelText("Email"), "ops@example.test");
  await userEvent.type(screen.getByLabelText("Password"), "a very long password");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
};

describe("platform console", () => {
  beforeEach(() => {
    calls = [];
    role = "superadmin";
    enrolled = true;
    setAdminToken(null);
    install();
  });

  it("asks for the password and then the authenticator code, and keeps the token in memory only", async () => {
    mount();
    await signIn();
    expect(await screen.findByRole("heading", { name: "Enter your code" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull(); // the password is gone from the screen
    await userEvent.type(screen.getByLabelText("6-digit code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid/i);
    await userEvent.clear(screen.getByLabelText("6-digit code"));
    await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("navigation", { name: "Platform console" })).toBeInTheDocument();
    expect(getAdminToken()).toBe("admin-access-token");
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("admin-access-token");
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("admin-access-token");
    expect((await screen.findAllByText("Acme Plumbing")).length).toBeGreaterThan(0);
    expect(calls.find((c) => c.path === "/stats")!.auth).toBe("Bearer admin-access-token");
  });

  it("an operator that has not enrolled sees the key to add to an authenticator before anything else", async () => {
    enrolled = false;
    mount();
    await signIn();
    expect(await screen.findByRole("heading", { name: "Set up your authenticator" })).toBeInTheDocument();
    expect(screen.getByTestId("totp-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    expect(calls.some((c) => c.path === "/stats")).toBe(false);
    await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("navigation", { name: "Platform console" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/mfa/enable")).toBe(true);
  });

  async function open(path: string) {
    mount();
    await signIn();
    await userEvent.type(await screen.findByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByRole("navigation", { name: "Platform console" });
    if (path !== "/admin") await userEvent.click(await screen.findByRole("link", { name: "Acme Plumbing" }));
  }

  it("a superadmin must give a reason before suspending, and the reason is sent", async () => {
    await open("/admin/workspaces/ws_1");
    const suspend = await screen.findByRole("button", { name: /suspend workspace/i });
    expect(suspend).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^reason$/i), "chargeback fraud");
    expect(suspend).toBeEnabled();
    await userEvent.click(suspend);
    await userEvent.click(await screen.findByRole("button", { name: /confirm suspension/i }));
    await waitFor(() => expect(calls.find((c) => c.path === "/workspaces/ws_1/suspend")?.body).toEqual({ reason: "chargeback fraud" }));
  });

  it("adjusts credits with an idempotency key so a double click cannot grant twice", async () => {
    await open("/admin/workspaces/ws_1");
    await userEvent.type(await screen.findByLabelText(/^reason$/i), "goodwill after outage");
    await userEvent.type(screen.getByLabelText(/credits to add/i), "250");
    await userEvent.click(screen.getByRole("button", { name: /adjust credits/i }));
    await waitFor(() => expect(calls.some((c) => c.path === "/workspaces/ws_1/credits")).toBe(true));
    const c = calls.find((x) => x.path === "/workspaces/ws_1/credits")!;
    expect(c.body).toEqual({ amount: 250, note: "goodwill after outage" });
    expect(c.headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("a superadmin can send a test error and is told plainly when monitoring is not configured", async () => {
    await open("/admin");
    await userEvent.click(await screen.findByRole("link", { name: "Monitoring" }));
    await userEvent.click(await screen.findByRole("button", { name: "Send a test error" }));
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/monitoring/test")).toBe(true);
  });

  it("a support operator sees the account but none of the change controls", async () => {
    role = "support";
    await open("/admin/workspaces/ws_1");
    expect(await screen.findByText(/2 of 10 seats/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /read-only support view/i })).toBeInTheDocument();
    for (const name of [/suspend workspace/i, /adjust credits/i, /set tier override/i]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("link", { name: "Operators" })).not.toBeNull();
  });

  it("opens the support view in a new tab with the token in the fragment, never in the query string", async () => {
    const open_ = vi.fn();
    vi.stubGlobal("open", open_);
    await open("/admin/workspaces/ws_1");
    await userEvent.type(await screen.findByLabelText(/^reason$/i), "ticket 4411");
    await userEvent.click(screen.getByRole("button", { name: /read-only support view/i }));
    await waitFor(() => expect(open_).toHaveBeenCalled());
    const [url, target, features] = open_.mock.calls[0]!;
    expect(url).toBe("/impersonate#token=imp.token.value");
    expect([target, features]).toEqual(["_blank", "noopener,noreferrer"]);
    expect(calls.find((c) => c.path === "/workspaces/ws_1/impersonate")!.body).toEqual({ reason: "ticket 4411" });
  });

  it("signs the operator out when the token ends mid-session", async () => {
    mount();
    await signIn();
    await userEvent.type(await screen.findByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByRole("navigation", { name: "Platform console" });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } }, 401));
    await userEvent.click(within(screen.getByRole("navigation")).getByRole("link", { name: "Audit log" }));
    expect(await screen.findByRole("heading", { name: /operator sign-in/i })).toBeInTheDocument();
    expect(getAdminToken()).toBeNull();
  });
});
