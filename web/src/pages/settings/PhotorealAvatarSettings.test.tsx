import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { PhotorealAvatarSettings } from "./PhotorealAvatarSettings";

let allowed = new Set(["calls:settings"]);
vi.mock("../../auth/AuthContext", () => ({ useCan: (p: string) => allowed.has(p), useSession: () => ({ workspace: { settings: {} } }) }));
const calls: { method: string; path: string; body?: string }[] = [];
let status: any;
const base = () => ({ provider: null, connection: null, state: "not_connected", kill_switch: false, settings: { enabled: false, minutes_daily: 10, max_concurrent: 1 }, usage_today: { minutes: 0, limit_minutes: 10, estimated_cost_usd: null }, avatars: [], agents: [{ id: "agt_1", name: "Aria", avatar_id: null }] });
const connected = () => ({ ...base(), provider: "did", connection: { source: "workspace", status: "connected", key_hint: "…9xQz", last_error: null, last_checked_at: "2026-10-21T10:00:00Z" }, state: "connected_off" });

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://x").pathname;
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body as string | undefined });
      let body: unknown = status;
      if (path === "/api/calls/avatar/connection" && method === "PUT") body = status = { ...connected(), connection: { ...connected().connection, status: "pending" }, state: "pending" };
      if (path === "/api/calls/avatar/connection/test") body = { ok: true, credits_remaining: 17, status: (status = connected()) };
      if (path === "/api/calls/avatar/connection" && method === "DELETE") body = status = base();
      if (path === "/api/calls/settings") body = { settings: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PhotorealAvatarSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PhotorealAvatarSettings", () => {
  beforeEach(() => {
    calls.length = 0;
    allowed = new Set(["calls:settings"]);
    status = base();
  });

  it("is hidden without the call settings permission", () => {
    allowed = new Set();
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
  });

  it("not connected by default, with setup steps and a consent note; saving the key tests it at once and the key leaves the form", async () => {
    mount();
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/How to set it up/)).toBeInTheDocument();
    expect(screen.getByText(/studio\.d-id\.com/)).toBeInTheDocument();
    const field = screen.getByLabelText("D-ID API key");
    expect(field).toHaveAttribute("type", "password");
    const key = `u${Math.random().toString(36).slice(2)}:p${Math.random().toString(36).slice(2)}`;
    await userEvent.type(field, key);
    await userEvent.click(screen.getByRole("button", { name: /Save key/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/calls/avatar/connection/test")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!)).toEqual({ provider: "did", api_key: key });
    expect(await screen.findByText("Connected, switched off")).toBeInTheDocument();
    expect(screen.getByLabelText("D-ID API key")).toHaveValue("");
    expect(screen.getByText(/Connected, ends …9xQz/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(key);
  });

  it("connected: avatars need consent for a photo; the agent's avatar and the switch save; Disconnect deletes the key", async () => {
    status = connected();
    mount();
    await screen.findByText("Connected, switched off");
    // a photo cannot be added before the consent box is ticked
    await userEvent.type(screen.getByLabelText("Name"), "Photo");
    await userEvent.click(screen.getByRole("combobox", { name: "Source" }));
    await userEvent.click(await screen.findByRole("option", { name: "A photo (https address)" }));
    await userEvent.type(screen.getByLabelText("Photo address"), "https://img.example.test/a.jpg");
    expect(screen.getByRole("button", { name: "Add avatar" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /the person in it has agreed/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add avatar" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/calls/avatar/avatars")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.path === "/api/calls/avatar/avatars")!.body!)).toEqual({ name: "Photo", source: "image", image_url: "https://img.example.test/a.jpg", consent: true });
    await userEvent.click(screen.getByRole("switch", { name: /Use the photoreal avatar/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/calls/settings")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.path === "/api/calls/settings")!.body!)).toEqual({ avatar: { enabled: true } });
    expect(within(screen.getByRole("region", { name: "Which agent uses which avatar" })).getByText("Aria")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Disconnect/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/calls/avatar/connection")).toBe(true));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
  });

  it("shows Failing with the reason, and the server's kill switch", async () => {
    status = { ...connected(), state: "failing", connection: { ...connected().connection, status: "failing", last_error: "D-ID refused the API key" } };
    mount();
    expect(await screen.findByText("Failing: using the built-in face")).toBeInTheDocument();
    expect(screen.getByText(/Last test: D-ID refused the API key/)).toBeInTheDocument();
    status = { ...connected(), state: "switched_off_on_server", kill_switch: true };
    document.body.innerHTML = "";
    mount();
    expect(await screen.findByText(/operator switched photoreal avatars off/)).toBeInTheDocument();
  });
});
