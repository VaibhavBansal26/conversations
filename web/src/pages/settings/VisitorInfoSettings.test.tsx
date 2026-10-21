import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VisitorInfoSettings, DEFAULT_INFO } from "./VisitorInfoSettings";

let info = DEFAULT_INFO;
vi.mock("../../auth/AuthContext", () => ({ useSession: () => ({ workspace: { settings: { widget: { visitor_info: info } } } }) }));
const calls: { method: string; body?: string }[] = [];

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", body: init?.body as string | undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <VisitorInfoSettings />
    </QueryClientProvider>,
  );
}

describe("VisitorInfoSettings", () => {
  beforeEach(() => {
    calls.length = 0;
    info = DEFAULT_INFO;
  });

  it("starts with everything off and the save button disabled until something changes", () => {
    mount();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const boxes = screen.getAllByRole("combobox");
    expect(boxes).toHaveLength(3);
    boxes.forEach((b) => expect(b).toHaveTextContent("Never ask"));
    expect(screen.getByRole("switch", { name: "When a conversation goes to a person" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "After the conversation is resolved" })).not.toBeChecked();
  });

  it("saves the moments, a custom choice field and the consent text in one patch", async () => {
    mount();
    await userEvent.click(screen.getByRole("switch", { name: "After the conversation is resolved" }));
    await userEvent.click(screen.getByRole("button", { name: /Add a field/ }));
    const group = screen.getByRole("group", { name: "Custom field 1" });
    await userEvent.type(within(group).getByLabelText("Name in the form"), "Your plan");
    await userEvent.type(within(group).getByLabelText(/^Key/), "plan");
    await userEvent.click(screen.getByRole("switch", { name: /Ask for consent/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
    const vi2 = body.settings.widget.visitor_info;
    expect(vi2.moments.after).toBe(true);
    expect(vi2.custom_fields).toEqual([{ key: "plan", label: "Your plan", type: "text", options: [], mode: "ask_when_needed" }]);
    expect(vi2.consent).toMatchObject({ enabled: true, privacy_url: null });
  });

  it("limits custom fields to five", async () => {
    info = { ...DEFAULT_INFO, custom_fields: Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, label: `F${i}`, type: "text" as const, options: [], mode: "optional" as const })) };
    mount();
    expect(screen.getByRole("button", { name: /Add a field/ })).toBeDisabled();
  });
});
