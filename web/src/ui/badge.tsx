import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export const badgeVariants = cva("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium leading-4", {
  variants: {
    tone: {
      neutral: "bg-surface-2 text-muted-foreground",
      primary: "bg-primary-soft text-primary-text",
      solid: "bg-primary text-primary-foreground",
      success: "bg-success-soft text-success-text",
      warning: "bg-warning-soft text-warning-text",
      danger: "bg-danger-soft text-danger-text",
      info: "bg-info-soft text-info-text",
      outline: "border border-border-strong text-muted-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
