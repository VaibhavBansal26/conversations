import { useState, type FormEvent } from "react";
import { useSaveWorkspace } from "../../api/settingsHooks";
import type { TicketSettings as Settings } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { ErrorNotice, Field, Input, Switch, Textarea } from "../../ui";

/** How long a ticket lives: when a reply reopens it, when quiet ones are resolved, when resolved ones are closed, the rating prompt. */
export function TicketSettings() {
  const { workspace } = useSession();
  const cur = workspace.settings.tickets;
  const save = useSaveWorkspace();
  const [v, setV] = useState<Settings>(cur);
  const errors = fieldErrors(save.error);
  const dirty = JSON.stringify(v) !== JSON.stringify(cur);
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ settings: { tickets: v } });
  };
  return (
    <SettingsSection
      title="Tickets"
      description="A ticket is one issue inside a conversation. It opens with the customer's first message and ends when it is resolved; the conversation itself stays open for the next one."
    >
      <form className="flex max-w-xl flex-col gap-4" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reopen window (hours)" hint="A reply to a resolved ticket reopens it within this time, otherwise a new ticket opens. 0 always opens a new one." error={errors["settings.tickets.reopen_hours"]}>
            <Input type="number" min={0} max={720} value={v.reopen_hours} onChange={num("reopen_hours")} />
          </Field>
          <Field label="Close resolved tickets after (hours)" hint="Resolved tickets with no reply are closed after this time." error={errors["settings.tickets.close_resolved_hours"]}>
            <Input type="number" min={1} max={720} value={v.close_resolved_hours} onChange={num("close_resolved_hours")} />
          </Field>
          <Field label="AI agent idle time (minutes)" hint="A ticket the AI agent is handling, quiet for this long, is resolved as abandoned. 0 turns it off, otherwise at least 5." error={errors["settings.tickets.bot_idle_minutes"]}>
            <Input type="number" min={0} max={1440} value={v.bot_idle_minutes} onChange={num("bot_idle_minutes")} />
          </Field>
          <Field label="Waiting for customer (hours)" hint="Tickets you marked as waiting for the customer are resolved after this long without a reply. 0 turns it off." error={errors["settings.tickets.pending_idle_hours"]}>
            <Input type="number" min={0} max={720} value={v.pending_idle_hours} onChange={num("pending_idle_hours")} />
          </Field>
        </div>
        <Field label="Message when a ticket is resolved" hint="Shown to the customer in the chat. Leave empty to say nothing." error={errors["settings.tickets.closing_message"]}>
          <Textarea rows={2} maxLength={500} value={v.closing_message} onChange={(e) => setV({ ...v, closing_message: e.target.value })} />
        </Field>
        <Switch label="Ask for a rating" hint="Shows a 1 to 5 rating card under the resolved message." checked={v.csat_prompt} onChange={(csat_prompt) => setV({ ...v, csat_prompt })} />
        {save.isError && <ErrorNotice error={save.error} />}
        <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={() => setV(cur)} />
      </form>
    </SettingsSection>
  );
}

interface Transcripts {
  enabled: boolean;
  send_after_resolve: boolean;
  redact: boolean;
}
const TRANSCRIPTS: Transcripts = { enabled: false, send_after_resolve: false, redact: false };

/** Copies of a conversation by email (docs/TRANSCRIPTS.md). */
export function TranscriptSettings() {
  const { workspace } = useSession();
  const cur: Transcripts = { ...TRANSCRIPTS, ...((workspace.settings as { transcripts?: Partial<Transcripts> }).transcripts ?? {}) };
  const save = useSaveWorkspace();
  const [v, setV] = useState<Transcripts>(cur);
  const dirty = JSON.stringify(v) !== JSON.stringify(cur);
  return (
    <SettingsSection title="Copies by email" description="Visitors can get a copy of their conversation by email. It goes only to their own address, once they have confirmed it (with a code, or by giving it in the chat with consent). Team members can send one from a conversation's menu.">
      <form
        className="flex max-w-xl flex-col gap-1"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate({ settings: { transcripts: v } as never });
        }}
      >
        <Switch label="Visitors can ask for a copy" hint={'Shows "Email me a copy" in the chat, and lets AI agents that have the action send one when asked. At most 3 copies per contact per hour.'} checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} />
        <Switch label="Also send a copy when a ticket is resolved" hint="Once per ticket, to a confirmed address, never to a contact who unsubscribed. The email has a link to stop these copies." checked={v.send_after_resolve} disabled={!v.enabled} onChange={(send_after_resolve) => setV({ ...v, send_after_resolve })} />
        <Switch label="Hide personal data in copies" hint="Email addresses, phone and card numbers are masked. Also on when 'Redact personal data' is on in the AI settings." checked={v.redact} onChange={(redact) => setV({ ...v, redact })} />
        <p className="pt-2 text-xs text-subtle">A copy contains what the visitor saw: no internal notes, no internal lines, nothing about how the AI decided. Without a connected email provider (test mode) copies are recorded but not sent.</p>
        {save.isError && <ErrorNotice error={save.error} />}
        <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={() => setV(cur)} />
      </form>
    </SettingsSection>
  );
}
