import { Check } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { buttonVariants } from "./button";
import { cn } from "./cn";

export const DropdownMenuRoot = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuSeparator = () => <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
export const DropdownMenuLabel = ({ children }: { children: ReactNode }) => <MenuPrimitive.Label className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">{children}</MenuPrimitive.Label>;

export function DropdownMenuContent({ className, align = "start", sideOffset = 6, ...props }: MenuPrimitive.DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        loop
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn("z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-48 max-w-[calc(100vw-1rem)] animate-pop-in overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg", className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

const itemClasses =
  "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-surface-2";

export function DropdownMenuItem({ className, danger, ...props }: MenuPrimitive.DropdownMenuItemProps & { danger?: boolean }) {
  return <MenuPrimitive.Item className={cn(itemClasses, danger && "text-danger-text data-[highlighted]:bg-danger-soft", className)} {...props} />;
}

export function DropdownMenuCheckItem({ className, children, ...props }: MenuPrimitive.DropdownMenuCheckboxItemProps) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(itemClasses, "pl-8", className)} {...props}>
      <MenuPrimitive.ItemIndicator className="absolute left-2.5">
        <Check className="size-4 text-primary-text" aria-hidden="true" />
      </MenuPrimitive.ItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

interface Props {
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "center" | "end";
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  header?: ReactNode;
}

/** Action menu: arrow keys, Home/End, type-ahead, Enter/Space to choose, Escape to dismiss (Radix). */
export function Menu({ label, trigger, items, align, triggerClassName, open, onOpenChange, header }: Props) {
  return (
    <MenuPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <MenuPrimitive.Trigger aria-label={label} className={triggerClassName ?? buttonVariants({ variant: "ghost", size: "sm" })}>
        {trigger}
      </MenuPrimitive.Trigger>
      <DropdownMenuContent align={align} aria-label={label}>
        {header && <div className="px-2.5 py-2 text-[13px] text-muted-foreground">{header}</div>}
        {items.map((item) =>
          item.checked === undefined ? (
            <DropdownMenuItem key={item.id} disabled={item.disabled} danger={item.danger} onSelect={item.onSelect}>
              {item.label}
            </DropdownMenuItem>
          ) : (
            <MenuPrimitive.CheckboxItem key={item.id} checked={item.checked} disabled={item.disabled} onSelect={item.onSelect} className={cn(itemClasses, "pl-8")}>
              <MenuPrimitive.ItemIndicator className="absolute left-2.5">
                <Check className="size-4 text-primary-text" aria-hidden="true" />
              </MenuPrimitive.ItemIndicator>
              {item.label}
            </MenuPrimitive.CheckboxItem>
          ),
        )}
      </DropdownMenuContent>
    </MenuPrimitive.Root>
  );
}
