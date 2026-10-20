import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("animate-shimmer rounded-md bg-surface-3", className)} {...props} />;
}
