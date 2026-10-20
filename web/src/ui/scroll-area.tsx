import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import type { ComponentProps, Ref } from "react";
import { cn } from "./cn";

interface Props extends ComponentProps<typeof ScrollAreaPrimitive.Root> {
  viewportRef?: Ref<HTMLDivElement>;
  viewportClassName?: string;
}

export function ScrollArea({ className, viewportClassName, viewportRef, children, ...props }: Props) {
  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className={cn("size-full rounded-[inherit] [&>div]:!block", viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex w-2.5 touch-none select-none p-0.5 transition-colors">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border-strong" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="flex h-2.5 touch-none select-none flex-col p-0.5">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border-strong" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}
