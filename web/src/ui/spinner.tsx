import { Loader2 } from "lucide-react";
import { cn } from "./cn";

export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <span role="status" aria-label={label} className={cn("inline-flex", className)}>
      <Loader2 className="size-5 animate-spin text-primary-text motion-reduce:animate-none" aria-hidden="true" />
    </span>
  );
}

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
      <Spinner label={label} />
      <span>{label}…</span>
    </div>
  );
}
