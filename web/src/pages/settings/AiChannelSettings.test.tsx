import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { AiChannelSettings } from "./AiAgentsSettings";

const calls: { method: string; path: string; body?: string }[] = [];
function mount(settings: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://x").pathname;
      calls.push({ method: init?.method ?? "GET", path, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ id: "ws_1", name: "Acme", settings }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AiChannelSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AiChannelSettings", () => {
  beforeEach(() => (calls.length = 0));
  it("both channels are off by default; switching SMS on shows its limits and quiet hours and saves the whole object", async () => {
    mount();
    const sms = await screen.findByRole("switch", { name: /AI agents answer texts/ });
    expect(sms).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /AI agents answer emails/ })).not.toBeChecked();
    expect(screen.queryByLabelText("Longest text (segments)")).toBeNull();
    await userEvent.click(sms);
    expect(screen.getByLabelText("Longest text (segments)")).toHaveValue(3);
    expect(screen.getByRole("switch", { name: /No AI texts at night/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).settings.ai_channels).toEqual({ sms: { enabled: true, max_replies_per_day: 5, max_segments: 3, quiet_hours: { enabled: true, start: "21:00", end: "08:00" } }, email: { enabled: false, max_replies_per_day: 5, max_chars: 2000, signature: "" } });
  });
  it("email: the extra signature line and the length limit", async () => {
    mount({ ai_channels: { email: { enabled: true } } });
    const sig = await screen.findByLabelText("Extra signature line");
    await userEvent.type(sig, "Mon-Fri 9-17");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).settings.ai_channels.email).toMatchObject({ enabled: true, signature: "Mon-Fri 9-17", max_chars: 2000 });
  });
});
