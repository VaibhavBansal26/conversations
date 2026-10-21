import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { SupportAnalytics, type SupportOverview } from "./SupportAnalytics";

const data: SupportOverview = {
  tickets: { opened: 40, resolved: 31, by_resolution: { bot_resolved: 12, human_resolved: 19 }, containment_rate: 0.6, handoff_rate: 0.45, handoff_reasons: [{ reason: "no_answer", count: 9 }, { reason: "customer_requested_human", count: 5 }], wait_for_human_p50_s: 300, sla_first_response_breaches: 2, sla_resolution_breaches: 1, csat: { bot_avg: 4.5, bot_count: 6, human_avg: 4.1, human_count: 12 }, queue_length_now: 3 },
  by_department: [{ department_id: "inb_1", tickets: 25, handoffs: 10, resolved: 20, csat_avg: 4.3, sla_breaches: 2 }, { department_id: null, tickets: 15, handoffs: 8, resolved: 11, csat_avg: null, sla_breaches: 1 }],
  ai_agents: [{ agent_key: "a".repeat(32), turns: 80, answered: 50, handoffs: 20, resolved: 10, refused: 0, helpful: 7, not_helpful: 2 }],
  calls: { total: 9, answered: 6, missed: 2, declined: 1, failed: 0, total_duration_s: 1800, avg_duration_s: 300, by_transport: { webrtc: 7, phone: 2, ai: 0 }, by_kind: { voice: 5, video: 4, ai_voice: 0, ai_video: 0 } },
  ai_calls: { total: 0, total_duration_s: 0, avg_duration_s: null, handed_to_person: 0, handoff_rate: null, by_engine: { browser: 0, realtime: 0 }, by_end_reason: {}, by_handoff_reason: [], realtime: { calls: 0, minutes: 0, estimated_cost_usd: null } },
};
let payload: unknown = data;
function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      const body = path === "/api/inboxes" ? { data: [{ id: "inb_1", name: "Billing" }] } : payload;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SupportAnalytics days={30} range={() => ({ from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z", tz: "UTC" })} />
    </QueryClientProvider>,
  );
}

describe("SupportAnalytics", () => {
  beforeEach(() => void (payload = data));

  it("shows containment, hand-offs, waiting time, breaches, ratings and calls in plain words", async () => {
    mount();
    expect(await screen.findByText("60%")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("Wait for a person (median)").nextElementSibling).toHaveTextContent("5 min");
    expect(screen.getByText("Service level breaches").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("4.5 / 4.1")).toBeInTheDocument();
    expect(screen.getByText("7 in the browser, 2 by phone")).toBeInTheDocument();
    const reasons = screen.getByText("Why tickets go to a person").closest("div")!.parentElement!;
    expect(within(reasons).getByText("No answer found")).toBeInTheDocument();
    expect(within(reasons).getByText("Asked for a person")).toBeInTheDocument();
  });

  it("names departments from the inbox list, never shows an agent id, and lists AI agents anonymously", async () => {
    mount();
    const table = await screen.findByRole("table", { name: "By department" });
    expect(within(table).getByText("Billing")).toBeInTheDocument();
    expect(within(table).getByText("No department")).toBeInTheDocument();
    const ai = screen.getByRole("table", { name: "By AI agent" });
    expect(within(ai).getByText("AI agent 1")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("a".repeat(32));
  });

  it("says so when nothing was handed over and shows n/a without data", async () => {
    payload = { ...data, tickets: { ...data.tickets, opened: 0, containment_rate: null, handoff_rate: null, handoff_reasons: [], wait_for_human_p50_s: null }, by_department: [], ai_agents: [] };
    mount();
    expect(await screen.findByText("No tickets were handed over in this period.")).toBeInTheDocument();
    expect(screen.getAllByText("n/a").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("table", { name: "By department" })).toBeNull();
  });

  it("shows calls with the AI assistant only when there were some, with live-voice minutes and an estimate only when a price is set", async () => {
    payload = { ...data, calls: { ...data.calls, total: 13, by_transport: { webrtc: 7, phone: 2, ai: 4 } }, ai_calls: { total: 4, total_duration_s: 360, avg_duration_s: 90, handed_to_person: 2, handoff_rate: 0.5, by_engine: { browser: 2, realtime: 2 }, by_end_reason: { handoff: 1 }, by_handoff_reason: [{ reason: "unsafe_answer", count: 1 }, { reason: "customer_requested_human", count: 1 }], realtime: { calls: 2, minutes: 3, estimated_cost_usd: 1.2 } } };
    mount();
    const g = await screen.findByRole("group", { name: "Calls with the AI assistant" });
    expect(within(g).getByText("AI calls").nextElementSibling).toHaveTextContent("4");
    expect(within(g).getByText("2 with browser voice, 2 with live voice")).toBeInTheDocument();
    expect(within(g).getByText("50%")).toBeInTheDocument();
    expect(within(g).getByText("Live voice minutes").nextElementSibling).toHaveTextContent("3");
    expect(within(g).getByText(/your estimate, not billing data/)).toBeInTheDocument();
    expect(within(g).getByText(/Answer blocked \(1\), Asked for a person \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("7 in the browser, 2 by phone, 4 with the AI")).toBeInTheDocument();
  });

  it("has no AI call section without AI calls", async () => {
    mount();
    await screen.findByText("60%");
    expect(screen.queryByRole("group", { name: "Calls with the AI assistant" })).toBeNull();
  });
});
