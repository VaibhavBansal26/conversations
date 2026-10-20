import { Button } from "./button";
import { Dialog, DialogFooter } from "./dialog";

interface Props {
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Replaces window.confirm: focus-trapped, Escape cancels, destructive actions are styled as such. */
export function ConfirmDialog({ title, description, confirmLabel = "Confirm", danger, busy, onConfirm, onCancel }: Props) {
  return (
    <Dialog title={title} description={description} onClose={onCancel}>
      <DialogFooter className="-mx-5 -mb-4 mt-4">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm} data-autofocus>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
