import { Button, Dialog, DialogFooter } from "../../ui";

interface Props {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Replaces window.confirm: an accessible modal with a clearly named destructive action. */
export function ConfirmDialog({ title, description, confirmLabel, danger = true, onConfirm, onClose }: Props) {
  return (
    <Dialog title={title} description={description} onClose={onClose}>
      <DialogFooter className="-mx-5 -mb-4 border-t-0 pt-0">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
