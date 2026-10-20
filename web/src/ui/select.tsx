import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "./cn";
import { fieldClasses } from "./input";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** Styled single-select. Radix forbids empty-string item values, so "" is mapped to a sentinel internally. */
const EMPTY = "__empty__";

export function Select({ value, onValueChange, options, id, placeholder, disabled, className, size = "md", ...aria }: Props) {
  return (
    <SelectPrimitive.Root value={value === "" ? EMPTY : value} onValueChange={(v) => onValueChange(v === EMPTY ? "" : v)} disabled={disabled}>
      <SelectPrimitive.Trigger id={id} className={cn(fieldClasses, "inline-flex items-center justify-between gap-2 text-left data-[placeholder]:text-subtle", size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9", className)} {...aria}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-subtle" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} collisionPadding={8} className="z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] animate-pop-in overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value === "" ? EMPTY : o.value}
                disabled={o.disabled}
                className="relative flex cursor-pointer select-none items-center rounded-md py-2 pl-8 pr-3 text-sm outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-surface-2"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2.5">
                  <Check className="size-4 text-primary-text" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/** Native select styled to match: use where a long list or mobile pickers are better served by the OS control. */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select className={cn(fieldClasses, "h-9 appearance-none bg-[length:1rem] bg-[right_0.6rem_center] bg-no-repeat pr-8", className)} {...props}>
      {children}
    </select>
  );
}
