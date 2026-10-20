import type { ReactNode } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "../ui";

/** Titled card used across the operator console. */
export function Panel({ title, description, actions, children, className }: { title: string; description?: string; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <Card className={className} role="region" aria-label={title}>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-1">{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
      {children && <CardContent className={cn("flex flex-col gap-4")}>{children}</CardContent>}
    </Card>
  );
}

export function Pager({ canNewer, canOlder, onNewer, onOlder }: { canNewer: boolean; canOlder: boolean; onNewer: () => void; onOlder: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" disabled={!canNewer} onClick={onNewer}>
        Newer
      </Button>
      <Button variant="outline" size="sm" disabled={!canOlder} onClick={onOlder}>
        Older
      </Button>
    </div>
  );
}
