import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CallSettings } from "./CallSettings";

let allowed = new Set(["calls:settings"]);
let settings: unknown = undefined;
vi.mock("../../auth/AuthContext", () => ({ useCan: (p: string) => allowed.has(p), useSession: () => ({ workspace: { settings: { calls: settings } } }) }));
const calls: { method: string; path: string; body?: string }[] = [];

function mount(warning: string | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://x").pathname;
      calls.push({ method: init?.method ?? "GET", path, body: init?.body as string | undefined });
      const body = path === "/api/calls/config" ? { browser: { enabled: true, voice: true, video: true, screen_share: true }, ring_seconds: 45, turn_provider: "none", warning } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CallSettings />
    </QueryClientProvider>,
  );
}

describe("CallSettings", () => {
  beforeEach(() => {
    calls.length = 0;
    allowed = new Set(["calls:settings"]);
    settings = undefined;
  });

  it("is off by default, hides the kinds until switched on, and saves one patch", async () => {
    mount();
    expect(screen.getByRole("switch", { name: "Browser calls" })).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: "Voice calls" })).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Browser calls" }));
    await userEvent.click(screen.getByRole("switch", { name: "Video calls" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.path).toBe("/api/calls/settings");
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ browser: { enabled: true, voice: true, video: false, screen_share: true }, ring_seconds: 45, turn_provider: "none" });
  });

  it("warns, in plain words, when there is no relay", async () => {
    settings = { browser: { enabled: true, voice: true, video: true, screen_share: true }, ring_seconds: 45, turn_provider: "none" };
    mount("No TURN relay is configured: calls will fail for visitors behind strict firewalls.");
    expect(await screen.findByText(/No TURN relay is configured/)).toBeInTheDocument();
  });

  it("is read-only without the call settings permission", () => {
    allowed = new Set();
    mount();
    expect(screen.getByText(/needs the call settings permission/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Browser calls" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});
