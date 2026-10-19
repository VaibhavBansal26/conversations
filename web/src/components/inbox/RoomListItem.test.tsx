import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { Member } from "../../api/types";
import { FIXED_NOW, makeRoom } from "../../test/factories";
import { RoomListItem } from "./RoomListItem";

const member = { id: "mem_1", name: "Sam Lee" } as Member;
const renderItem = (room = makeRoom(), selected = false) =>
  render(
    <MemoryRouter>
      <ul>
        <RoomListItem room={room} selected={selected} to={`/inbox/${room.id}`} members={new Map([[member.id, member]])} now={FIXED_NOW} />
      </ul>
    </MemoryRouter>,
  );

describe("RoomListItem", () => {
  it("shows contact name, snippet, relative time and channel", () => {
    renderItem(
      makeRoom({
        last_message_at: "2026-01-05T11:55:00.000Z",
        last_message: { id: "m", kind: "text", source: "sms", sender_type: "contact", sender_name: "Ada", snippet: "Is it shipped yet?", created_at: "2026-01-05T11:55:00.000Z" },
      }),
    );
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText(/Is it shipped yet\?/)).toBeInTheDocument();
    expect(screen.getByText("5m")).toBeInTheDocument();
    expect(screen.getByText(/^SMS\./)).toBeInTheDocument();
  });

  it("caps the unread badge at 99+ and hides it at zero", () => {
    const { unmount } = renderItem(makeRoom({ unread_count: 250 }));
    expect(screen.getByLabelText("250 unread")).toHaveTextContent("99+");
    unmount();
    renderItem(makeRoom({ unread_count: 0 }));
    expect(screen.queryByText(/unread/)).toBeNull();
  });

  it("flags priority and favorites, shows assignees, and marks the selected row", () => {
    renderItem(makeRoom({ priority: 1, favorite: true, assignee_ids: ["mem_1"] }), true);
    expect(screen.getByRole("img", { name: "Priority" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Favorite" })).toBeInTheDocument();
    expect(screen.getByLabelText("Assigned to Sam Lee")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "true");
  });

  it("prefixes own messages with 'You' and notes with 'Note'", () => {
    const base = { id: "m", source: "dm" as const, sender_name: "Me", snippet: "On it", created_at: "2026-01-05T11:55:00.000Z" };
    const { unmount } = renderItem(makeRoom({ last_message: { ...base, kind: "text", sender_type: "agent" } }));
    expect(screen.getByText(/You: On it/)).toBeInTheDocument();
    unmount();
    renderItem(makeRoom({ last_message: { ...base, kind: "note", sender_type: "agent" } }));
    expect(screen.getByText(/Note: On it/)).toBeInTheDocument();
  });
});
