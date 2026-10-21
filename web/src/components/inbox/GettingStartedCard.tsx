import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Circle, Rocket, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import { useCan, useSession } from "../../auth/AuthContext";
import { readStorage, writeStorage } from "../../lib/storage";
import { cn } from "../../ui";

interface Item {
  id: string;
  done: boolean;
  href: string;
}
interface Checklist {
  items: Item[];
  done: number;
  total: number;
}

const LABEL: Record<string, { title: string; hint: string }> = {
  invite_teammates: { title: "Invite your teammates", hint: "Conversations are better with people to share them with" },
  connect_sms: { title: "Connect SMS", hint: "Your own Twilio account" },
  connect_email: { title: "Connect email", hint: "Your own SendGrid account" },
  install_widget: { title: "Install the chat widget", hint: "One line of code on your website" },
  create_template: { title: "Create a reply template", hint: "Answer common questions in one click" },
};

export const checklistKey = (workspaceId: string) => `conversations.getting-started.dismissed.${workspaceId}`;

/**
 * "Getting started" card for the people who set a workspace up. Every tick is derived by the server from real state (a teammate, a live provider,
 * a widget seen on a real site, a template): there is no flag to set by hand, so it cannot say "done" when it is not. Dismissing only hides the card.
 */
export function GettingStartedCard() {
  const { workspace } = useSession();
  const canSetUp = useCan("channels:manage");
  const key = checklistKey(workspace.id);
  const [dismissed, setDismissed] = useState(() => readStorage(key) === "1");
  const [open, setOpen] = useState(true);
  const q = useQuery({ queryKey: ["getting-started"], queryFn: () => api.get<Checklist>("/getting-started"), enabled: canSetUp && !dismissed, staleTime: 15_000, refetchOnWindowFocus: true, retry: false });
  if (!canSetUp || dismissed || !q.data) return null;
  const { items, done, total } = q.data;
  const complete = done === total;
  return (
    <section aria-label="Getting started" className="mx-3 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-xs md:mx-4" data-testid="getting-started">
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-text" aria-hidden="true">
          <Rocket className="size-4" />
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <span className="block text-[13px] font-semibold leading-tight">{complete ? "You are all set up" : "Getting started"}</span>
          <span className="block text-xs text-muted-foreground">
            {done} of {total} done
          </span>
        </button>
        <button type="button" aria-label={open ? "Collapse getting started" : "Expand getting started"} onClick={() => setOpen((o) => !o)} className="grid size-7 place-items-center rounded-md text-subtle hover:bg-surface-2">
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Dismiss getting started"
          onClick={() => {
            writeStorage(key, "1");
            setDismissed(true);
          }}
          className="grid size-7 place-items-center rounded-md text-subtle hover:bg-surface-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>
      <div className="h-1 bg-surface-3" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className="h-full bg-primary transition-[width]" style={{ width: `${(done / total) * 100}%` }} />
      </div>
      {open && (
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.id}>
              <Link to={i.href} className="flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-surface-2" data-done={i.done}>
                {i.done ? <Check className="size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="size-4 shrink-0 text-subtle" aria-label="Not done yet" />}
                <span className="min-w-0 flex-1">
                  <span className={cn("block font-medium", i.done && "text-muted-foreground line-through decoration-border-strong")}>{LABEL[i.id]?.title ?? i.id}</span>
                  {!i.done && <span className="block text-xs text-muted-foreground">{LABEL[i.id]?.hint}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
