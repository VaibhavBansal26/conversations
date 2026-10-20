import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "./cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,color,border-color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover",
        secondary: "bg-surface-2 text-foreground hover:bg-surface-3",
        outline: "border border-border-strong bg-surface text-foreground shadow-xs hover:bg-surface-2",
        ghost: "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
        danger: "bg-danger text-danger-foreground shadow-xs hover:bg-danger-hover",
        "danger-ghost": "text-danger-text hover:bg-danger-soft",
        link: "h-auto rounded-sm p-0 text-primary-text underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-[13px] [&_svg]:size-4",
        md: "h-9 px-4 text-sm [&_svg]:size-4",
        lg: "h-11 px-5 text-[15px] [&_svg]:size-5",
        icon: "size-9 [&_svg]:size-[18px]",
        "icon-sm": "size-8 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ className, variant, size, loading, disabled, children, type = "button", ref, ...props }: ButtonProps) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Loader2 className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
