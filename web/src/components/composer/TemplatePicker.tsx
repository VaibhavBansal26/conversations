// Adapted from the legacy UI (see docs/PROVENANCE.md): template insertion in the editor, as a searchable picker.
import { FileText, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { Channel, Template } from "../../api/types";
import { Link } from "react-router";
import { Popover, Tooltip, buttonVariants, cn } from "../../ui";

interface Props {
  templates: Template[];
  channel: Channel;
  onPick: (t: Template) => void;
  busy?: boolean;
}

/** Searchable list of reply templates for the current channel (the inline "/" shortcut does the same from the keyboard). */
export function TemplatePicker({ templates, channel, onPick, busy }: Props) {
  const [q, setQ] = useState("");
  const usable = useMemo(() => templates.filter((t) => t.channel === "any" || t.channel === channel), [templates, channel]);
  const shown = usable.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || (t.shortcut ?? "").toLowerCase().includes(q.toLowerCase()));
  return (
    <Popover
      label="Insert template"
      align="start"
      triggerClassName={cn("inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-50")}
      disabled={busy}
      trigger={
        <Tooltip content="Templates" shortcut="/">
          <span className="grid size-8 place-items-center">{busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <FileText className="size-4" aria-hidden="true" />}</span>
        </Tooltip>
      }
      panelClassName="w-80 p-0"
    >
      {(close) => (
        <div>
          <div className="relative border-b border-border p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
            <label className="sr-only" htmlFor="tpl-search">
              Search templates
            </label>
            <input id="tpl-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" className="h-8 w-full rounded-md bg-surface-2 pl-8 pr-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
          </div>
          <ul className="max-h-64 overflow-y-auto p-1">
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(t);
                    close();
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="truncate font-medium">{t.name}</span>
                  <span className="shrink-0 text-xs text-subtle">{t.shortcut ? `/${t.shortcut}` : t.channel === "any" ? "" : t.channel}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-subtle">{usable.length ? "No templates match." : "No templates for this channel yet."}</li>}
          </ul>
          <div className="border-t border-border p-1.5">
            <Link to="/settings/templates" className={buttonVariants({ variant: "ghost", size: "sm", className: "w-full justify-start text-muted-foreground" })}>
              Manage templates
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
}
