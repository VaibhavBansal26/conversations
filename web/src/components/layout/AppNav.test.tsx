import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { BottomNav, NavRail } from "./AppNav";

let teamAllowed = true;
vi.mock("../../api/hooks", () => ({ useCounts: () => ({ data: { unread_rooms: 2 } }) }));
vi.mock("../../auth/AuthContext", () => ({ useCan: () => teamAllowed }));
vi.mock("../../team/hooks", () => ({
  useTeamChannels: () => ({ data: [{ id: "c1", unread: 4, mention_unread: 0, muted: false }, { id: "c2", unread: 9, mention_unread: 1, muted: false }] }),
}));
vi.mock("./NotificationsMenu", () => ({ NotificationsMenu: () => null }));
vi.mock("./UserMenu", () => ({ UserMenu: () => null }));
vi.mock("../../ui", async (orig) => ({ ...(await orig<object>()), ThemeToggle: () => null }));

function Go({ to }: { to: string }) {
  const nav = useNavigate();
  return (
    <button type="button" onClick={() => nav(to)}>
      go {to}
    </button>
  );
}

describe("main navigation", () => {
  beforeEach(() => {
    teamAllowed = true;
  });

  it("lists Inbox, Team (badge: mentions win over unread), Analytics and Settings", () => {
    render(
      <MemoryRouter>
        <NavRail onHelp={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Team, 1 unread" })).toHaveAttribute("href", "/team");
    expect(screen.getByRole("link", { name: "Inbox, 2 unread" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Analytics" })).toBeInTheDocument();
  });

  it("hides Team from roles without team_chat:use", () => {
    teamAllowed = false;
    render(
      <MemoryRouter>
        <NavRail onHelp={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /^Team/ })).toBeNull();
  });

  it("the bottom navigation hides inside a conversation or a channel and comes back, without breaking hook order", async () => {
    render(
      <MemoryRouter initialEntries={["/inbox"]}>
        <BottomNav onHelp={() => undefined} />
        <Go to="/inbox/room_1" />
        <Go to="/team/tch_1" />
        <Go to="/team" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "go /inbox/room_1" }));
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "go /team/tch_1" }));
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "go /team" }));
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });
});
