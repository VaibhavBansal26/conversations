import { Phone, PhoneOff } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Room } from "../api/types";
import { Button, ErrorNotice, Field, Input, cn, toast } from "../ui";
import { useCalls, type PhoneCallView } from "./CallProvider";

const KEY = "cv_agent_phone";
const remembered = () => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

/** What the phone call is doing, in the words of someone who is on it. */
function describe(c: PhoneCallView, seconds: number): string {
  switch (c.state) {
    case "ringing":
      return "Calling your phone. Pick up and we connect you.";
    case "connecting":
      return "Calling the contact...";
    case "active": {
      const m = Math.floor(seconds / 60);
      return `Connected ${String(m).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    }
    case "declined":
      return "The contact's line was busy.";
    case "missed":
      return "The contact did not answer.";
    case "failed":
      return c.endReason === "agent_no_answer" ? "Your phone was not answered." : c.endReason === "agent_unreachable" ? "Your phone could not be reached." : c.endReason === "provider_error" ? "Twilio refused the call." : "The call could not connect.";
    default:
      return c.endReason === "cancelled" ? "The call was cancelled." : `The call ended${c.durationS ? ` after ${Math.max(1, Math.round(c.durationS / 60))} min` : ""}.`;
  }
}

/** The floating status of the phone call this member placed, with a hang-up button. */
export function PhoneCallPanel() {
  const calls = useCalls();
  const c = calls?.phoneCall;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (c?.state !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [c?.state]);
  if (!calls || !c) return null;
  const live = c.state === "ringing" || c.state === "connecting" || c.state === "active";
  return (
    <section role="dialog" aria-label="Phone call" className="fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] items-center gap-3 rounded-xl border border-border-strong bg-neutral-900 p-3 text-white shadow-xl">
      <span className={cn("grid size-10 shrink-0 place-items-center rounded-full", live ? "bg-success" : "bg-white/15")}>
        <Phone className="size-5" aria-hidden="true" />
      </span>
      <p role="status" aria-live="polite" className="min-w-0 flex-1 text-sm">
        <strong className="block">Phone call</strong>
        <span className="text-white/80">{describe(c, Math.floor((now - c.startedAt) / 1000))}</span>
      </p>
      {live ? (
        <button type="button" aria-label={c.state === "ringing" ? "Cancel phone call" : "Hang up"} onClick={() => void calls.hangUpPhone()} className="grid size-10 shrink-0 place-items-center rounded-full bg-danger text-white hover:brightness-110">
          <PhoneOff className="size-5" aria-hidden="true" />
        </button>
      ) : (
        <Button size="sm" variant="outline" className="shrink-0 border-white/40 bg-transparent text-white hover:bg-white/15" onClick={calls.dismissPhoneCall}>
          Close
        </Button>
      )}
    </section>
  );
}

const WHY: Record<string, string> = {
  NO_CALL_CONSENT: "The contact has not agreed to be called on this number yet.",
  CONTACT_NO_PHONE: "This contact has no phone number yet.",
};

/** Ask for the agent's own number and start a call; when the contact has not agreed yet, offer to ask them in the chat. */
export function PhoneCallDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const [phone, setPhone] = useState(remembered);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [code, setCode] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      await api.post(`/rooms/${room.id}/phone-call`, { agent_phone: phone });
      try {
        localStorage.setItem(KEY, phone);
      } catch {
        /* optional */
      }
      onClose();
    } catch (err) {
      setError(err);
      setCode((err as { code?: string }).code ?? null);
    } finally {
      setBusy(false);
    }
  };
  const ask = async () => {
    try {
      await api.post(`/rooms/${room.id}/phone-call/consent`, {});
      toast({ title: "Asked the visitor", description: "A card in the chat asks them to confirm the number and agree to be called.", tone: "success" });
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <form role="dialog" aria-modal="true" aria-label="Call by phone" onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-base font-semibold">Call by phone</h2>
        <p className="text-sm text-muted-foreground">Twilio calls your phone first. When you answer, it calls {room.contact?.name || "the contact"} and connects you. Nothing is recorded.</p>
        <Field label="Your phone number" hint="With the country code, for example +1 415 555 0100. It is not stored on the server.">
          <Input type="tel" value={phone} required autoFocus onChange={(e) => setPhone(e.target.value)} />
        </Field>
        {code && WHY[code] && (
          <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-text">
            {WHY[code]}
            <Button type="button" variant="outline" size="sm" className="mt-2 block" onClick={() => void ask()}>
              Ask the visitor to agree
            </Button>
          </p>
        )}
        {Boolean(error) && !(code && WHY[code]) && <ErrorNotice error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Call
          </Button>
        </div>
      </form>
    </div>
  );
}
