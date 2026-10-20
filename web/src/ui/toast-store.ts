export type ToastTone = "default" | "success" | "error";
export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Imperative toast: `toast({ title: "Saved", tone: "success" })`. Rendered by <Toaster />, which loads lazily. */
export function toast(t: { title: string; description?: string; tone?: ToastTone }): void {
  items = [...items, { id: nextId++, title: t.title, description: t.description, tone: t.tone ?? "default" }];
  emit();
}
export const dismissToast = (id: number): void => {
  items = items.filter((i) => i.id !== id);
  emit();
};
export const subscribeToasts = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getToasts = (): ToastItem[] => items;
