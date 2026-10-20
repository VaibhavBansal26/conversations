import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

interface Props {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}

export function EmptyState({ title, hint, action, icon: IconCmp, className }: Props) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      {IconCmp && (
        <span className="mb-1 grid size-12 place-items-center rounded-full bg-primary-soft text-primary-text">
          <IconCmp className="size-6" aria-hidden="true" />
        </span>
      )}
      <strong className="text-[15px] font-semibold">{title}</strong>
      {hint && <p className="max-w-sm text-[13px] text-muted-foreground">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
