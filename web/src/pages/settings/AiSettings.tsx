import { useState, type FormEvent } from "react";
import { AI_TONES, useAiStatus, useSaveWorkspace } from "../../api/settingsHooks";
import type { AiTone } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";

export function AiSettings() {
  const s = useSession().workspace.settings;
  const save = useSaveWorkspace();
  const status = useAiStatus();
  const [triage, setTriage] = useState(s.ai_triage_enabled);
  const [auto, setAuto] = useState(s.ai_autoresponder_enabled);
  const [redact, setRedact] = useState(s.ai_redact_pii);
  const [tone, setTone] = useState<AiTone>(s.ai_tone);
  const dirty = triage !== s.ai_triage_enabled || auto !== s.ai_autoresponder_enabled || redact !== s.ai_redact_pii || tone !== s.ai_tone;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ settings: { ai_triage_enabled: triage, ai_autoresponder_enabled: auto, ai_redact_pii: redact, ai_tone: tone } });
  };

  return (
    <SettingsSection title="AI assistant" description="Suggested replies, summaries and rewrite tools. Everything else keeps working if AI is unavailable.">
      <div className="status-card" role="status">
        <strong>Provider</strong>
        {status.isPending && <span className="muted">Checking…</span>}
        {status.isError && <span className="tag tag-warn">AI unavailable</span>}
        {status.data && (
          <span className="tag">
            {status.data.provider}
            {status.data.offline_heuristics ? " (offline heuristics, no API key configured)" : ""}
          </span>
        )}
      </div>
      <form className="stack narrow" onSubmit={submit}>
        <Switch label="AI triage" hint="Tag new conversations with intent, sentiment and urgency." checked={triage} onChange={setTriage} />
        <Switch label="Auto-responder" hint="Answer simple questions from the knowledge base, then hand off to a human." checked={auto} onChange={setAuto} />
        <Switch label="Redact personal data" hint="Mask emails, phone numbers and card numbers before text is sent to the AI provider." checked={redact} onChange={setRedact} />
        <Field label="Tone of voice">
          <select value={tone} onChange={(e) => setTone(e.target.value as AiTone)}>
            {AI_TONES.map((t) => (
              <option key={t} value={t}>
                {t[0]?.toUpperCase()}
                {t.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        {save.isError && <ErrorNotice error={save.error} />}
        <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} />
      </form>
    </SettingsSection>
  );
}
