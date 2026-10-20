import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "./cn";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border bg-surface">
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...props} />
    </div>
  );
}
export const TableHead = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => <thead className={cn("bg-surface-2", className)} {...props} />;
export const TableBody = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
export const TableRow = ({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) => <tr className={cn("border-b border-border transition-colors hover:bg-surface-2/60", className)} {...props} />;
export const TableHeaderCell = ({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn("whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)} {...props} />
);
export const TableCell = ({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
