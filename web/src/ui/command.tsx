import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { DialogOverlay } from "./dialog";

interface PaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
  children: ReactNode;
  value?: string;
  onValueChange?: (v: string) => void;
  /** disable cmdk's own fuzzy filter when results are server-side */
  shouldFilter?: boolean;
}

/** Command palette (Cmd/Ctrl+K): a modal combobox with grouped, keyboard-navigable results. */
export function CommandPalette({ open, onOpenChange, placeholder = "Type a command or search…", children, value, onValueChange, shouldFilter }: PaletteProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 animate-pop-in overflow-hidden rounded-xl border border-border bg-surface shadow-lg focus:outline-none">
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <CommandPrimitive label="Command palette" shouldFilter={shouldFilter} loop>
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="size-4 shrink-0 text-subtle" aria-hidden="true" />
              <CommandPrimitive.Input
                value={value}
                onValueChange={onValueChange}
                placeholder={placeholder}
                className="h-12 w-full bg-transparent text-[15px] outline-none placeholder:text-subtle"
              />
              <kbd className="shrink-0 whitespace-nowrap rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-subtle">esc</kbd>
            </div>
            <CommandPrimitive.List className="max-h-[min(60dvh,420px)] overflow-y-auto p-1.5">{children}</CommandPrimitive.List>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const CommandEmpty = ({ children }: { children: ReactNode }) => <CommandPrimitive.Empty className="px-3 py-8 text-center text-[13px] text-muted-foreground">{children}</CommandPrimitive.Empty>;

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group className={cn("[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle", className)} {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn("flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm data-[selected=true]:bg-primary-soft data-[selected=true]:text-primary-text data-[disabled=true]:opacity-45", className)}
      {...props}
    />
  );
}
