import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { TeamMessageView } from "./TeamMessageView";
import { msg } from "./cache.test";

const props = { selfId: "mem_me", first: true };
const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("TeamMessageView", () => {
  it("shows the sender, text with @mentions as names, an edited marker and a pinned marker", () => {
    wrap(<TeamMessageView {...props} message={msg({ content: "ping @[Bo Agent](mem_bo) now", edited_at: "2026-01-05T10:01:00Z", pinned: true })} />);
    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.getByText("@Bo Agent")).toBeInTheDocument();
    expect(screen.getByText("(edited)")).toBeInTheDocument();
    expect(screen.getByText("Pinned")).toBeInTheDocument();
  });

  it("toggles a reaction by clicking it and says whether you reacted", async () => {
    const onReact = vi.fn();
    const m = msg({ reactions: [{ emoji: "🎉", count: 2, member_ids: ["mem_me", "mem_x"] }, { emoji: "👍", count: 1, member_ids: ["mem_x"] }] });
    wrap(<TeamMessageView {...props} message={m} onReact={onReact} />);
    const mine = screen.getByRole("button", { name: "🎉 2, you reacted" });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "👍 1" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(mine);
    expect(onReact).toHaveBeenCalledWith(m, "🎉");
  });

  it("opens the thread from the reply counter", async () => {
    const onOpenThread = vi.fn();
    const m = msg({ reply_count: 3 });
    wrap(<TeamMessageView {...props} message={m} onOpenThread={onOpenThread} />);
    await userEvent.click(screen.getByRole("button", { name: "3 replies" }));
    expect(onOpenThread).toHaveBeenCalledWith(m);
    expect(screen.queryByRole("button", { name: /replies/ })).not.toBeNull();
  });

  it("only the author can edit; delete for the author and for moderators; nothing for read-only viewers", async () => {
    const mineMsg = msg({ sender: { id: "mem_me", name: "Me" } });
    const { unmount } = wrap(<TeamMessageView {...props} message={mineMsg} />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /Edit message/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Delete message/ })).toBeInTheDocument();
    unmount();
    const { unmount: u2 } = wrap(<TeamMessageView {...props} message={msg()} />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /Edit message/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Delete message/ })).toBeNull();
    u2();
    const { unmount: u3 } = wrap(<TeamMessageView {...props} message={msg()} canModerate />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: /Delete message/ })).toBeInTheDocument();
    u3();
    wrap(<TeamMessageView {...props} message={mineMsg} readOnly />);
    expect(screen.queryByRole("group", { name: "Message actions" })).toBeNull();
  });

  it("edits in place: Enter saves, Escape cancels", async () => {
    const onEdit = vi.fn();
    const m = msg({ sender: { id: "mem_me", name: "Me" }, content: "first draft" });
    wrap(<TeamMessageView {...props} message={m} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Edit message/ }));
    const box = screen.getByRole("textbox", { name: "Edit message" });
    expect(box).toHaveValue("first draft");
    await userEvent.clear(box);
    await userEvent.type(box, "second draft{Enter}");
    expect(onEdit).toHaveBeenCalledWith(m, "second draft");
  });

  it("a shared conversation card links to the inbox when available, and is a bare locked card when not", () => {
    const { unmount } = wrap(<TeamMessageView {...props} message={msg({ kind: "share", content: "", content_text: "", share: { room_id: "room_1", available: true, title: "Dana Customer", status: "open" } })} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/inbox/room_1");
    expect(screen.getByTestId("share-card")).toHaveTextContent("Dana Customer");
    unmount();
    const { container } = wrap(<TeamMessageView {...props} message={msg({ kind: "share", content: "", content_text: "", share: { room_id: "room_1", available: false } })} />);
    expect(screen.getByTestId("share-card")).toHaveAttribute("data-available", "false");
    expect(screen.getByTestId("share-card")).toHaveTextContent("You do not have access to it");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("Dana");
  });

  it("failed sends show the reason and a retry; images and files render as attachments", async () => {
    const onRetry = vi.fn();
    const failed = msg({ id: "local-1", local: { status: "failed", error: "Not a member" } });
    const { unmount } = wrap(<TeamMessageView {...props} message={failed} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not sent: Not a member");
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith(failed);
    unmount();
    wrap(<TeamMessageView {...props} message={msg({ attachments: [{ id: "a1", file_name: "shot.png", content_type: "image/png", size: 2048, url: "https://f/x.png" }, { id: "a2", file_name: "notes.pdf", content_type: "application/pdf", size: 4096, url: "https://f/y.pdf" }] })} />);
    expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /notes\.pdf/ })).toHaveAttribute("href", "https://f/y.pdf");
  });
});
