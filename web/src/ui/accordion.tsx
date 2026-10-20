import { ChevronDown } from "lucide-react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export const Accordion = AccordionPrimitive.Root;

export function AccordionSection({ value, title, badge, children, className }: { value: string; title: string; badge?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <AccordionPrimitive.Item value={value} className={cn("border-b border-border", className)}>
      <AccordionPrimitive.Header className="flex">
        <AccordionPrimitive.Trigger className="group flex flex-1 items-center justify-between gap-2 px-4 py-3 text-left text-[13px] font-semibold hover:bg-surface-2/60">
          <span className="flex items-center gap-2">
            {title}
            {badge}
          </span>
          <ChevronDown className="size-4 text-subtle transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content className="overflow-hidden px-4 pb-4 pt-1 data-[state=closed]:hidden">{children}</AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
}

export type AccordionProps = ComponentProps<typeof AccordionPrimitive.Root>;
