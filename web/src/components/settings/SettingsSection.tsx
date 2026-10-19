import type { ReactNode } from "react";

interface Props {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function SettingsSection({ title, description, actions, children }: Props) {
  return (
    <section className="settings-section">
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function SaveBar({ pending, saved, onReset, dirty = true }: { pending: boolean; saved: boolean; onReset?: () => void; dirty?: boolean }) {
  return (
    <div className="save-bar">
      <button type="submit" className="btn btn-primary" disabled={pending || !dirty}>
        {pending ? "Saving…" : "Save changes"}
      </button>
      {onReset && dirty && (
        <button type="button" className="btn btn-ghost" onClick={onReset}>
          Discard
        </button>
      )}
      <span className="saved-note" role="status">
        {saved && !dirty ? "Saved" : ""}
      </span>
    </div>
  );
}
