import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { AiAgent, AgentTurn } from "../../api/types";
import { AiAgentsSettings } from "./AiAgentsSettings";

const agent = (over: Partial<AiAgent> = {}): AiAgent => ({
  id: "agt_1", name: "Aria", avatar_url: null, persona: "Be kind", tone: "friendly", languages: [], greeting: "", department_ids: [], hours: { enabled: false, timezone: "UTC", days: [] }, kb_collections: [], autonomy: "auto_answer",
  confidence_threshold: 0.6, coverage_threshold: 0.5, max_turns: 6, max_attempts: 2, allowed_actions: ["route", "quick_replies"], waiting_behavior: "gather_info", disclosure_label: "AI assistant", channels: ["widget"], enabled: true, created_at: "", updated_at: "",
  handoff_triggers: { human_request: true, low_confidence: true, repeated_rephrase: true, negative_sentiment: true, high_urgency: true, sensitive_topic: true, vip_contact: true, tool_failure: true, sensitive_topics: ["refund"] }, ...over,
});
const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({
  id: "trn_1", created_at: "2026-03-02T10:00:00Z", ticket_id: "tkt_1", ticket_number: 7, room_id: "room_1", agent_id: "agt_1", outcome: "answered", intent: "support", department_id: null, confidence: 0.9, reason: null, visitor_text: "How do I reset my password?",
  answer: "Open Settings.", sources: [{ id: "kb_1", question: "Reset password", url: null, score: 1, coverage: 1 }], actions: [], provider: "heuristic", tokens: { in: 0, out: 0 }, latency_ms: 3, votes: { up: 0, down: 2 }, message_id: "msg_1", ...over,
});
let agents: AiAgent[];
const calls: { path: string; method: string; body?: string }[] = [];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(url, "http://x").pathname;
      calls.push({ path, method, body: init?.body as string | undefined });
      if (path === "/api/agents" && method === "GET") return json({ data: agents });
      if (path === "/api/agents" && method === "POST") return json(agent({ id: "agt_new", name: "Max" }), 201);
      if (path === "/api/agents/agt_1" && method === "PATCH") return json(agents[0]);
      if (path === "/api/agents/agt_1/sandbox")
        return json({ kind: "answer", reply: "Open Settings, choose Security.", handoff: null, confidence: 0.9, intent: "support", sentiment: "neutral", urgency: 0, department: { id: null, confidence: 0 }, sources: [{ id: "kb_1", question: "Reset password", url: null, score: 1, coverage: 1 }], actions: [], subject: null, quick_replies: true, provider: "heuristic", degraded: false, tokens: { in: 0, out: 0 }, latency_ms: 2, trace: ["found 1 entry"], routing: null });
      if (path === "/api/agents/turns") return json({ data: [turn()], pagination: { limit: 20, has_more: false, next_cursor: null } });
      if (path === "/api/agents/unanswered") return json({ data: [{ count: 3, sample: "how do I change my invoice email", examples: ["how do I change my invoice email", "change invoice email"], last_seen: "", suggested_question: "how do I change my invoice email" }] });
      if (path === "/api/departments") return json({ data: [{ id: "inb_1", name: "Billing" }] });
      return json({});
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AiAgentsSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AiAgentsSettings", () => {
  beforeEach(() => {
    calls.length = 0;
    agents = [agent()];
  });

  it("lists agents with their state, autonomy and departments, and switches one off", async () => {
    mount();
    const row = (await screen.findByText("Aria")).closest("li")!;
    expect(within(row).getByText("On")).toBeInTheDocument();
    expect(within(row).getByText("Answer on its own")).toBeInTheDocument();
    expect(within(row).getByText("All departments")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("switch", { name: "Aria on" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toBe(JSON.stringify({ enabled: false })));
  });

  it("creates an agent with the disclosure label, the topics as a list and the chosen actions", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /new agent/i }));
    const form = await screen.findByRole("form", { name: "New AI agent" });
    await userEvent.type(within(form).getByLabelText("Name"), "Max");
    await userEvent.type(within(form).getByLabelText(/Sensitive topics/), "refund, Lawsuit ,refund");
    await userEvent.click(within(form).getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/agents")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!);
    expect(body).toMatchObject({ name: "Max", disclosure_label: "AI assistant", autonomy: "auto_answer", enabled: false });
    expect(body.handoff_triggers.sensitive_topics).toEqual(["refund", "lawsuit"]);
    expect(body.allowed_actions).toContain("route");
  });

  it("tries an agent without saving anything and shows what it would do", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Aria" }));
    await userEvent.type(await screen.findByLabelText("Test message"), "How do I reset my password?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const result = await screen.findByRole("status", { name: "What the agent would do" });
    expect(within(result).getByText("Answers")).toBeInTheDocument();
    expect(within(result).getByText(/Sources: Reset password/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Test conversation" })).toHaveTextContent("Open Settings, choose Security.");
  });

  it("reviews turns with their votes, and lists the unanswered questions", async () => {
    mount();
    await userEvent.click(await screen.findByRole("tab", { name: "Review" }));
    const list = await screen.findByRole("list", { name: "Agent turns" });
    expect(within(list).getByText("Answered")).toBeInTheDocument();
    expect(within(list).getByText("Ticket #7")).toBeInTheDocument();
    expect(within(list).getByText(/not helpful/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Unanswered" }));
    expect(await screen.findByText(/Asked 3 times/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Write an entry for how do I change my invoice email/ })).toBeInTheDocument();
  });
});
