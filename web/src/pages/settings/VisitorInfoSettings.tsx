import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSaveWorkspace } from "../../api/settingsHooks";
import type { CustomField, InfoMode, VisitorInfo } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { Button, ErrorNotice, Field, Input, Select, Switch } from "../../ui";

export const MODE_LABEL: Record<InfoMode, string> = { off: "Never ask", optional: "Ask, visitor may skip", required: "Required", ask_when_needed: "Ask when needed" };
const MODES = (Object.keys(MODE_LABEL) as InfoMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }));
const FIELD_LABEL = { name: "Name", email: "Email", phone: "Phone number" } as const;
const MOMENT_LABEL: Record<keyof VisitorInfo["moments"], { label: string; hint: string }> = {
  handoff: { label: "When a conversation goes to a person", hint: "A form card appears in the chat after the visitor is told who will help." },
  no_agent: { label: "When nobody is available", hint: "The department is closed or everybody is busy: ask how to reach the visitor." },
  callback: { label: "When a callback or a call is requested", hint: "Asks for the phone number to call." },
  after: { label: "After the conversation is resolved", hint: "Asks for an email to follow up. Needs the email field set to anything but never." },
};
export const DEFAULT_INFO: VisitorInfo = {
  fields: { name: "off", email: "off", phone: "off" },
  custom_fields: [],
  moments: { handoff: true, no_agent: true, callback: true, after: false },
  consent: { enabled: false, text: "I agree that you may contact me about this conversation.", privacy_url: null },
};

/** What the chat asks visitors for, when, and with which consent line. Name, email and phone first, then up to five custom fields. */
export function VisitorInfoSettings() {
  const { workspace } = useSession();
  const cur: VisitorInfo = { ...DEFAULT_INFO, ...(workspace.settings.widget.visitor_info ?? {}) };
  const save = useSaveWorkspace();
  const [v, setV] = useState<VisitorInfo>(cur);
  const errors = fieldErrors(save.error);
  const dirty = JSON.stringify(v) !== JSON.stringify(cur);
  const setCustom = (i: number, patch: Partial<CustomField>) => setV({ ...v, custom_fields: v.custom_fields.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ settings: { widget: { visitor_info: { ...v, consent: { ...v.consent, privacy_url: v.consent.privacy_url?.trim() || null } } } } });
  };
  return (
    <SettingsSection title="Visitor details" description="Choose which details the chat collects. Required fields are asked before the chat starts, and so are optional custom fields (the visitor may leave those empty); fields set to ask when needed appear as a form card in the conversation at the moments you switch on. A checkbox field is stored as yes or no; a required one must be ticked (for example: I accept the terms). Details the visitor already gave are never asked again. A department can override the fields under Departments & routing.">
      <form className="flex max-w-2xl flex-col gap-5" onSubmit={submit}>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">Fields</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {(["name", "email", "phone"] as const).map((k) => (
              <Field key={k} label={FIELD_LABEL[k]}>
                <Select value={v.fields[k]} onValueChange={(m) => setV({ ...v, fields: { ...v.fields, [k]: m as InfoMode } })} options={MODES} />
              </Field>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            {v.custom_fields.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_1fr_9rem_auto]" role="group" aria-label={`Custom field ${i + 1}`}>
                <Field label="Name in the form" error={errors[`settings.widget.visitor_info.custom_fields.${i}.label`]}>
                  <Input value={c.label} maxLength={60} onChange={(e) => setCustom(i, { label: e.target.value })} />
                </Field>
                <Field label="Key" hint="Saved on the contact. Lower-case letters, digits and underscores." error={errors[`settings.widget.visitor_info.custom_fields.${i}.key`]}>
                  <Input value={c.key} maxLength={30} onChange={(e) => setCustom(i, { key: e.target.value })} />
                </Field>
                <Field label="Type">
                  <Select value={c.type} onValueChange={(t) => setCustom(i, { type: t as CustomField["type"] })} options={[{ value: "text", label: "Text" }, { value: "select", label: "Choice" }, { value: "checkbox", label: "Checkbox" }]} />
                </Field>
                <div className="flex items-end">
                  <Button variant="danger-ghost" size="sm" aria-label={`Remove custom field ${c.label || i + 1}`} onClick={() => setV({ ...v, custom_fields: v.custom_fields.filter((_, j) => j !== i) })}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <Field label="When" className="sm:col-span-2">
                  <Select value={c.mode} onValueChange={(m) => setCustom(i, { mode: m as InfoMode })} options={MODES} />
                </Field>
                {c.type === "select" && (
                  <Field label="Choices" hint="Comma separated, at least two." className="sm:col-span-2" error={errors[`settings.widget.visitor_info.custom_fields.${i}.options`]}>
                    <Input value={c.options.join(", ")} onChange={(e) => setCustom(i, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })} />
                  </Field>
                )}
              </div>
            ))}
            <div>
              <Button variant="outline" size="sm" disabled={v.custom_fields.length >= 5} onClick={() => setV({ ...v, custom_fields: [...v.custom_fields, { key: "", label: "", type: "text", options: [], mode: "ask_when_needed" }] })}>
                <Plus aria-hidden="true" /> Add a field
              </Button>
            </div>
          </div>
        </fieldset>

        <fieldset className="flex flex-col rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">When to ask</legend>
          {(Object.keys(MOMENT_LABEL) as (keyof VisitorInfo["moments"])[]).map((m) => (
            <Switch key={m} label={MOMENT_LABEL[m].label} hint={MOMENT_LABEL[m].hint} checked={v.moments[m]} onChange={(on) => setV({ ...v, moments: { ...v.moments, [m]: on } })} />
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">Consent</legend>
          <Switch label="Ask for consent with email and phone" hint="A checkbox the visitor must tick before an email or phone number is saved. A name alone needs none." checked={v.consent.enabled} onChange={(enabled) => setV({ ...v, consent: { ...v.consent, enabled } })} />
          {v.consent.enabled && (
            <>
              <Field label="Consent text" error={errors["settings.widget.visitor_info.consent.text"]}>
                <Input value={v.consent.text} maxLength={300} onChange={(e) => setV({ ...v, consent: { ...v.consent, text: e.target.value } })} />
              </Field>
              <Field label="Privacy policy address" hint="Optional. Shown as a link next to the checkbox." error={errors["settings.widget.visitor_info.consent.privacy_url"]}>
                <Input type="url" value={v.consent.privacy_url ?? ""} placeholder="https://example.com/privacy" onChange={(e) => setV({ ...v, consent: { ...v.consent, privacy_url: e.target.value } })} />
              </Field>
            </>
          )}
        </fieldset>
        {save.isError && <ErrorNotice error={save.error} />}
        <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={() => setV(cur)} />
      </form>
    </SettingsSection>
  );
}
