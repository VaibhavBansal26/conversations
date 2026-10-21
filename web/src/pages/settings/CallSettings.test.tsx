import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { CallSettings } from "./CallSettings";

let allowed = new Set(["calls:settings"]);
let settings: unknown = undefined;
vi.mock("../../auth/AuthContext", () => ({ useCan: (p: string) => allowed.has(p), useSession: () => ({ workspace: { settings: { calls: settings } } }) }));
const calls: { method: string; path: string; body?: string }[] = [];
let aiConfig: unknown = { engine: "browser", realtime_available: false, realtime_switched_off: false };

function mount(warning: string | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://x").pathname;
      calls.push({ method: init?.method ?? "GET", path, body: init?.body as string | undefined });
      const body = path === "/api/calls/config" ? { browser: { enabled: true, voice: true, video: true, screen_share: true }, ring_seconds: 45, turn_provider: "none", warning, ai: aiConfig } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <CallSettings />
      </MemoryRouter>
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
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toMatchObject({ browser: { enabled: true, voice: true, video: false, screen_share: true }, ring_seconds: 45, turn_provider: "none", phone: { enabled: false, caller_id: null, allowed_countries: [] } });
  });

  it("phone calls: shows what is missing, and saves countries upper-cased with the limits", async () => {
    mount();
    await userEvent.click(screen.getByRole("switch", { name: /Phone calls/ }));
    await userEvent.type(screen.getByLabelText(/Countries that may be called/), "us, gb");
    await userEvent.clear(screen.getByLabelText("Calls per day"));
    await userEvent.type(screen.getByLabelText("Calls per day"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).phone).toMatchObject({ enabled: true, allowed_countries: ["US", "GB"], daily_limit: 5, quiet_hours: { enabled: true, start: "21:00", end: "08:00" } });
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

  it("calls with the AI: off by default, the browser's voice is the default engine, and one patch saves the limits", async () => {
    mount();
    expect(screen.getByRole("switch", { name: /Let visitors talk to the AI assistant/ })).not.toBeChecked();
    expect(screen.queryByLabelText("Calls at the same time")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: /Let visitors talk to the AI assistant/ }));
    expect(screen.getByText(/The visitor's browser does the speech: free/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Video call with an AI avatar" })).toBeChecked();
    expect(screen.getByText(/cannot see the visitor/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Calls at the same time"));
    await userEvent.type(screen.getByLabelText("Calls at the same time"), "2");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
    expect(body.ai).toMatchObject({ enabled: true, voice: true, video: true, max_duration_s: 600, idle_timeout_s: 120, max_concurrent: 2, daily_limit: 100 });
    expect(body.ai_engine).toBe("browser");
  });

  it("live voice: choosing it shows its honest description and budgets, and warns when this installation cannot do it", async () => {
    settings = { ai: { enabled: true }, ai_engine: "realtime" };
    mount();
    expect(await screen.findByText(/model speaks before our checks can read what it said/)).toBeInTheDocument();
    expect(screen.getByLabelText("Live voice minutes per day")).toBeInTheDocument();
    expect(screen.getByLabelText("Live voice calls at the same time")).toBeInTheDocument();
    expect(await screen.findByText(/no OpenAI key or realtime model configured/)).toBeInTheDocument();
  });

  it("no warning when live voice is available, and a different one when the instance switch is off", async () => {
    settings = { ai: { enabled: true }, ai_engine: "realtime" };
    aiConfig = { engine: "realtime", realtime_available: true, realtime_switched_off: false };
    const first = mount();
    await screen.findByLabelText("Live voice minutes per day");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/calls/config")).toBe(true));
    expect(screen.queryByText(/no OpenAI key/)).toBeNull();
    first.unmount();
    aiConfig = { engine: "realtime", realtime_available: false, realtime_switched_off: true };
    mount();
    expect(await screen.findByText(/switched off for this whole installation/)).toBeInTheDocument();
    aiConfig = { engine: "browser", realtime_available: false, realtime_switched_off: false };
  });

  it("calls between teammates: off by default, then voice, video, screen sharing and ring time, saved in one patch", async () => {
    mount();
    expect(screen.getByRole("switch", { name: /Let teammates call each other/ })).not.toBeChecked();
    expect(screen.getByText(/Group calls are not available/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: /Let teammates call each other/ }));
    await userEvent.click(screen.getAllByRole("switch", { name: "Video" })[0]!);
    await userEvent.clear(screen.getByLabelText("Ring time (seconds)", { selector: "input[min='10']" }));
    await userEvent.type(screen.getByLabelText("Ring time (seconds)", { selector: "input[min='10']" }), "20");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).internal).toEqual({ enabled: true, voice: true, video: false, screen_share: true, ring_seconds: 20 });
  });

  it("call links: off by default, then who they may reach and how long they live, saved in one patch", async () => {
    mount();
    expect(screen.getByRole("switch", { name: /Let people join a call from a link/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: /Let people join a call from a link/ }));
    await userEvent.click(screen.getByRole("switch", { name: "Links to your team" }));
    await userEvent.clear(screen.getByLabelText("Link lifetime (minutes)"));
    await userEvent.type(screen.getByLabelText("Link lifetime (minutes)"), "60");
    expect(screen.getByText(/Anyone who has the link can join/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).links).toEqual({ enabled: true, ttl_minutes: 60, allow_ai: true, allow_team: false });
  });
});
