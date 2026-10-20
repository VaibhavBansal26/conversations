import { Switch as SwitchPrimitive } from "radix-ui";
import { useId } from "react";
import { cn } from "./cn";

export function SwitchControl({ className, ...props }: SwitchPrimitive.SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-6 w-10 shrink-0 items-center rounded-full border-2 border-transparent bg-border-strong transition-colors data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}

interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}

/** Labelled row with a role="switch" toggle on the right. */
export function Switch({ label, checked, onChange, hint, disabled }: Props) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint && <p className="text-xs text-subtle">{hint}</p>}
      </div>
      <SwitchControl id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
