import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cn("inline-flex min-w-5 items-center justify-center rounded border border-border-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground", className)} {...props} />;
}
