import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { ChannelConnection, ChannelStatuses } from "../../api/types";
import { ChannelSettings } from "./ChannelSettings";

let can = true;
vi.mock("../../auth/AuthContext", () => ({ useCan: () => can, useSession: () => ({ member: { role: "owner" } }) }));

const conn = (over: Partial<ChannelConnection> = {}): ChannelConnection => ({
  id: "chc_1", channel: "sms", provider: "twilio", status: "verified", masked: { account_sid: "AC…a1a1", auth_token: "…9f3a" }, account: { friendly_name: "Acme Twilio", type: "Trial", status: "active" },
  inbound_domain: null, event_public_key_set: false, verified_at: "2026-10-20T10:00:00Z", last_error: null, last_error_at: null,
  webhooks: { sms: "https://app.test/webhooks/c/wh_abc/twilio/sms", status: "https://app.test/webhooks/c/wh_abc/twilio/status" }, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", ...over,
});
const status = (sms: Partial<ChannelStatuses["sms"]> = {}): ChannelStatuses => ({
  sms: { channel: "sms", mode: "test", connected: false, provider: "console", source: "none", summary: "", details: {}, last_error: null, last_ok_at: null, ...sms },
  email: { channel: "email", mode: "test", connected: false, provider: "console", source: "none", summary: "", details: {}, last_error: null, last_ok_at: null },
  system_email: { mode: "test", provider: "console" },
});

const calls: { url: string; method: string; body?: string }[] = [];
function mount(connections: { sms: ChannelConnection | null; email: ChannelConnection | null }, st: ChannelStatuses, answer: (url: string, method: string) => Response | undefined = () => undefined) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string | undefined });
      const custom = answer(url, method);
      if (custom) return custom;
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
      if (url.includes("/channels/status")) return json(st);
      if (url.includes("/channels/connections")) return json(connections);
      return json({ data: [] });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ChannelSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Settings > Channels", () => {
  beforeEach(() => {
    can = true;
  });

  it("explains that SMS and email are in test mode and offers to connect", async () => {
    mount({ sms: null, email: null }, status());
    expect(await screen.findByTestId("channel-banner-sms")).toHaveTextContent("SMS is not connected. Messages are saved but not sent.");
    expect(screen.getByTestId("channel-banner-email")).toBeInTheDocument();
    expect(await screen.findByRole("form", { name: "Connect Twilio" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Connect SendGrid" })).toBeInTheDocument();
    expect(screen.getAllByText("Test mode").length).toBeGreaterThan(0);
  });

  it("saves the credentials and verifies them in one step, then forgets what was typed", async () => {
    mount({ sms: null, email: null }, status(), (url, method) => {
      if (method === "PUT") return new Response(JSON.stringify(conn({ status: "pending" })), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/verify")) return new Response(JSON.stringify({ connection: conn(), warnings: ["This is a Twilio trial account: texts reach verified numbers only."] }), { status: 200, headers: { "content-type": "application/json" } });
      return undefined;
    });
    const form = await screen.findByRole("form", { name: "Connect Twilio" });
    const sid = "AC" + "a1".repeat(16);
    await userEvent.type(screen.getByLabelText("Account SID"), sid);
    await userEvent.type(screen.getByLabelText("Auth Token"), "9f3a".repeat(8));
    expect(screen.getByLabelText("Auth Token")).toHaveAttribute("type", "password");
    await userEvent.click(within(form).getByRole("button", { name: /connect and verify/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/channels/sms/verify") && c.method === "POST")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/channels/sms/connection");
    expect(JSON.parse(put.body!)).toEqual({ account_sid: sid, auth_token: "9f3a".repeat(8) });
    expect(await screen.findByText(/trial account/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Auth Token")).toHaveValue("");
    expect(screen.getByLabelText("Account SID")).toHaveValue("");
  });

  it("shows only masked hints for a connected account, never a secret", async () => {
    const { container } = mount({ sms: conn(), email: null }, status({ mode: "live", connected: true, provider: "twilio", source: "workspace" }));
    expect(await screen.findByLabelText("Twilio connection")).toHaveTextContent("AC…a1a1");
    expect(container.textContent).toContain("…9f3a");
    expect(container.textContent).not.toContain("9f3a9f3a");
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByTestId("channel-banner-sms")).toBeNull();
  });

  it("shows the exact webhook URLs to paste into Twilio, with copy buttons", async () => {
    mount({ sms: conn(), email: null }, status({ mode: "live", connected: true }));
    const urls = await screen.findAllByTestId("webhook-url");
    expect(urls.map((u) => u.textContent)).toEqual(["https://app.test/webhooks/c/wh_abc/twilio/sms", "https://app.test/webhooks/c/wh_abc/twilio/status"]);
    expect(screen.getAllByRole("button", { name: /copy/i }).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the provider's mapped error when verification fails", async () => {
    mount({ sms: conn({ status: "pending", account: null }), email: null }, status({ mode: "attention" }), (url) =>
      url.includes("/verify") ? new Response(JSON.stringify({ error: { code: "CHANNEL_AUTH_FAILED", message: "Twilio rejected the Account SID / Auth Token. Paste them again from the Twilio Console (Account Info)." } }), { status: 422, headers: { "content-type": "application/json" } }) : undefined,
    );
    await userEvent.click(await screen.findByRole("button", { name: /verify credentials/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Twilio rejected the Account SID / Auth Token");
  });

  it("checks the webhook: lists the newest inbound events and their outcome", async () => {
    mount({ sms: conn(), email: null }, status({ mode: "live", connected: true }), (url) =>
      url.includes("/channels/sms/events") ? new Response(JSON.stringify({ data: [{ id: "e1", kind: "twilio_sms", outcome: "processed", detail: null, at: "2026-10-20T10:05:00Z" }, { id: "e2", kind: "twilio_sms", outcome: "rejected", detail: "signature does not match this workspace's auth token", at: "2026-10-20T10:04:00Z" }] }), { status: 200, headers: { "content-type": "application/json" } }) : undefined,
    );
    await userEvent.click(await screen.findByRole("button", { name: /check webhook/i }));
    const list = await screen.findByRole("list", { name: "Recent inbound events" });
    expect(list).toHaveTextContent("processed");
    expect(list).toHaveTextContent("rejected");
    expect(list).toHaveTextContent("signature does not match");
  });

  it("sends a test text", async () => {
    mount({ sms: conn(), email: null }, status({ mode: "live", connected: true }), (url, method) =>
      url.includes("/channels/sms/test") && method === "POST" ? new Response(JSON.stringify({ ok: true, to: "+14155550123", from: "+15550000001" }), { status: 200, headers: { "content-type": "application/json" } }) : undefined,
    );
    await userEvent.type(await screen.findByLabelText(/send a test text to/i), "+14155550123");
    await userEvent.click(screen.getByRole("button", { name: /send test/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/channels/sms/test"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.includes("/channels/sms/test"))!.body!)).toEqual({ to: "+14155550123" });
  });

  it("disconnect asks for confirmation first", async () => {
    mount({ sms: conn(), email: null }, status({ mode: "live", connected: true }));
    await userEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
    expect(await screen.findByText(/deletes the saved credentials/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("people without channels:manage see the status but no connection forms", async () => {
    can = false;
    mount({ sms: null, email: null }, status());
    expect(await screen.findByTestId("channel-banner-sms")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Connect Twilio" })).toBeNull();
    expect(calls.some((c) => c.url.includes("/channels/connections"))).toBe(false);
  });
});
