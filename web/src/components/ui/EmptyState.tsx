import type { ReactNode } from "react";

interface Props {
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ title, hint, action }: Props) {
  return (
    <div className="state-block empty">
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}
