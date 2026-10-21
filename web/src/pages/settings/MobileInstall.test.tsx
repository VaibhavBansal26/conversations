import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EmbedToken } from "../../api/types";
import { hostedChatUrl, MobileInstall } from "./MobileInstall";

const tok = (over: Partial<EmbedToken> = {}): EmbedToken => ({ id: "tok_1", domain: "app.acme.com", token: "cvt_TOKEN123456789", status: "active", last_used_at: null, created_at: "2026-10-20T09:00:00Z", hosted_chat_enabled: false, ...over });

const calls: { url: string; method: string; body?: string }[] = [];
function mount(token: EmbedToken, identity = { configured: false, enforce: false, rotated_at: null as string | null }) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string | undefined });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/identity/rotate")) return json({ secret: "cvi_ONLYSHOWNONCE", enforce: false, rotated_at: "2026-10-21T10:00:00Z" }, 201);
      if (url.endsWith("/identity")) return json(method === "PATCH" ? { ...identity, enforce: true } : identity);
      return json({ ...token, hosted_chat_enabled: true });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MobileInstall token={token} publicUrl="https://chat.acme.test/" />
    </QueryClientProvider>,
  );
}

describe("Mobile apps and web views", () => {
  it("builds the hosted chat URL from the deployment address and the token", () => {
    expect(hostedChatUrl("https://chat.acme.test/", "cvt_x")).toBe("https://chat.acme.test/chat?token=cvt_x");
    expect(hostedChatUrl("https://chat.acme.test", "cvt_x")).toBe("https://chat.acme.test/chat?token=cvt_x");
  });

  it("is off by default, shows no URL, and switching it on sends the PATCH", async () => {
    mount(tok());
    const sw = await screen.findByRole("switch", { name: /hosted chat for this token/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("hosted-url")).toBeNull();
    await userEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/tokens/tok_1") && c.body === JSON.stringify({ hosted_chat_enabled: true }))).toBe(true));
  });

  it("shows the copyable URL when enabled and links the conformance page", async () => {
    mount(tok({ hosted_chat_enabled: true }));
    expect(await screen.findByTestId("hosted-url")).toHaveTextContent("https://chat.acme.test/chat?token=cvt_TOKEN123456789");
    expect(screen.getByRole("link", { name: "/chat/bridge-test" })).toHaveAttribute("href", "https://chat.acme.test/chat/bridge-test?token=cvt_TOKEN123456789");
  });

  it("creates the identity secret, shows it once with a warning, and offers enforcement afterwards", async () => {
    mount(tok(), { configured: false, enforce: false, rotated_at: null });
    await userEvent.click(await screen.findByRole("button", { name: "Create secret" }));
    expect(await screen.findByTestId("identity-secret")).toHaveTextContent("cvi_ONLYSHOWNONCE");
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
    expect(screen.getByText(/never put it in an app/i)).toBeInTheDocument();
  });

  it("with a secret configured the enforcement switch is there and sends the PATCH", async () => {
    mount(tok(), { configured: true, enforce: false, rotated_at: "2026-10-20T09:00:00Z" });
    const sw = await screen.findByRole("switch", { name: /ignore unsigned identity/i });
    expect(screen.getByRole("button", { name: "Replace secret" })).toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/identity") && c.body === JSON.stringify({ enforce: true }))).toBe(true));
  });
});
