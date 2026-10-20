import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>
    {children}
  </TooltipPrimitive.Provider>
);

interface Props {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  /** keyboard hint rendered as a key cap */
  shortcut?: string;
}

/** Hover/focus hint. The trigger keeps its own accessible name: this is supplementary text. */
export function Tooltip({ content, children, side = "top", shortcut }: Props) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[70] flex animate-fade-in items-center gap-2 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-md"
        >
          {content}
          {shortcut && <kbd className="rounded bg-background/20 px-1 font-mono text-[10px]">{shortcut}</kbd>}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
