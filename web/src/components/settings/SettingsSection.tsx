import { useEffect, useRef, type ReactNode } from "react";
import { Button, cn, toast } from "../../ui";

interface Props {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled card; settings pages stack one or more of these. */
export function SettingsSection({ title, description, actions, children, className }: Props) {
  return (
    <section className={cn("mb-6 overflow-hidden rounded-xl border border-border bg-surface shadow-xs", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
          {description && <p className="mt-1 max-w-prose text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="flex flex-col gap-4 px-5 py-5">{children}</div>
    </section>
  );
}

/**
 * Sticky save row for a settings form. Shows an "unsaved changes" hint while dirty and
 * confirms with a toast (plus a status text for screen readers) once the save succeeded.
 */
export function SaveBar({ pending, saved, onReset, dirty = true }: { pending: boolean; saved: boolean; onReset?: () => void; dirty?: boolean }) {
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && saved && !dirty) toast({ title: "Changes saved", tone: "success" });
    wasPending.current = pending;
  }, [pending, saved, dirty]);
  return (
    <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-1 flex flex-wrap items-center gap-3 border-t border-border bg-surface/95 px-5 py-3 backdrop-blur">
      <Button type="submit" loading={pending} disabled={!dirty}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
      {onReset && dirty && (
        <Button variant="ghost" onClick={onReset}>
          Discard
        </Button>
      )}
      <span className="text-[13px] text-muted-foreground" role="status">
        {dirty ? <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-warning-text" aria-hidden="true" />Unsaved changes</span> : saved ? "Saved" : ""}
      </span>
    </div>
  );
}

/** One row of a list inside a section: content on the left, actions on the right. */
export function ListRow({ children, actions, className }: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <li className={cn("flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0", className)}>
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </li>
  );
}

export function RowList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col divide-y divide-border">{children}</ul>;
}

/** Inline editor panel opened from a list (new / edit). */
export function EditorPanel({ title, children, onSubmit, label }: { title: string; children: ReactNode; onSubmit: (e: React.FormEvent) => void; label: string }) {
  return (
    <form onSubmit={onSubmit} aria-label={label} className="flex flex-col gap-4 rounded-lg border border-border-strong bg-surface-2/50 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </form>
  );
}
