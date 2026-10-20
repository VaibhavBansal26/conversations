import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { Channel } from "../../api/types";
import { formatMoney, parseMajorToMinor } from "../../lib/money";
import { Button, Dialog, ErrorNotice, Field, Input, NativeSelect } from "../../ui";

interface Props {
  roomId: string;
  onClose: () => void;
  currency?: string;
}

/** "Request payment": amount + description, delivered on the channel the agent picks. Payments go to the workspace's own Stripe account. */
export function RequestPaymentDialog({ roomId, onClose, currency = "usd" }: Props) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<Channel>("dm");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const minor = parseMajorToMinor(amount);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!minor) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/rooms/${roomId}/payment-requests`, { amount: minor, currency, description: description.trim(), source });
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog title="Request payment" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label={`Amount (${currency.toUpperCase()})`} hint="Up to two decimals, for example 25 or 25.50." error={amount && !minor ? "Enter an amount above zero, such as 25.50" : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus autoComplete="off" />
        </Field>
        <Field label="What is it for?">
          <Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Deposit for the installation" />
        </Field>
        <Field label="Send it by" hint="Chat shows a payment card; SMS and email send the link.">
          <NativeSelect value={source} onChange={(e) => setSource(e.target.value as Channel)}>
            <option value="dm">Chat</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </NativeSelect>
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!minor || !description.trim()}>
            {minor ? `Request ${formatMoney(minor, currency)}` : "Request payment"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
