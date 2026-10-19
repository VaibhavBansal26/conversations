import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { RephraseMode } from "../../api/types";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";

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
      triggerClassName="btn btn-ghost btn-sm"
      trigger={
        <>
          <Icon name="sparkles" size={14} /> {rephrase.isPending ? "Rewriting…" : "Rewrite"}
        </>
      }
      items={MODES.map((m) => ({ id: m.id, label: m.label, disabled, onSelect: () => rephrase.mutate(m.id) }))}
      header={!text.trim() ? "Write a draft first" : undefined}
    />
  );
}
