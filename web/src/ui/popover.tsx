import { Popover as PopoverPrimitive } from "radix-ui";
import { useState, type ReactNode } from "react";
import { buttonVariants } from "./button";
import { cn } from "./cn";

export const PopoverRoot = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({ className, align = "start", sideOffset = 6, ...props }: PopoverPrimitive.PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("z-50 max-h-[var(--radix-popover-content-available-height)] min-w-56 max-w-[calc(100vw-1rem)] animate-pop-in overflow-auto rounded-lg border border-border bg-surface p-3 text-sm shadow-lg", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

interface Props {
  /** Accessible name of the trigger button. */
  label: string;
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "center" | "end";
  triggerClassName?: string;
  panelClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

/** Disclosure popover with a built-in trigger button; closes on Escape / outside click and returns focus to the trigger. */
export function Popover({ label, trigger, children, align = "start", triggerClassName, panelClassName, open, onOpenChange, disabled }: Props) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const setOpen = (next: boolean) => {
    setInner(next);
    onOpenChange?.(next);
  };
  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger aria-label={label} disabled={disabled} className={triggerClassName ?? buttonVariants({ variant: "ghost", size: "sm" })}>
        {trigger}
      </PopoverPrimitive.Trigger>
      <PopoverContent align={align} aria-label={label} className={panelClassName}>
        {typeof children === "function" ? children(() => setOpen(false)) : children}
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}
