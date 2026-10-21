import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { Ticket } from "../api/types";
import { TicketsPage } from "./TicketsPage";

let allowed = true;
vi.mock("../auth/AuthContext", () => ({ useCan: () => allowed }));

const ticket = (n: number, over: Partial<Ticket> = {}): Ticket => ({
  id: `tkt_${n}`, number: n, room_id: `room_${n}`, contact_id: `con_${n}`, subject: `Problem ${n}`, subject_set_by: "auto", status: "waiting_for_human", handler: null, department_id: "inb_1", priority: 1,
  resolution: null, channel: "dm", opened_at: "2026-03-02T10:00:00.000Z", first_response_at: null, handoff_at: null, first_human_response_at: null, resolved_at: null, closed_at: null, csat: null,
  csat_comment: null, tags: [], summary: "", handoff_reason: null, merged_into_id: null, last_activity_at: "2026-03-02T10:00:00.000Z", created_at: "", updated_at: "", contact: { id: `con_${n}`, name: `Customer ${n}`, email: null }, ...over,
});

const calls: { url: string; method: string; body?: string }[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

function mount(rows: Ticket[], initial = "/tickets") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      const path = new URL(url, "http://x").pathname;
      if (path === "/api/tickets") return json({ data: rows, pagination: { limit: 30, has_more: false, next_cursor: null } });
      if (path === "/api/tickets/counts") return json({ new: 1, bot_handling: 2, waiting_for_human: 3, open: 4, pending_customer: 0, resolved: 0, closed: 0, total_live: 10 });
      if (path === "/api/tickets/bulk") return json({ results: [], succeeded: 2, failed: 0 });
      if (path === "/api/inboxes") return json({ data: [{ id: "inb_1", name: "Billing" }] });
      if (path === "/api/members") return json({ data: [{ id: "mem_1", name: "Olivia Owner" }] });
      return json({});
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>
        <TicketsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TicketsPage", () => {
  beforeEach(() => {
    calls.length = 0;
    allowed = true;
  });

  it("lists tickets with number, status, customer and department, and counts waiting ones", async () => {
    mount([ticket(1), ticket(2, { status: "bot_handling", handler: "bot:agt_1", priority: 3 })]);
    const rows = await screen.findAllByTestId("ticket-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("#1")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Customer 1")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Urgent")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /3\s*Waiting for a person/ })).toBeInTheDocument();
  });

  it("an empty queue explains what a ticket is", async () => {
    mount([]);
    expect(await screen.findByText("No tickets here")).toBeInTheDocument();
  });

  it("bulk resolve sends the selected ids and reports the result", async () => {
    mount([ticket(1), ticket(2), ticket(3)]);
    await screen.findAllByTestId("ticket-row");
    await userEvent.click(screen.getAllByRole("checkbox", { name: "Select ticket 1" })[0]!);
    await userEvent.click(screen.getAllByRole("checkbox", { name: "Select ticket 3" })[0]!);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/api/tickets/bulk"))?.body).toBe(JSON.stringify({ ticket_ids: ["tkt_1", "tkt_3"], action: "resolve" })));
  });

  it("select-all picks every row; seats without tickets:close see no checkboxes", async () => {
    mount([ticket(1), ticket(2)]);
    await screen.findAllByTestId("ticket-row");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all tickets on this page" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("without tickets:close there is nothing to select", async () => {
    allowed = false;
    mount([ticket(1)]);
    await screen.findAllByTestId("ticket-row");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("filters come from the URL and are sent to the server", async () => {
    mount([ticket(1)], "/tickets?status=resolved&handler=bot&department=inb_1&q=refund");
    await screen.findAllByTestId("ticket-row");
    const url = calls.find((c) => c.url.startsWith("/api/tickets?"))!.url;
    const q = new URL(url, "http://x").searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ status: "resolved", handler: "bot", department_id: "inb_1", q: "refund", limit: "30" });
  });
});
