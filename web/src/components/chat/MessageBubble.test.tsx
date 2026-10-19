import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SendPayload } from "../../api/types";
import { makeMessage } from "../../test/factories";
import { MessageBubble } from "./MessageBubble";

const me = { type: "agent" as const, id: "mem_me", name: "Me" };
const props = { selfMemberId: "mem_me", first: true, last: true };

describe("MessageBubble", () => {
  it("renders a customer message with sender name and text", () => {
    render(<MessageBubble {...props} message={makeMessage({ content_text: "Where is my order?" })} />);
    expect(screen.getByText("Where is my order?")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("renders internal notes distinctly with a label and @mention tokens as names", () => {
    const { container } = render(<MessageBubble {...props} message={makeMessage({ kind: "note", sender: me, content_text: "cc @[Sam Lee](mem_2) please check" })} />);
    expect(screen.getByText(/Internal note/)).toBeInTheDocument();
    expect(screen.getByText("@Sam Lee")).toBeInTheDocument();
    expect(container.querySelector(".bubble.note")).not.toBeNull();
    expect(container.textContent).not.toContain("mem_2");
    expect(screen.queryByRole("img", { name: /sent|delivered|read/i })).toBeNull();
  });

  it("renders system messages as a centered status line", () => {
    const { container } = render(
      <MessageBubble {...props} message={makeMessage({ kind: "system", sender: { type: "system", id: null, name: "" }, content_text: "Conversation reopened", meta: { sub_type: "status" } })} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("Conversation reopened");
    expect(container.querySelector(".bubble")).toBeNull();
  });

  it("shows 'Failed to send: <reason>' with a Retry button that reports the message", async () => {
    const onRetry = vi.fn();
    const failed = makeMessage({ sender: me, delivery: "failed", failure_reason: "Carrier rejected the number" });
    render(<MessageBubble {...props} message={failed} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to send: Carrier rejected the number");
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it("treats a local failed send like a failed delivery", () => {
    const local = makeMessage({ sender: me, delivery: "failed", local: { status: "failed", error: "Cannot reach the server", payload: {} as SendPayload } });
    render(<MessageBubble {...props} message={local} onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to send: Cannot reach the server");
  });

  it.each([
    [{ delivery: "pending" as const }, "Sending"],
    [{ delivery: "sent" as const }, "Sent"],
    [{ delivery: "delivered" as const }, "Delivered"],
    [{ delivery: "delivered" as const, read: true }, "Read"],
  ])("shows delivery ticks for %j", (state, label) => {
    render(<MessageBubble {...props} message={makeMessage({ sender: me, ...state })} />);
    expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
  });

  it("renders the quoted message and attachments (image, audio, file chip)", () => {
    render(
      <MessageBubble
        {...props}
        message={makeMessage({
          ref: { id: "m0", sender_name: "Sam", sender_type: "agent", kind: "text", snippet: "Earlier text", deleted: false },
          attachments: [
            { id: "a1", file_name: "photo.png", content_type: "image/png", size: 10, url: "/files/a1" },
            { id: "a2", file_name: "note.webm", content_type: "audio/webm", size: 20, url: "/files/a2" },
            { id: "a3", file_name: "invoice.pdf", content_type: "application/pdf", size: 2048, url: "/files/a3" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Earlier text")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute("src", "/files/a1");
    expect(screen.getByLabelText("Voice note note.webm")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /invoice\.pdf/ })).toHaveAttribute("href", "/files/a3");
  });

  it("offers reply, and edit/delete only for the viewer's own text messages", async () => {
    const onReply = vi.fn();
    const own = makeMessage({ sender: me });
    const { rerender } = render(<MessageBubble {...props} message={own} onReply={onReply} onEdit={vi.fn()} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Reply to this message" }));
    expect(onReply).toHaveBeenCalledWith(own);
    expect(screen.getByRole("button", { name: "Edit message" })).toBeInTheDocument();
    rerender(<MessageBubble {...props} message={makeMessage()} onReply={onReply} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete message" })).toBeNull();
  });
});
