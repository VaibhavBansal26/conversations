import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { DialogOverlay } from "./dialog";

const sheetVariants = cva("fixed z-50 flex flex-col bg-surface shadow-lg focus:outline-none", {
  variants: {
    side: {
      left: "inset-y-0 left-0 h-dvh w-[min(20rem,88vw)] animate-slide-right border-r border-border",
      right: "inset-y-0 right-0 h-dvh w-[min(24rem,94vw)] animate-slide-left border-l border-border",
      bottom: "inset-x-0 bottom-0 max-h-[85dvh] animate-slide-up rounded-t-xl border-t border-border pb-safe",
    },
  },
  defaultVariants: { side: "right" },
});

interface Props extends VariantProps<typeof sheetVariants> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
  /** hide the title visually but keep it for screen readers */
  hideTitle?: boolean;
  /** omit the built-in close button when the content has its own */
  hideClose?: boolean;
}

/** Drawer: side panels for the navigation / contact panel on small screens, bottom sheet for pickers. */
export function Sheet({ open, onOpenChange, title, side, children, className, hideTitle, hideClose }: Props) {
  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal>
        <DialogOverlay />
        <SheetPrimitive.Content aria-describedby={undefined} className={cn(sheetVariants({ side }), className)}>
          <SheetPrimitive.Title className={hideTitle ? "sr-only" : "border-b border-border px-4 py-3 text-base font-semibold"}>{title}</SheetPrimitive.Title>
          {!hideClose && (
            <SheetPrimitive.Close className="absolute right-2 top-2 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-surface-2" aria-label={`Close ${title.toLowerCase()}`}>
              <X className="size-4" aria-hidden="true" />
            </SheetPrimitive.Close>
          )}
          {children}
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}

export type SheetContentProps = ComponentProps<typeof SheetPrimitive.Content>;
