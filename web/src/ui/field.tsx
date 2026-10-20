import { cloneElement, useId, type ReactElement } from "react";
import { cn } from "./cn";

interface Props {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
}

/** Wires a visible label, hint and error text to a single form control. */
export function Field({ label, hint, error, className, children }: Props) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-foreground">
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-xs font-medium text-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
