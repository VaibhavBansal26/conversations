import { Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { AI_TONES, useAiStatus, useSaveWorkspace } from "../../api/settingsHooks";
import type { AiTone } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { Badge, ErrorNotice, Field, Select, Skeleton, Switch } from "../../ui";

const TONE_HINT: Record<AiTone, string> = {
  friendly: "Warm and conversational",
  professional: "Polished and neutral",
  concise: "Short and to the point",
  empathetic: "Acknowledges feelings first",
};

export function AiSettings() {
  const s = useSession().workspace.settings;
  const save = useSaveWorkspace();
  const status = useAiStatus();
  const [triage, setTriage] = useState(s.ai_triage_enabled);
  const [auto, setAuto] = useState(s.ai_autoresponder_enabled);
  const [redact, setRedact] = useState(s.ai_redact_pii);
  const [tone, setTone] = useState<AiTone>(s.ai_tone);
  const dirty = triage !== s.ai_triage_enabled || auto !== s.ai_autoresponder_enabled || redact !== s.ai_redact_pii || tone !== s.ai_tone;
  const reset = () => {
    setTriage(s.ai_triage_enabled);
    setAuto(s.ai_autoresponder_enabled);
    setRedact(s.ai_redact_pii);
    setTone(s.ai_tone);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ settings: { ai_triage_enabled: triage, ai_autoresponder_enabled: auto, ai_redact_pii: redact, ai_tone: tone } });
  };

  return (
    <SettingsSection title="AI assistant" description="Suggested replies, summaries and rewrite tools. Everything else keeps working if AI is unavailable.">
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-4 py-3" role="status">
        <Sparkles className="size-4 text-primary-text" aria-hidden="true" />
        <strong className="text-sm">Provider</strong>
        {status.isPending && <Skeleton className="h-5 w-24" />}
        {status.isError && <Badge tone="warning">AI unavailable</Badge>}
        {status.data && (
          <Badge tone={status.data.offline_heuristics ? "warning" : "success"}>
            {status.data.provider}
            {status.data.offline_heuristics ? " (offline heuristics, no API key configured)" : ""}
          </Badge>
        )}
      </div>
      <form className="flex max-w-lg flex-col gap-2" onSubmit={submit}>
        <div className="divide-y divide-border">
          <Switch label="AI triage" hint="Tag new conversations with intent, sentiment and urgency." checked={triage} onChange={setTriage} />
          <Switch label="Auto-responder" hint="Answer simple questions from the knowledge base, then hand off to a human." checked={auto} onChange={setAuto} />
          <Switch label="Redact personal data" hint="Mask emails, phone numbers and card numbers before text is sent to the AI provider." checked={redact} onChange={setRedact} />
        </div>
        <Field label="Tone of voice" hint={TONE_HINT[tone]} className="mt-2">
          <Select value={tone} onValueChange={(v) => setTone(v as AiTone)} options={AI_TONES.map((t) => ({ value: t, label: `${t[0]?.toUpperCase()}${t.slice(1)}` }))} />
        </Field>
        {save.isError && <ErrorNotice error={save.error} />}
        <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={reset} />
      </form>
    </SettingsSection>
  );
}
