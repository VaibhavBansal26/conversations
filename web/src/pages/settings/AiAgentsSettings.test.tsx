import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { AiAgent, AgentTurn } from "../../api/types";
import { AiAgentsSettings } from "./AiAgentsSettings";

const agent = (over: Partial<AiAgent> = {}): AiAgent => ({
  id: "agt_1", name: "Aria", avatar_url: null, avatar_alt: "", avatar_uploaded: false, persona: "Be kind", tone: "friendly", languages: [], greeting: "", department_ids: [], hours: { enabled: false, timezone: "UTC", days: [] }, kb_collections: [], autonomy: "auto_answer",
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

function withSession(workspaceId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["me"], { user: { id: "u_1", name: "Owner", email: "o@example.test" }, member: {}, workspace: { id: workspaceId } });
  return qc;
}

function mount(workspaceId = "ws_1") {
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
    <QueryClientProvider client={withSession(workspaceId)}>
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
    localStorage.clear();
  });

  it("opening the screen creates nothing (new workspaces get Aria and vb at registration); with none, 'Add Aria and vb' adds both, on", async () => {
    agents = [];
    mount();
    await screen.findByText("No AI agents yet");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Add Aria and vb" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/api/agents")).toHaveLength(2));
    const [aria, vb] = calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body!));
    expect(aria).toMatchObject({ name: "Aria", enabled: true, autonomy: "auto_answer", avatar_url: "/avatars/aria.webp", disclosure_label: "AI assistant", tone: "friendly" });
    expect(aria.avatar_alt).toMatch(/Portrait of Aria/);
    expect(vb).toMatchObject({ name: "vb", enabled: true, autonomy: "auto_answer", avatar_url: "/avatars/vb.webp", disclosure_label: "AI assistant", tone: "concise" });
  });

  it("does not offer the default agents when one exists", async () => {
    mount();
    await screen.findByText("Aria");
    expect(screen.queryByRole("button", { name: "Add Aria and vb" })).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
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
    await userEvent.click(within(screen.getByRole("group", { name: "Start from a preset" })).getByText("Blank").closest("button")!);
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

  it("New agent offers presets (Aria, vb) and a blank start; a preset fills the form and keeps the AI label", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New agent" }));
    const group = screen.getByRole("group", { name: "Start from a preset" });
    expect(within(group).getByText("Aria")).toBeInTheDocument();
    expect(within(group).getByText("vb")).toBeInTheDocument();
    expect(within(group).getByText("Blank")).toBeInTheDocument();
    await user.click(within(group).getByText("vb").closest("button")!);
    expect(await screen.findByRole("form", { name: "New AI agent" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("vb");
    expect(screen.getByLabelText(/Label shown to visitors/)).toHaveValue("AI assistant");
    expect(screen.getByLabelText("Greeting")).toHaveValue("Hi, I'm vb. What do you need help with?");
    expect((screen.getByLabelText("Description of the picture") as HTMLInputElement).value).toMatch(/Portrait of vb/);
    // the note about rights and the label is on screen next to the picture controls
    expect(screen.getByRole("note")).toHaveTextContent(/right to use/);
    expect(screen.getByRole("note")).toHaveTextContent(/always shown together with the label/);
    await user.click(screen.getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/agents" && JSON.parse(c.body!).name === "vb")).toBe(true));
    const body = JSON.parse(calls.filter((c) => c.method === "POST" && c.path === "/api/agents").at(-1)!.body!);
    expect(body).toMatchObject({ avatar_url: "/avatars/vb.webp", disclosure_label: "AI assistant", tone: "concise" });
  });

  it("the picture can be switched between the presets and removed, and the list shows it", async () => {
    agents = [agent({ avatar_url: "/avatars/aria.webp", avatar_alt: "Portrait of Aria" })];
    mount();
    const user = userEvent.setup();
    const row = (await screen.findByText("Aria")).closest("li")!;
    expect(row.querySelector("img")!.getAttribute("src")).toBe("/avatars/aria.webp");
    await user.click(screen.getByRole("button", { name: "Edit Aria" }));
    await user.click(await screen.findByRole("button", { name: "Use the vb picture" }));
    await user.click(screen.getByRole("button", { name: "Save agent" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && JSON.parse(c.body!).avatar_url === "/avatars/vb.webp")).toBe(true));
  });
});
