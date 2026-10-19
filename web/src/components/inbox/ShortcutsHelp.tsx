import { SHORTCUT_HELP } from "../../lib/shortcuts";
import { Dialog } from "../ui/Dialog";

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcut-list">
        {SHORTCUT_HELP.map((s) => (
          <div key={s.keys}>
            <dt>
              <kbd>{s.keys}</kbd>
            </dt>
            <dd>{s.label}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">Letter shortcuts are disabled while you are typing in a field.</p>
    </Dialog>
  );
}
