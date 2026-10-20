import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeMessage } from "../../test/factories";
import { MessageBubble } from "./MessageBubble";

let canRequest = true;
vi.mock("../../auth/AuthContext", () => ({ useCan: () => canRequest, useSession: () => ({ member: { id: "mem_me" }, workspace: {} }) }));

const post = vi.fn(async () => ({}));
vi.mock("../../api/client", () => ({ api: { post: (...a: unknown[]) => (post as (...x: unknown[]) => unknown)(...a) } }));

const card = (o: Record<string, unknown> = {}) => ({ type: "payment_request", id: "pay_1", amount: 2500, currency: "usd", description: "Deposit for the install", status: "open", url: "https://pay.test/x", paid_at: null, ...o });
const bubble = (c: unknown) => (
  <QueryClientProvider client={new QueryClient()}>
    <MessageBubble selfMemberId="mem_me" first last message={makeMessage({ sender: { type: "agent", id: "mem_me", name: "Me" }, content_text: "Payment request: Deposit - $25.00\nPay securely: https://pay.test/x", meta: { card: c } })} />
  </QueryClientProvider>
);

describe("payment card in a message", () => {
  beforeEach(() => {
    canRequest = true;
    post.mockClear();
  });

  it("replaces the plain text with a card showing amount, description and status", () => {
    render(bubble(card()));
    const g = screen.getByRole("group", { name: /payment request, awaiting payment/i });
    expect(g).toHaveTextContent("$25.00");
    expect(g).toHaveTextContent("Deposit for the install");
    expect(screen.queryByText(/Pay securely/)).toBeNull();
    expect(screen.getByRole("link", { name: /open payment page/i })).toHaveAttribute("href", "https://pay.test/x");
  });

  it("lets an agent with the permission cancel an open request", async () => {
    render(bubble(card()));
    await userEvent.click(screen.getByRole("button", { name: /cancel request/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/payment-requests/pay_1/cancel", {}));
  });

  it("hides the actions without the permission, and once the request is no longer open", () => {
    canRequest = false;
    const { rerender } = render(bubble(card()));
    expect(screen.queryByRole("button", { name: /cancel request/i })).toBeNull();
    canRequest = true;
    rerender(bubble(card({ status: "paid", url: null, paid_at: "2026-03-02T10:00:00.000Z" })));
    expect(screen.getByRole("group", { name: /payment request, paid/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel request/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /open payment page/i })).toBeNull();
  });
});
