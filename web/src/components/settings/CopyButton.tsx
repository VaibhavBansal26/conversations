import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {done ? "Copied" : label}
    </Button>
  );
}
