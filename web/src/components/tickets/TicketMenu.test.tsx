import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TicketBrief } from "../../api/types";
import { TicketMenu } from "./TicketMenu";

let allowed = new Set<string>();
vi.mock("../../auth/AuthContext", () => ({ useCan: (p: string) => allowed.has(p) }));

const ticket = (over: Partial<TicketBrief> = {}): TicketBrief => ({ id: "tkt_1", number: 12, status: "open", handler: null, department_id: null, priority: 1, subject: "Invoice", ...over });
const calls: { url: string; method: string; body?: string }[] = [];

function mount(t: TicketBrief) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TicketMenu ticket={t} />
    </QueryClientProvider>,
  );
}

describe("TicketMenu", () => {
  beforeEach(() => {
    calls.length = 0;
    allowed = new Set(["tickets:write", "tickets:close"]);
  });

  it("shows only the chip to a seat that can neither edit nor close", () => {
    allowed = new Set();
    mount(ticket());
    expect(screen.getByText("#12")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("resolves an open ticket", async () => {
    mount(ticket());
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Mark as resolved/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/tickets/tkt_1/resolve") && c.method === "POST")).toBe(true));
  });

  it("offers close and reopen for a resolved ticket, and priority only while it is live", async () => {
    mount(ticket({ status: "resolved" }));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    expect(await screen.findByRole("menuitem", { name: /Close ticket/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Reopen/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Urgent" })).toBeNull();
  });

  it("sets the priority and toggles waiting for the customer", async () => {
    mount(ticket());
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Urgent" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toBe(JSON.stringify({ priority: 3 })));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Waiting for the customer/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")[1]?.body).toBe(JSON.stringify({ status: "pending_customer" })));
  });
});
