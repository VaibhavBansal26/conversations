import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { Department, RoutingRule } from "../../api/types";
import { DepartmentSettings, formatWait } from "./DepartmentSettings";

const dept = (id: string, name: string, over: Partial<Department> = {}): Department => ({
  id, name, icon: "inbox", algorithm: "manual", live_routing_visibility: true, default_email_inbound: false, default_sms_inbound: false, last_assigned_member_id: null, member_ids: ["mem_1"], created_at: "", description: "Plans and quotes",
  routing_mode: null, effective_routing_mode: "manual_pick", capacity: 0, hours: { enabled: false, timezone: "UTC", days: [], holidays: [] }, sla_first_response_s: null, sla_resolution_s: null, overflow_inbox_id: null,
  auto_reply_closed: "", auto_reply_queued: "", members: [{ member_id: "mem_1", name: "Olivia Owner", skills: ["billing"], languages: ["en"], capacity: null }],
  status: { id, name, open: true, next_opening: null, available_agents: 1, queue_length: 0, estimated_wait_s: 240 }, ...over,
});
let departments: Department[];
let rules: RoutingRule[];
const calls: { url: string; method: string; body?: string }[] = [];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string | undefined });
      const path = new URL(url, "http://x").pathname;
      if (path === "/api/departments" && method === "GET") return json({ data: departments });
      if (path.startsWith("/api/departments/") && method === "PATCH") return json(departments[0]);
      if (path === "/api/routing-rules" && method === "GET") return json({ data: rules });
      if (path === "/api/routing-rules/order") return json({ data: rules });
      if (path === "/api/routing-rules/test") return json({ department_id: "inb_sales", rule: rules[0], evaluated: [{ rule_id: "rl_1", name: "Pricing", matched: true }] });
      if (path === "/api/routing-rules" && method === "POST") return json({ ...rules[0], id: "rl_new" }, 201);
      return json({});
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <DepartmentSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rule = (id: string, name: string, department_id: string, position: number): RoutingRule => ({ id, position, name, enabled: true, department_id, created_at: "", updated_at: "", conditions: [{ field: "page_url", op: "contains", value: "/pricing" }] });

describe("DepartmentSettings", () => {
  beforeEach(() => {
    calls.length = 0;
    departments = [dept("inb_sales", "Sales"), dept("inb_bill", "Billing", { status: { id: "inb_bill", name: "Billing", open: false, next_opening: "tomorrow", available_agents: 0, queue_length: 3, estimated_wait_s: null }, effective_routing_mode: "least_busy", routing_mode: "least_busy", capacity: 4 })];
    rules = [rule("rl_1", "Pricing", "inb_sales", 0), rule("rl_2", "Invoices", "inb_bill", 1)];
  });

  it("lists departments with open or closed, free people, the queue and the mode", async () => {
    mount();
    const sales = (await screen.findByText("Sales")).closest("li")!;
    expect(within(sales).getByText("Open")).toBeInTheDocument();
    expect(within(sales).getByText("1 free")).toBeInTheDocument();
    expect(within(sales).getByText("Manual pick")).toBeInTheDocument();
    expect(within(sales).getByText(/wait about 4 min/)).toBeInTheDocument();
    const billing = screen.getAllByText("Billing")[0]!.closest("li")!;
    expect(within(billing).getByText("Closed")).toBeInTheDocument();
    expect(within(billing).getByText("3 waiting")).toBeInTheDocument();
    expect(within(billing).getByText("4 each")).toBeInTheDocument();
  });

  it("saves the routing configuration of one department as a patch", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Edit department Sales" }));
    const form = await screen.findByRole("form", { name: "Edit department Sales" });
    await userEvent.clear(within(form).getByLabelText("Tickets per person"));
    await userEvent.type(within(form).getByLabelText("Tickets per person"), "3");
    await userEvent.type(within(form).getByLabelText("First response (minutes)"), "5");
    const skills = within(form).getByLabelText("Skills");
    await userEvent.clear(skills);
    await userEvent.type(skills, "billing, api");
    await userEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
    expect(body).toMatchObject({ capacity: 3, sla_first_response_s: 300, routing_mode: null, overflow_inbox_id: null, members: [{ member_id: "mem_1", skills: ["billing", "api"], languages: ["en"], capacity: null }] });
  });

  it("adds and removes holidays", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Edit department Sales" }));
    const form = await screen.findByRole("form", { name: "Edit department Sales" });
    await userEvent.type(within(form).getByLabelText("Holiday date"), "2026-12-25");
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(within(form).getByText("2026-12-25")).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Remove holiday 2026-12-25" }));
    expect(within(form).queryByText("2026-12-25")).toBeNull();
  });

  it("shows the routing rules in order, moves one down, and tries the rules in the sandbox", async () => {
    mount();
    const list = await screen.findByText("Pricing");
    expect(list.closest("li")).toHaveTextContent('When page address contains "/pricing"');
    await userEvent.click(screen.getByRole("button", { name: "Move Pricing down" }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/routing-rules/order"))?.body).toBe(JSON.stringify({ ids: ["rl_2", "rl_1"] })));
    expect(screen.getByRole("button", { name: "Move Pricing up" })).toBeDisabled(); // the first rule cannot go up
    await userEvent.click(screen.getByText("Try the rules"));
    await userEvent.type(screen.getByLabelText("Page address"), "https://example.com/pricing");
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Rule Pricing matches: the conversation goes to Sales.");
  });

  it("creates a rule from conditions", async () => {
    mount();
    await screen.findByText("Pricing");
    await userEvent.click(screen.getByRole("button", { name: "New rule" }));
    const form = await screen.findByRole("form", { name: "New routing rule" });
    await userEvent.type(within(form).getByLabelText("Name"), "Docs");
    await userEvent.type(within(form).getByLabelText("Condition 1 value"), "/docs");
    await userEvent.click(within(form).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/routing-rules"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toMatchObject({ name: "Docs", enabled: true, department_id: "inb_sales", conditions: [{ field: "page_url", op: "contains", value: "/docs" }] });
  });

  it("formats the typical wait", () => {
    expect(formatWait(null)).toBe("no data yet");
    expect(formatWait(30)).toBe("under 2 min");
    expect(formatWait(600)).toBe("about 10 min");
  });
});
