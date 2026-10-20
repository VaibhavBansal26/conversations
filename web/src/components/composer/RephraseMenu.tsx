import { useMutation } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { api } from "../../api/client";
import type { RephraseMode } from "../../api/types";
import { Menu, buttonVariants } from "../../ui";

const MODES: { id: RephraseMode; label: string }[] = [
  { id: "improve", label: "Improve writing" },
  { id: "fix_grammar", label: "Fix grammar" },
  { id: "shorten", label: "Make shorter" },
  { id: "friendly", label: "More friendly" },
  { id: "professional", label: "More professional" },
  { id: "empathetic", label: "More empathetic" },
];

interface Props {
  text: string;
  roomId: string;
  onResult: (text: string) => void;
  onError: (error: unknown) => void;
}

export function RephraseMenu({ text, roomId, onResult, onError }: Props) {
  const rephrase = useMutation({
    mutationFn: (mode: RephraseMode) => api.post<{ text: string }>("/ai/rephrase", { text, mode, room_id: roomId }),
    onSuccess: (r) => onResult(r.text),
    onError,
  });
  const disabled = !text.trim() || rephrase.isPending;
  return (
    <Menu
      label="Rewrite draft with AI"
      triggerClassName={buttonVariants({ variant: "ghost", size: "sm", className: "h-8 px-2 text-[13px] text-muted-foreground" })}
      trigger={
        <>
          {rephrase.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />} <span className="max-sm:sr-only">{rephrase.isPending ? "Rewriting…" : "Rewrite"}</span>
        </>
      }
      items={MODES.map((m) => ({ id: m.id, label: m.label, disabled, onSelect: () => rephrase.mutate(m.id) }))}
      header={!text.trim() ? "Write a draft first" : undefined}
    />
  );
}
