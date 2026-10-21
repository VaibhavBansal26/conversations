import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { checklistKey, GettingStartedCard } from "./GettingStartedCard";

let can = true;
vi.mock("../../auth/AuthContext", () => ({ useCan: () => can, useSession: () => ({ workspace: { id: "ws_1" } }) }));

const items = (done: Record<string, boolean>) => ["invite_teammates", "connect_sms", "connect_email", "install_widget", "create_template"].map((id) => ({ id, done: !!done[id], href: `/settings/${id}` }));
function mount(done: Record<string, boolean>, status = 200) {
  const list = items(done);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status === 200 ? { items: list, done: list.filter((i) => i.done).length, total: 5 } : { error: { code: "X", message: "x" } }), { status, headers: { "content-type": "application/json" } })));
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <GettingStartedCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("GettingStartedCard", () => {
  beforeEach(() => {
    can = true;
    localStorage.clear();
  });

  it("shows progress and one link per step to the screen that does it, ticking what is done", async () => {
    mount({ connect_sms: true, create_template: true });
    expect(await screen.findByText("2 of 5 done")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Setup progress" })).toHaveAttribute("aria-valuenow", "2");
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/settings/invite_teammates", "/settings/connect_sms", "/settings/connect_email", "/settings/install_widget", "/settings/create_template"]);
    expect(links.map((l) => l.getAttribute("data-done"))).toEqual(["false", "true", "false", "false", "true"]);
    expect(screen.getAllByLabelText("Done")).toHaveLength(2);
    expect(screen.getByText("Install the chat widget")).toBeInTheDocument();
  });

  it("says so when everything is done", async () => {
    mount({ invite_teammates: true, connect_sms: true, connect_email: true, install_widget: true, create_template: true });
    expect(await screen.findByText("You are all set up")).toBeInTheDocument();
  });

  it("can be collapsed and dismissed (remembered per workspace); dismissing never changes progress", async () => {
    const { unmount } = mount({});
    await userEvent.click(await screen.findByRole("button", { name: "Collapse getting started" }));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss getting started" }));
    expect(screen.queryByTestId("getting-started")).toBeNull();
    expect(localStorage.getItem(checklistKey("ws_1"))).toBe("1");
    unmount();
    mount({});
    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("is for the people who can set things up: others do not see it and no request is made", () => {
    can = false;
    mount({});
    expect(screen.queryByTestId("getting-started")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays out of the way when the checklist cannot be loaded", async () => {
    mount({}, 500);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("getting-started")).toBeNull();
  });
});
