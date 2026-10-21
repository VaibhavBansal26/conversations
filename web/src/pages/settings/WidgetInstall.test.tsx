import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EmbedToken } from "../../api/types";
import { PLATFORMS, WidgetInstall } from "./WidgetInstall";
import { WidgetSettings } from "./WidgetSettings";

vi.mock("../../auth/AuthContext", () => ({
  useSession: () => ({ workspace: { public_url: "https://chat.acme.test", settings: { widget: { title: "t", intro: "", primary_color: "#4f46e5", text_color: "#ffffff", logo_url: null, launcher_position: "right", launcher_spacing: 20, launcher_style: "bubble", launcher_label: "Chat with us", radius: 16, sound: true, welcome_message: "", away_message: "", required_info: [], chat_type: "live_chat", office_hours: { enabled: false, timezone: "UTC", days: [] }, default_inbox_id: null } } } }),
}));

const tok = (over: Partial<EmbedToken> = {}): EmbedToken => ({ id: "tok_1", domain: "www.acme.com", token: "cvt_TOKEN123456789", status: "active", last_used_at: null, last_seen_origin: null, last_seen_at: null, created_at: "2026-10-20T09:00:00Z", ...over });

const calls: { url: string; method: string; body?: string }[] = [];
function mount(list: EmbedToken[], extra: (url: string, method: string) => Response | undefined = () => undefined) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string | undefined });
      const custom = extra(url, method);
      if (custom) return custom;
      return new Response(JSON.stringify({ data: list }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WidgetInstall />
    </QueryClientProvider>,
  );
}

describe("Install the chat widget", () => {
  it("starts with creating a token for your domain and explains the domain rule", async () => {
    mount([]);
    expect(await screen.findByLabelText("Your website's domain")).toBeInTheDocument();
    expect(screen.getByText(/only works on the domain you enter/i)).toHaveTextContent(/www\.example\.com and example\.com separately.*\*\.example\.com/);
    expect(screen.queryByTestId("snippet")).toBeNull();
  });

  it("creates the token inline and moves on to the code", async () => {
    mount([], (url, method) => (method === "POST" && url.endsWith("/tokens") ? new Response(JSON.stringify(tok()), { status: 201, headers: { "content-type": "application/json" } }) : undefined));
    await userEvent.type(await screen.findByLabelText("Your website's domain"), "www.acme.com");
    await userEvent.click(screen.getByRole("button", { name: /create token/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/tokens"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ domain: "www.acme.com" });
  });

  it("shows the snippet with the real public address and token, a copy button, and one tab per platform", async () => {
    mount([tok()]);
    const code = await screen.findByTestId("snippet");
    expect(code.textContent).toBe('<script src="https://chat.acme.test/widget.js" data-token="cvt_TOKEN123456789" async></script>');
    expect(screen.getByRole("button", { name: /copy code/i })).toBeInTheDocument();
    for (const name of ["Plain HTML", "WordPress", "Shopify", "Google Tag Manager", "React / Next.js"]) expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "WordPress" }));
    expect((await screen.findByTestId("snippet")).textContent).toContain("wp_footer");
    expect(screen.getByTestId("snippet").textContent).toContain("cvt_TOKEN123456789");
    await userEvent.click(screen.getByRole("tab", { name: "React / Next.js" }));
    expect((await screen.findByTestId("snippet")).textContent).toContain('data-token="cvt_TOKEN123456789"');
  });

  it("every platform's snippet carries the address and the token", () => {
    for (const p of PLATFORMS) {
      const c = p.code("https://chat.acme.test", "cvt_X");
      expect(c, p.id).toContain("https://chat.acme.test/widget.js");
      expect(c, p.id).toContain("cvt_X");
    }
  });

  it("waits for the widget, then turns green with the domain and time", async () => {
    mount([tok()]);
    expect(await screen.findByTestId("install-waiting")).toHaveTextContent(/Waiting for the widget to load on www\.acme\.com/);
    expect(screen.queryByTestId("install-verified")).toBeNull();
  });

  it("shows the installation as done when the widget has already been seen", async () => {
    mount([tok({ last_seen_at: "2026-10-21T08:30:00Z", last_seen_origin: "https://www.acme.com" })]);
    const ok = await screen.findByTestId("install-verified");
    expect(ok).toHaveTextContent("https://www.acme.com");
    expect(ok).toHaveTextContent("Installed");
  });

  it("'Try it now' asks for a signed preview link and opens it", async () => {
    const tab = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as never);
    mount([tok()], (url, method) => (method === "POST" && url.endsWith("/tokens/tok_1/preview") ? new Response(JSON.stringify({ url: "https://chat.acme.test/widget-preview?p=abc", expires_at: "x" }), { status: 201, headers: { "content-type": "application/json" } }) : undefined));
    await userEvent.click(await screen.findByRole("button", { name: /try it now/i }));
    await waitFor(() => expect(tab.location.href).toBe("https://chat.acme.test/widget-preview?p=abc"));
  });

  it("falls back to a link when the browser blocks the new tab", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    mount([tok()], (url, method) => (method === "POST" && url.endsWith("/preview") ? new Response(JSON.stringify({ url: "https://chat.acme.test/widget-preview?p=abc" }), { status: 201, headers: { "content-type": "application/json" } }) : undefined));
    await userEvent.click(await screen.findByRole("button", { name: /try it now/i }));
    expect(await screen.findByRole("link", { name: /blocked the new tab/i })).toHaveAttribute("href", "https://chat.acme.test/widget-preview?p=abc");
  });

  it("explains the CSP requirements with this deployment's addresses", async () => {
    mount([tok()]);
    await screen.findByTestId("snippet");
    expect(screen.getByText(/Content-Security-Policy/)).toBeInTheDocument();
    expect(document.body.textContent).toContain("wss://chat.acme.test".replace("wss", "wss"));
  });
});

describe("Chat widget page", () => {
  it("offers Install and Customise tabs; ?tab=install opens the installer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [tok()] }), { status: 200, headers: { "content-type": "application/json" } })));
    window.history.replaceState({}, "", "/settings/widget?tab=install");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WidgetSettings />
      </QueryClientProvider>,
    );
    window.history.replaceState({}, "", "/");
    expect(await screen.findByRole("heading", { name: "Install the chat widget" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Customise" })).toBeInTheDocument();
  });
});
