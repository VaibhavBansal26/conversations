import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { ChannelStatus } from "../../api/types";
import { makeMessage } from "../../test/factories";
import { upsertMessage, emptyThread } from "../../state/messageCache";
import { ChannelBanner } from "../channels/ChannelBanner";
import { MessageBubble } from "./MessageBubble";

const me = { type: "agent" as const, id: "mem_me", name: "Me" };
const props = { selfMemberId: "mem_me", first: true, last: true };
const testMsg = (over = {}) =>
  makeMessage({ sender: me, source: "sms", delivery: "not_sent_test_mode", failure_reason: "SMS is not connected. Messages are saved but not sent.", ...over });

describe("messages stored in test mode", () => {
  it("shows 'Test mode: not sent' and never a sent, delivered or read tick", () => {
    render(<MessageBubble {...props} message={testMsg({ read: true })} />);
    expect(screen.getByText("Test mode: not sent")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /sent|delivered|read|sending/i })).toBeNull();
  });

  it("explains how to fix it and offers to send once connected", async () => {
    const onRetry = vi.fn();
    const m = testMsg();
    render(<MessageBubble {...props} message={m} onRetry={onRetry} />);
    const note = screen.getByTestId("test-mode-note");
    expect(note).toHaveTextContent(/SMS is not connected/);
    expect(screen.getByRole("link", { name: /connect twilio/i })).toHaveAttribute("href", "/settings/channels");
    await userEvent.click(screen.getByRole("button", { name: /send it now/i }));
    expect(onRetry).toHaveBeenCalledWith(m);
  });

  it("names SendGrid for email", () => {
    render(<MessageBubble {...props} message={testMsg({ source: "email", subject: "Hi" })} />);
    expect(screen.getByRole("link", { name: /connect sendgrid/i })).toBeInTheDocument();
  });

  it("is not treated as failed and a delivered tick still renders for real messages", () => {
    render(<MessageBubble {...props} message={makeMessage({ sender: me, source: "sms", delivery: "delivered" })} />);
    expect(screen.getByRole("img", { name: "Delivered" })).toBeInTheDocument();
    expect(screen.queryByText(/test mode/i)).toBeNull();
  });

  it("a later 'sent' update replaces the test-mode state in the cache (message was retried after connecting)", () => {
    const a = testMsg({ id: "m1" });
    let t = upsertMessage(emptyThread, a);
    t = upsertMessage(t, { ...a, delivery: "sent", failure_reason: null });
    expect(t.messages[0]!.delivery).toBe("sent");
  });
});

const status = (over: Partial<ChannelStatus> = {}): ChannelStatus => ({
  channel: "sms", mode: "test", connected: false, provider: "console", source: "none", summary: "", details: {}, last_error: null, last_ok_at: null, ...over,
});

describe("ChannelBanner", () => {
  it("says the channel is not connected and links to Settings > Channels", () => {
    render(
      <MemoryRouter>
        <ChannelBanner status={status()} />
      </MemoryRouter>,
    );
    const banner = screen.getByTestId("channel-banner-sms");
    expect(banner).toHaveTextContent("SMS is not connected. Messages are saved but not sent. Connect Twilio in Settings > Channels.");
    expect(screen.getByRole("link", { name: "Settings > Channels" })).toHaveAttribute("href", "/settings/channels");
  });
  it("uses SendGrid wording for email", () => {
    render(
      <MemoryRouter>
        <ChannelBanner status={status({ channel: "email" })} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("channel-banner-email")).toHaveTextContent("Email is not connected. Messages are saved but not sent. Connect SendGrid");
  });
  it("renders nothing when the channel is live", () => {
    const { container } = render(
      <MemoryRouter>
        <ChannelBanner status={status({ mode: "live", connected: true })} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
