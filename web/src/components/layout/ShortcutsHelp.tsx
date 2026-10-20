import { SHORTCUT_GROUPS } from "../../lib/shortcuts";
import { Dialog, Kbd } from "../../ui";

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" description="Letter shortcuts are disabled while you are typing in a field." onClose={onClose} wide>
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">{g.title}</h3>
            <dl className="space-y-2">
              {g.items.map((s) => (
                <div key={s.label} className="flex items-start justify-between gap-3">
                  <dd className="order-1 text-[13px] text-muted-foreground">{s.label}</dd>
                  <dt className="order-2 flex shrink-0 items-center gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dt>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
