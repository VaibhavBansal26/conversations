import { Button, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "../../ui";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Replaces window.confirm for destructive actions: focus-trapped, Escape cancels. */
export function ConfirmDialog({ title, message, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  return (
    <DialogRoot open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent role="alertdialog">
        <DialogHeader title={title} />
        <DialogBody>
          <p className="text-sm text-muted-foreground">{message}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
