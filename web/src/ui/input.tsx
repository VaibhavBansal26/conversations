import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export const fieldClasses =
  "w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground shadow-xs transition-[border-color,box-shadow] placeholder:text-subtle hover:border-subtle focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/20";

export function Input({ className, type = "text", ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} type={type} className={cn(fieldClasses, "h-9", type === "color" && "p-1", className)} {...props} />;
}

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(fieldClasses, "min-h-20 resize-y py-2 leading-relaxed", className)} {...props} />;
}
