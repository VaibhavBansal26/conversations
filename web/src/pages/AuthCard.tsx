import { Eye, EyeOff, Inbox, MessageSquare, ShieldCheck, Zap } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { Input, ThemeToggle, cn } from "../ui";

const POINTS = [
  { Icon: Inbox, text: "Live chat, SMS and email in one shared inbox" },
  { Icon: Zap, text: "Assignments, templates and AI suggestions that keep replies fast" },
  { Icon: ShieldCheck, text: "Roles, audit trail and tenant isolation built in" },
];

/** Split-screen auth layout: brand panel on large screens, a single centred card on phones. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-primary p-12 text-primary-foreground lg:flex" aria-hidden="true">
        <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 size-96 rounded-full bg-black/20 blur-3xl" />
        <span className="relative flex items-center gap-2 text-lg font-semibold">
          <span className="grid size-9 place-items-center rounded-lg bg-white/15">
            <MessageSquare className="size-5" />
          </span>
          Conversations
        </span>
        <div className="relative max-w-md">
          <p className="text-3xl font-semibold leading-tight tracking-tight">Every customer conversation, one calm inbox.</p>
          <ul className="mt-8 space-y-4">
            {POINTS.map(({ Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-[15px] text-white/90">
                <Icon className="mt-0.5 size-5 shrink-0" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/70">Your data stays in your workspace.</p>
      </aside>
      <main id="main" className="relative flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="absolute right-3 top-3">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-sm">
          <span className="mb-8 flex items-center gap-2 text-base font-semibold lg:hidden">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <MessageSquare className="size-[18px]" aria-hidden="true" />
            </span>
            Conversations
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
          <div className="mt-7 space-y-5">{children}</div>
        </div>
      </main>
    </div>
  );
}

/** Password input with a show/hide toggle. Forwards id/aria props so it works inside <Field>. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<typeof Input>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input type={shown ? "text" : "password"} className={cn("pr-10", className)} {...props} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        className="absolute right-1 top-1 grid size-7 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-foreground"
      >
        {shown ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

export const authLink = "font-medium text-primary-text hover:underline";
