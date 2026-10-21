import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { PushSettings } from "./PushSettings";
import { keyToBytes } from "../../lib/push";

let role = "agent";
vi.mock("../../auth/AuthContext", () => ({ useSession: () => ({ member: { id: "mem_1", role }, workspace: { settings: {} } }), useCan: () => true }));
const calls: { method: string; path: string; body?: string }[] = [];
let state: any;
const device = (over: Record<string, unknown> = {}) => ({ id: "push_1", label: "Work laptop", user_agent: "Mozilla/5.0 Chrome/140", push_service: "fcm.googleapis.com", events: ["missed_call", "assigned", "message"], created_at: "2026-10-21T10:00:00Z", last_success_at: null, last_error: null, disabled: false, ...over });

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://x").pathname;
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body as string | undefined });
      let body: unknown = {};
      if (path === "/api/push/subscriptions" && method === "GET") body = state;
      else if (path.endsWith("/test")) body = { result: "sent" };
      else if (method === "PATCH" && path.startsWith("/api/push/")) body = device(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PushSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PushSettings", () => {
  beforeEach(() => {
    calls.length = 0;
    role = "agent";
    localStorage.clear();
  });

  it("says plainly that push is not set up when the server has no VAPID keys, and offers nothing to turn on", async () => {
    state = { data: [], config: { enabled: false, public_key: null, reason: "not_configured", previews: false } };
    mount();
    expect(await screen.findByText(/Push notifications are not set up on this server/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turn on for this device/ })).toBeNull();
    state = { data: [], config: { enabled: false, public_key: null, reason: "invalid_keys", previews: false } };
  });

  it("in a browser without push support it says so instead of a broken button", async () => {
    state = { data: [], config: { enabled: true, public_key: "BAAA", reason: null, previews: false } };
    mount();
    expect(await screen.findByText(/This browser cannot receive push notifications/)).toBeInTheDocument();
  });

  it("lists devices with their events; switching an event off saves it; test and turn off call the device's endpoints", async () => {
    state = { data: [device()], config: { enabled: true, public_key: "BAAA", reason: null, previews: false } };
    mount();
    const list = await screen.findByRole("list", { name: "Your devices" });
    expect(list).toHaveTextContent("Work laptop");
    expect(list).toHaveTextContent("Chrome via fcm.googleapis.com");
    await userEvent.click(screen.getByRole("switch", { name: /Customer messages/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ events: ["missed_call", "assigned"] });
    await userEvent.click(screen.getByRole("button", { name: "Send a test" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/push/subscriptions/push_1/test")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /Turn off notifications on Work laptop/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/push/subscriptions/push_1")).toBe(true));
  });

  it("the message-preview switch is for owners and managers only, off by default, and saves the workspace setting", async () => {
    state = { data: [], config: { enabled: true, public_key: "BAAA", reason: null, previews: false } };
    mount();
    await screen.findByText(/Do not disturb pauses push notifications/);
    expect(screen.queryByRole("switch", { name: /Show message text/ })).toBeNull();
    role = "manager";
    document.body.innerHTML = "";
    mount();
    const sw = await screen.findByRole("switch", { name: /Show message text/ });
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/workspace" && c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.path === "/api/workspace")!.body!)).toEqual({ settings: { push_message_previews: true } });
  });

  it("decodes a base64url VAPID key to the bytes the browser wants", () => {
    expect([...keyToBytes("AQID_w")]).toEqual([1, 2, 3, 255]);
  });
});
