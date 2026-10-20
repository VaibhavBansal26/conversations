import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-[2px]", className)} {...props} />;
}

export function DialogContent({ className, children, onOpenAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (e.defaultPrevented) return;
          // `data-autofocus` marks the control that should receive focus first (otherwise Radix picks the first tabbable: the close button)
          const target = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]");
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[min(90dvh,820px)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-pop-in flex-col rounded-xl border border-border bg-surface shadow-lg focus:outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div>
        <DialogPrimitive.Title className="text-base font-semibold leading-tight">{title}</DialogPrimitive.Title>
        {description && <DialogPrimitive.Description className="mt-1 text-[13px] text-muted-foreground">{description}</DialogPrimitive.Description>}
      </div>
      <DialogPrimitive.Close className="-mr-1.5 -mt-1 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground" aria-label="Close dialog">
        <X className="size-4" aria-hidden="true" />
      </DialogPrimitive.Close>
    </header>
  );
}

export const DialogBody = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex-1 overflow-y-auto px-5 py-4", className)} {...props} />;
export const DialogFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <footer className={cn("flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3", className)} {...props} />
);

interface Props {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

/** Controlled-by-mount modal: rendered means open, `onClose` fires on Escape, backdrop or the close button. Focus is trapped and restored by Radix. */
export function Dialog({ title, description, onClose, children, wide }: Props) {
  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={wide ? "max-w-2xl" : undefined}>
        <DialogHeader title={title} description={description} />
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}
