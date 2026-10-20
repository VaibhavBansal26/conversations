import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WidgetSettings as Widget } from "../../api/types";
import { WidgetSettings } from "./WidgetSettings";

const widget: Widget = {
  title: "Chat with us",
  intro: "We usually reply within a few minutes.",
  primary_color: "#4f46e5",
  text_color: "#ffffff",
  logo_url: null,
  launcher_position: "right",
  launcher_spacing: 20,
  launcher_style: "bubble",
  launcher_label: "Chat with us",
  radius: 16,
  sound: true,
  welcome_message: "Hi there!",
  away_message: "We are away.",
  required_info: [],
  chat_type: "live_chat",
  office_hours: { enabled: false, timezone: "UTC", days: [] },
  default_inbox_id: null,
};

vi.mock("../../auth/AuthContext", () => ({ useSession: () => ({ workspace: { settings: { widget } } }) }));

const calls: { url: string; method: string; body?: string }[] = [];

function mount() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if ((init?.method ?? "GET") === "PATCH") return json({ id: "ws", name: "W", settings: { widget: JSON.parse(String(init?.body)).settings.widget } });
      return json({ data: [] });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WidgetSettings />
    </QueryClientProvider>,
  );
}

describe("WidgetSettings customiser", () => {
  it("updates the live preview as the form changes and keeps save disabled until something changed", async () => {
    mount();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const title = screen.getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "Ask Acme");
    expect(screen.getByRole("group", { name: "Live widget preview" })).toHaveTextContent("Ask Acme");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("warns about low colour contrast and fixes it on request", async () => {
    mount();
    expect(screen.queryByRole("alert")).toBeNull();
    const brand = screen.getByLabelText("Brand colour");
    await userEvent.clear(brand);
    await userEvent.type(brand, "#ffe066");
    expect(screen.getByRole("alert")).toHaveTextContent(/low contrast/i);
    await userEvent.click(screen.getByRole("button", { name: "Fix automatically" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Text colour")).toHaveValue("#14141a");
  });

  it("switches the launcher style (label field only for the pill) and previews it", async () => {
    mount();
    expect(screen.queryByLabelText("Launcher label")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /Pill/ }));
    expect(screen.getByLabelText("Launcher label")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Closed" }));
    expect(screen.getByTestId("preview-launcher")).toHaveAttribute("data-style", "pill");
  });

  it("saves the new widget fields", async () => {
    mount();
    await userEvent.click(screen.getByRole("radio", { name: /Square/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
    expect(body.settings.widget).toMatchObject({ launcher_style: "icon", radius: 16, launcher_label: "Chat with us" });
  });
});
