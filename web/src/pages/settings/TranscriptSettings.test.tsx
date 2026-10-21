import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { TranscriptSettings } from "./TicketSettings";

let settings: Record<string, unknown> = {};
vi.mock("../../auth/AuthContext", () => ({ useSession: () => ({ workspace: { settings } }), useCan: () => true }));
const calls: { method: string; path: string; body?: string }[] = [];
function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(url, "http://x").pathname, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ id: "ws_1", name: "Acme", settings: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TranscriptSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("TranscriptSettings", () => {
  beforeEach(() => ((calls.length = 0), (settings = {})));
  it("is off by default; the automatic copy needs the first switch; saves the transcripts object", async () => {
    mount();
    const on = screen.getByRole("switch", { name: /Visitors can ask for a copy/ });
    expect(on).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /Also send a copy when a ticket is resolved/ })).toBeDisabled();
    await userEvent.click(on);
    await userEvent.click(screen.getByRole("switch", { name: /Also send a copy when a ticket is resolved/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ settings: { transcripts: { enabled: true, send_after_resolve: true, redact: false } } });
  });
});
