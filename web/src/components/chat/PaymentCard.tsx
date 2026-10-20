import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useCan } from "../../auth/AuthContext";
import { formatMoney } from "../../lib/money";
import { formatClock } from "../../lib/time";
import { Icon } from "../../ui";

export interface PaymentCardData {
  type: "payment_request";
  id: string;
  amount: number;
  currency: string;
  description: string;
  status: "open" | "paid" | "expired" | "canceled" | "refunded";
  url: string | null;
  paid_at: string | null;
}

export const asPaymentCard = (meta: Record<string, unknown>): PaymentCardData | null => {
  const c = meta.card as PaymentCardData | undefined;
  return c && c.type === "payment_request" ? c : null;
};

const LABEL: Record<PaymentCardData["status"], string> = { open: "Awaiting payment", paid: "Paid", expired: "Expired", canceled: "Cancelled", refunded: "Refunded" };

/** The payment request as it appears in the thread. Its status changes live (message:updated) when Stripe confirms the payment. */
export function PaymentCard({ card }: { card: PaymentCardData }) {
  const can = useCan("payments:request");
  // the card updates itself when the server broadcasts message:updated, so there is nothing to invalidate here
  const cancel = useMutation({ mutationFn: () => api.post(`/payment-requests/${card.id}/cancel`, {}) });
  return (
    <div className={`pay-card status-${card.status}`} role="group" aria-label={`Payment request, ${LABEL[card.status]}`}>
      <div className="pay-amount">{formatMoney(card.amount, card.currency)}</div>
      <div className="pay-desc">{card.description}</div>
      <div className="pay-status">
        <Icon name={card.status === "paid" ? "check" : "clock"} size={14} />
        <span>{LABEL[card.status]}</span>
        {card.paid_at && <time dateTime={card.paid_at}>{formatClock(card.paid_at)}</time>}
      </div>
      {card.status === "open" && can && (
        <div className="pay-actions">
          {card.url && (
            <a className="btn btn-sm btn-outline" href={card.url} target="_blank" rel="noopener noreferrer">
              Open payment page
            </a>
          )}
          <button type="button" className="btn btn-sm btn-ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel request
          </button>
          {cancel.isError && <span role="alert" className="field-error">Could not cancel. It may already be paid or expired.</span>}
        </div>
      )}
    </div>
  );
}
