import { useMutation } from "@tanstack/react-query";
import { BadgeCheck, CircleDollarSign, Clock, Ban, RotateCcw, TimerOff } from "lucide-react";
import { api } from "../../api/client";
import { useCan } from "../../auth/AuthContext";
import { formatMoney } from "../../lib/money";
import { formatClock } from "../../lib/time";
import { Badge, Button, buttonVariants, cn } from "../../ui";

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
const TONE = { open: "warning", paid: "success", expired: "neutral", canceled: "neutral", refunded: "info" } as const;
const ICON = { open: Clock, paid: BadgeCheck, expired: TimerOff, canceled: Ban, refunded: RotateCcw } as const;

/** The payment request as it appears in the thread. Its status changes live (message:updated) when Stripe confirms the payment. */
export function PaymentCard({ card }: { card: PaymentCardData }) {
  const can = useCan("payments:request");
  // the card updates itself when the server broadcasts message:updated, so there is nothing to invalidate here
  const cancel = useMutation({ mutationFn: () => api.post(`/payment-requests/${card.id}/cancel`, {}) });
  const StatusIcon = ICON[card.status];
  return (
    <div className="w-64 max-w-full overflow-hidden rounded-xl border border-border bg-surface text-foreground shadow-xs" role="group" aria-label={`Payment request, ${LABEL[card.status]}`} data-status={card.status}>
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3.5 py-2 text-xs font-medium text-muted-foreground">
        <CircleDollarSign className="size-4" aria-hidden="true" /> Payment request
      </div>
      <div className="space-y-1 px-3.5 py-3">
        <div className={cn("text-2xl font-semibold tabular-nums tracking-tight", (card.status === "canceled" || card.status === "expired") && "text-subtle line-through")}>{formatMoney(card.amount, card.currency)}</div>
        <div className="text-[13px] text-muted-foreground">{card.description}</div>
        <div className="flex items-center gap-2 pt-1">
          <Badge tone={TONE[card.status]}>
            <StatusIcon className="size-3" aria-hidden="true" />
            {LABEL[card.status]}
          </Badge>
          {card.paid_at && (
            <time dateTime={card.paid_at} className="text-xs text-subtle">
              {formatClock(card.paid_at)}
            </time>
          )}
        </div>
      </div>
      {card.status === "open" && can && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
          {card.url && (
            <a className={buttonVariants({ variant: "outline", size: "sm" })} href={card.url} target="_blank" rel="noopener noreferrer">
              Open payment page
            </a>
          )}
          <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel request
          </Button>
          {cancel.isError && (
            <span role="alert" className="w-full text-xs text-danger-text">
              Could not cancel. It may already be paid or expired.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
