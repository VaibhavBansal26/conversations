import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TicketBrief } from "../../api/types";
import { TicketMenu } from "./TicketMenu";

let allowed = new Set<string>();
vi.mock("../../auth/AuthContext", () => ({ useCan: (p: string) => allowed.has(p), useSession: () => ({ member: { id: "mem_me" } }) }));
vi.mock("../../api/departmentHooks", () => ({
  useDepartmentStatus: () => ({
    data: [
      { id: "inb_sales", name: "Sales", open: true, available_agents: 2, queue_length: 0, estimated_wait_s: null, next_opening: null },
      { id: "inb_bill", name: "Billing", open: false, available_agents: 0, queue_length: 1, estimated_wait_s: null, next_opening: "tomorrow at 09:00 (UTC)" },
    ],
  }),
}));

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

  it("takes a ticket that is waiting for a person, but not one that is already yours", async () => {
    mount(ticket({ status: "waiting_for_human", handler: null }));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Take this ticket/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/tickets/tkt_1/claim") && c.method === "POST")).toBe(true));
  });

  it("does not offer to take your own ticket", async () => {
    mount(ticket({ status: "waiting_for_human", handler: "human:mem_me" }));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    await screen.findByRole("menuitem", { name: /Mark as resolved/ });
    expect(screen.queryByRole("menuitem", { name: /Take this ticket/ })).toBeNull();
  });

  it("transfers to another department, showing who is free there, and leaves the current one out", async () => {
    mount(ticket({ department_id: "inb_sales" }));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    expect(screen.queryByRole("menuitem", { name: /Sales/ })).toBeNull();
    const item = await screen.findByRole("menuitem", { name: /Billing/ });
    expect(item).toHaveTextContent("closed");
    await userEvent.click(item);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/api/tickets/tkt_1/transfer"))?.body).toBe(JSON.stringify({ department_id: "inb_bill" })));
  });

  it("takes over from an AI agent, and hands a ticket back only when the person has it", async () => {
    mount(ticket({ status: "bot_handling", handler: "bot:agt_1" }));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    expect(screen.queryByRole("menuitem", { name: /Hand back/ })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: /Take over from the AI agent/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/tickets/tkt_1/claim"))).toBe(true));
  });

  it("hands the ticket back to the AI agent", async () => {
    mount(ticket({ status: "open", handler: "human:mem_me" }));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Hand back to the AI agent/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/tickets/tkt_1/hand-back") && c.method === "POST")).toBe(true));
  });

  it("does not offer a hand-back for somebody else's ticket", async () => {
    mount(ticket({ status: "open", handler: "human:mem_other" }));
    await userEvent.click(screen.getByRole("button", { name: /Ticket #12/ }));
    await screen.findByRole("menuitem", { name: /Mark as resolved/ });
    expect(screen.queryByRole("menuitem", { name: /Hand back/ })).toBeNull();
  });
});
