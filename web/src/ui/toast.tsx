import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { useSyncExternalStore } from "react";
import { cn } from "./cn";
import { dismissToast as dismiss, getToasts, subscribeToasts as subscribe } from "./toast-store";

const ICON = { default: Info, success: CheckCircle2, error: XCircle } as const;
const TONE = { default: "text-primary-text", success: "text-success", error: "text-danger-text" } as const;

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getToasts);
  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={4500} label="Notifications">
      {list.map((t) => {
        const Ico = ICON[t.tone];
        return (
          <ToastPrimitive.Root
            key={t.id}
            type={t.tone === "error" ? "foreground" : "background"}
            onOpenChange={(o) => !o && dismiss(t.id)}
            className="flex animate-toast-in items-start gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-lg data-[state=closed]:animate-fade-out"
          >
            <Ico className={cn("mt-0.5 size-5 shrink-0", TONE[t.tone])} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <ToastPrimitive.Title className="text-sm font-semibold">{t.title}</ToastPrimitive.Title>
              {t.description && <ToastPrimitive.Description className="mt-0.5 text-[13px] text-muted-foreground">{t.description}</ToastPrimitive.Description>}
            </div>
            <ToastPrimitive.Close aria-label="Dismiss notification" className="grid size-6 place-items-center rounded text-subtle hover:bg-surface-2">
              <X className="size-4" aria-hidden="true" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[80] m-0 flex w-full max-w-sm list-none flex-col gap-2 p-4 pb-safe outline-none max-sm:bottom-16" />
    </ToastPrimitive.Provider>
  );
}
