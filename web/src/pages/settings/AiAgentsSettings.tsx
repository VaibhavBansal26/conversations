import { Bot, FlaskConical, MessageSquareWarning, Pencil, Plus, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { Session, Workspace } from "../../api/types";
import { keys } from "../../state/keys";
import { Link } from "react-router";
import { useAgentMutations, useAgents, useAgentTurns, useSandbox, useUnanswered, type AgentDraft, type TurnFilters } from "../../api/agentHooks";
import { useDepartments } from "../../api/departmentHooks";
import { AGENT_PRESETS, type AgentPreset } from "../../api/agentPresets";
import { AgentAvatar, PictureCropper } from "./AgentPicture";
import type { AgentAction, AgentAutonomy, AgentTone, AgentTurn, AgentTurnOutcome, AiAgent, HandoffTriggers, SandboxResult } from "../../api/types";
import { ConfirmDialog } from "../../components/settings/ConfirmDialog";
import { HoursEditor } from "../../components/settings/HoursEditor";
import { EditorPanel, ListRow, RowList, SettingsSection } from "../../components/settings/SettingsSection";
import { Badge, Button, EmptyState, ErrorNotice, Field, Input, Select, Skeleton, Switch, SwitchControl, Tabs, TabsList, TabsTrigger, Textarea, toast } from "../../ui";

const MAX_AGENTS = 5;
const AUTONOMY: Record<AgentAutonomy, { label: string; help: string }> = {
  suggest_only: { label: "Suggest only", help: "Never writes to the visitor. Drafts an answer as a private note for your team." },
  auto_answer: { label: "Answer on its own", help: "Answers from the knowledge base and hands over when it cannot." },
  auto_resolve: { label: "Answer and resolve", help: "Also closes the ticket when the visitor confirms, or when it decides the question is settled." },
};
const TONES: AgentTone[] = ["friendly", "professional", "concise", "empathetic"];
const ACTIONS: { id: AgentAction; label: string; built: boolean }[] = [
  { id: "quick_replies", label: "Show quick replies (solved? yes / no / person)", built: true },
  { id: "route", label: "Choose the department", built: true },
  { id: "resolve", label: "Resolve the ticket", built: true },
  { id: "request_human", label: "Hand over to a person", built: true },
  { id: "collect_info", label: "Ask for contact details", built: true },
  { id: "schedule_callback", label: "Offer a callback", built: true },
  { id: "offer_call", label: "Offer a voice or video call", built: true },
  { id: "ai_call", label: "Talk with visitors by voice or video (speech runs in the visitor's browser; switch it on in Settings > Calls)", built: true },
  { id: "share_call_link", label: "Send a link to join a voice or video call (works without the chat open; needs call links under Settings > Calls)", built: true },
];
const TRIGGERS: { id: keyof Omit<HandoffTriggers, "sensitive_topics">; label: string }[] = [
  { id: "human_request", label: "The visitor asks for a person" },
  { id: "low_confidence", label: "The answer is uncertain after a few tries" },
  { id: "repeated_rephrase", label: "The visitor keeps rephrasing the same question" },
  { id: "negative_sentiment", label: "The visitor sounds upset" },
  { id: "high_urgency", label: "The message sounds urgent" },
  { id: "sensitive_topic", label: "A sensitive topic comes up" },
  { id: "vip_contact", label: "The contact is tagged VIP" },
  { id: "tool_failure", label: "An action fails" },
];
const OUTCOME_LABEL: Record<AgentTurnOutcome, string> = { answered: "Answered", suggested: "Suggested", clarified: "Asked for details", refused: "Declined", handoff: "Handed over", resolved: "Resolved", skipped: "Skipped" };
const OUTCOME_TONE: Record<AgentTurnOutcome, "success" | "warning" | "info" | "neutral" | "danger"> = { answered: "success", suggested: "info", clarified: "neutral", refused: "warning", handoff: "warning", resolved: "success", skipped: "neutral" };
const REASON_LABEL: Record<string, string> = {
  customer_requested_human: "asked for a person", low_confidence: "uncertain", no_answer: "no answer in the knowledge base", repeated_rephrase: "kept rephrasing", negative_sentiment: "upset", high_urgency: "urgent",
  sensitive_topic: "sensitive topic", vip_contact: "VIP contact", max_turns: "turn limit", outside_hours: "outside agent hours", suspicious_input: "suspicious input", unsafe_answer: "answer blocked by a safety check", suggest_only: "suggest-only mode", tool_failure: "action failed", model_handoff: "the agent chose to",
};

const list = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];
const blank = (): AgentDraft => ({
  name: "", avatar_url: null, avatar_alt: "", persona: "", tone: "friendly", languages: [], greeting: "", department_ids: [], hours: { enabled: false, timezone: "UTC", days: [] }, kb_collections: [], autonomy: "auto_answer", confidence_threshold: 0.6, coverage_threshold: 0.5,
  max_turns: 6, max_attempts: 2, allowed_actions: ACTIONS.map((a) => a.id), handoff_triggers: { human_request: true, low_confidence: true, repeated_rephrase: true, negative_sentiment: true, high_urgency: true, sensitive_topic: true, vip_contact: true, tool_failure: true, sensitive_topics: [] },
  waiting_behavior: "gather_info", disclosure_label: "AI assistant", channels: ["widget"], enabled: false,
});

/** The agent a workspace gets the first time it opens this screen with none: on, answering from the knowledge base, handing over when it should. */
export const DEFAULT_AGENT: Partial<AgentDraft> & { name: string } = {
  ...fromPreset(AGENT_PRESETS[0]!),
  persona: `${AGENT_PRESETS[0]!.persona} Answer only from the knowledge base. If you do not know, say so and offer a person.`,
  autonomy: "auto_answer",
  enabled: true,
};
function fromPreset(p: AgentPreset): Partial<AgentDraft> & { name: string } {
  return { name: p.name, tone: p.tone, persona: p.persona, greeting: p.greeting, avatar_url: p.avatar_url, avatar_alt: p.avatar_alt, disclosure_label: p.disclosure_label };
}
// Remembered per workspace: a new workspace (or one whose data was reset) gets its default agent even in a browser that created one before.
const offeredKey = (ws: string) => `conversations.default-agent-offered.${ws}`;
const offered = (ws: string) => {
  try {
    return localStorage.getItem(offeredKey(ws)) === "1";
  } catch {
    return false;
  }
};
const markOffered = (ws: string, on = true) => {
  try {
    if (on) localStorage.setItem(offeredKey(ws), "1");
    else localStorage.removeItem(offeredKey(ws));
  } catch {
    /* private mode: the agent list itself still prevents a second one */
  }
};

function Sandbox({ agent }: { agent: AiAgent }) {
  const sandbox = useSandbox(agent.id);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<{ role: "visitor" | "assistant"; text: string }[]>([]);
  const r: SandboxResult | undefined = sandbox.data;
  const send = (e: FormEvent) => {
    e.preventDefault();
    const m = message.trim();
    if (!m) return;
    sandbox.mutate(
      { message: m, history, turns: history.filter((h) => h.role === "assistant").length },
      { onSuccess: (res) => (setHistory([...history, { role: "visitor", text: m }, ...(res.reply ? [{ role: "assistant" as const, text: res.reply }] : [])]), setMessage("")) },
    );
  };
  return (
    <details className="rounded-lg border border-border bg-surface-2/40" open>
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
        <FlaskConical className="size-4 text-subtle" aria-hidden="true" /> Try {agent.name}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-4">
        <p className="text-xs text-subtle">Nothing here is saved: no conversation, no ticket, no visitor message. Each try uses your AI budget like a real answer. Without a model connected, the built-in rules agent answers.</p>
        {history.length > 0 && (
          <ol className="flex flex-col gap-1.5" aria-label="Test conversation">
            {history.map((h, i) => (
              <li key={i} className={h.role === "visitor" ? "self-end rounded-lg bg-primary-soft px-3 py-1.5 text-sm text-primary-text" : "self-start whitespace-pre-wrap rounded-lg bg-surface px-3 py-1.5 text-sm"}>
                {h.text}
              </li>
            ))}
          </ol>
        )}
        <form onSubmit={send} className="flex gap-2" aria-label={`Try ${agent.name}`}>
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Write as a visitor would" aria-label="Test message" maxLength={2000} />
          <Button type="submit" variant="outline" loading={sandbox.isPending} disabled={!message.trim()}>
            Send
          </Button>
          {history.length > 0 && (
            <Button variant="ghost" onClick={() => (setHistory([]), sandbox.reset())}>
              Start over
            </Button>
          )}
        </form>
        {sandbox.isError && <ErrorNotice error={sandbox.error} />}
        {r && (
          <div className="flex flex-col gap-2 rounded-md bg-surface px-3 py-3 text-sm" role="status" aria-label="What the agent would do">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={r.handoff ? "warning" : "success"}>{r.handoff ? `Hands over: ${REASON_LABEL[r.handoff.reason] ?? r.handoff.reason}` : r.kind === "clarify" ? "Asks for details" : r.kind === "suggest" ? "Suggests an answer" : r.kind === "refuse" ? "Declines" : "Answers"}</Badge>
              {r.confidence !== null && r.confidence > 0 && <span className="text-xs text-subtle">confidence {Math.round(r.confidence * 100)}%</span>}
              <span className="text-xs text-subtle">{r.provider}</span>
              {r.degraded && <Badge tone="warning">model unavailable: rules agent</Badge>}
            </p>
            {r.sources.length > 0 && (
              <p className="text-[13px] text-muted-foreground">
                Sources: {r.sources.map((s) => s.question).join("; ")}
              </p>
            )}
            {r.routing && (
              <p className="text-[13px] text-muted-foreground">
                Routing: {r.routing.outcome.replace(/_/g, " ")}
                {r.routing.department ? ` in ${r.routing.department.name}` : ""}
                {r.routing.assignee ? `, to ${r.routing.assignee.name}` : ""}
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-subtle">How it decided</summary>
              <ol className="mt-1 list-decimal pl-5 text-xs text-muted-foreground">
                {r.trace.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            </details>
          </div>
        )}
      </div>
    </details>
  );
}

function AgentEditor({ agent, preset, onClose }: { agent: AiAgent | null; preset?: AgentPreset | null; onClose: () => void }) {
  const depts = useDepartments();
  const { create, update, uploadAvatar } = useAgentMutations();
  const [d, setD] = useState<AgentDraft>(() => (agent ? { ...agent } : { ...blank(), ...(preset ? fromPreset(preset) : {}) }));
  // a cropped upload waiting to be sent when the agent is saved
  const [upload, setUpload] = useState<Blob | null>(null);
  const [topics, setTopics] = useState(() => (agent ?? blank()).handoff_triggers.sensitive_topics.join(", "));
  const [langs, setLangs] = useState(() => (agent ?? blank()).languages.join(", "));
  const [colls, setColls] = useState(() => (agent ?? blank()).kb_collections.join(", "));
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const save = agent ? update : create;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { ...d, languages: list(langs), kb_collections: list(colls), handoff_triggers: { ...d.handoff_triggers, sensitive_topics: list(topics).map((t) => t.toLowerCase()) } };
    const done = () => (toast({ title: "AI agent saved", tone: "success" }), onClose());
    // the picture goes up after the agent exists (it needs the agent's id); an upload replaces the address, so the old one is not sent with it
    const withUpload = (saved: AiAgent) => (upload ? uploadAvatar.mutate({ id: saved.id, blob: upload, alt: d.avatar_alt }, { onSuccess: done }) : done());
    if (agent) update.mutate({ id: agent.id, ...body, ...(upload ? { avatar_url: agent.avatar_url } : {}) }, { onSuccess: withUpload });
    else create.mutate({ ...body, ...(upload ? { avatar_url: null } : {}) }, { onSuccess: withUpload });
  };
  const toggle = <T,>(arr: T[], v: T, on: boolean) => (on ? [...arr, v] : arr.filter((x) => x !== v));
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);
  return (
    <div className="flex flex-col gap-4">
      <EditorPanel title={agent ? `Edit ${agent.name}` : "New AI agent"} label={agent ? `Edit ${agent.name}` : "New AI agent"} onSubmit={submit}>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">Who it is</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="Visitors see this name.">
              <Input value={d.name} required maxLength={60} onChange={(e) => set("name", e.target.value)} autoFocus />
            </Field>
            <Field label="Label shown to visitors" hint="Visitors are always told they are talking to an AI.">
              <Input value={d.disclosure_label} minLength={2} maxLength={40} required onChange={(e) => set("disclosure_label", e.target.value)} />
            </Field>
          </div>
          <Field label="Role and rules" hint="What the agent does for your company and what it must avoid. It is added below the product's own safety rules: it cannot switch them off.">
            <Textarea rows={4} maxLength={2000} value={d.persona} onChange={(e) => set("persona", e.target.value)} />
          </Field>
          <Field label="Greeting" hint="Sent with the first answer of a conversation. Optional.">
            <Input value={d.greeting} maxLength={500} onChange={(e) => set("greeting", e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tone">
              <Select value={d.tone} onValueChange={(v) => set("tone", v as AgentTone)} options={TONES.map((t) => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1) }))} />
            </Field>
            <Field label="Languages" hint="Comma separated codes, such as en, de. Empty means any.">
              <Input value={langs} onChange={(e) => setLangs(e.target.value)} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">Picture</legend>
          <div className="flex flex-wrap items-center gap-4">
            <AgentAvatar url={upload ? null : d.avatar_url} name={d.name} size={72} />
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap gap-2">
                {AGENT_PRESETS.map((p) => (
                  <Button key={p.key} variant="outline" size="sm" aria-pressed={!upload && d.avatar_url === p.avatar_url} onClick={() => (setUpload(null), setD((x) => ({ ...x, avatar_url: p.avatar_url, avatar_alt: p.avatar_alt })))}>
                    Use the {p.name} picture
                  </Button>
                ))}
                {(d.avatar_url || upload) && (
                  <Button variant="ghost" size="sm" onClick={() => (setUpload(null), setD((x) => ({ ...x, avatar_url: null, avatar_alt: "" })))}>
                    Remove the picture
                  </Button>
                )}
              </div>
              <p className="text-xs text-subtle">Without a picture visitors see a drawn animated face.</p>
            </div>
          </div>
          <PictureCropper onChange={setUpload} />
          <Field label="Description of the picture" hint="Read out by screen readers. Say what the picture shows, for example the person's look. Empty means the agent's name.">
            <Input value={d.avatar_alt} maxLength={200} onChange={(e) => set("avatar_alt", e.target.value)} />
          </Field>
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted-foreground" role="note">
            Only use pictures you have the right to use. A picture of a person on an AI agent is always shown together with the label above ("{d.disclosure_label || "AI assistant"}"): visitors are told they are talking to an AI, and that label cannot be removed. Uploads are PNG, JPEG or WebP up to 1 MB, cropped to a square here, stripped of camera and location data on the server, and shown publicly to your visitors. Aria and vb come with pictures supplied by the owner of this installation.
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">What it may do</legend>
          <Field label="Autonomy">
            <Select value={d.autonomy} onValueChange={(v) => set("autonomy", v as AgentAutonomy)} options={(Object.keys(AUTONOMY) as AgentAutonomy[]).map((a) => ({ value: a, label: AUTONOMY[a].label }))} />
          </Field>
          <p className="-mt-1 text-xs text-subtle">{AUTONOMY[d.autonomy].help}</p>
          <div className="flex flex-col">
            {ACTIONS.map((a) => (
              <Switch key={a.id} label={a.label} checked={d.allowed_actions.includes(a.id)} onChange={(on) => set("allowed_actions", toggle(d.allowed_actions, a.id, on))} />
            ))}
          </div>
          <Field label="Knowledge collections" hint="Comma separated. The agent answers only from these. Empty means the whole knowledge base.">
            <Input value={colls} onChange={(e) => setColls(e.target.value)} />
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">Where it works</legend>
          <div className="flex flex-col" role="group" aria-label="Channels">
            {([["widget", "Chat (widget, hosted chat, apps)"], ["sms", "SMS"], ["email", "Email"]] as const).map(([id, label]) => (
              <Switch
                key={id}
                label={label}
                hint={id === "widget" ? undefined : `Answers ${id === "sms" ? "texts" : "emails"} in plain text through your own provider, only when SMS and email answers are switched on for the workspace (below the agent list).`}
                checked={d.channels.includes(id)}
                onChange={(on) => {
                  const next = toggle(d.channels, id, on);
                  if (next.length) set("channels", next);
                }}
              />
            ))}
          </div>
          <p className="text-xs text-subtle">The agent answers conversations in these departments. None selected means all of them.</p>
          {(depts.data ?? []).map((x) => (
            <Switch key={x.id} label={x.name} checked={d.department_ids.includes(x.id)} onChange={(on) => set("department_ids", toggle(d.department_ids, x.id, on))} />
          ))}
          <HoursEditor value={d.hours} onChange={(h) => set("hours", h)} label="Restrict to hours" hint="Outside these hours it hands conversations to your team straight away." />
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">When it hands over to a person</legend>
          <div className="flex flex-col">
            {TRIGGERS.map((t) => (
              <Switch key={t.id} label={t.label} checked={d.handoff_triggers[t.id]} onChange={(on) => set("handoff_triggers", { ...d.handoff_triggers, [t.id]: on })} />
            ))}
          </div>
          <Field label="Sensitive topics" hint="Comma separated words. A message that contains one goes to a person. This is the whole list: remove words you do not want.">
            <Textarea rows={3} value={topics} onChange={(e) => setTopics(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Most turns before a person steps in">
              <Input type="number" min={1} max={30} value={d.max_turns} onChange={(e) => set("max_turns", num(e.target.value, 6))} />
            </Field>
            <Field label="Unanswered tries before a person steps in">
              <Input type="number" min={1} max={10} value={d.max_attempts} onChange={(e) => set("max_attempts", num(e.target.value, 2))} />
            </Field>
            <Field label="Confidence needed to answer (0 to 1)">
              <Input type="number" min={0} max={1} step={0.05} value={d.confidence_threshold} onChange={(e) => set("confidence_threshold", num(e.target.value, 0.6))} />
            </Field>
            <Field label="Knowledge match needed (0 to 1)">
              <Input type="number" min={0} max={1} step={0.05} value={d.coverage_threshold} onChange={(e) => set("coverage_threshold", num(e.target.value, 0.5))} />
            </Field>
          </div>
          <Field label="While a ticket waits for a person">
            <Select value={d.waiting_behavior} onValueChange={(v) => set("waiting_behavior", v as "silent" | "gather_info")} options={[{ value: "gather_info", label: "Ask for contact details once" }, { value: "silent", label: "Stay silent" }]} />
          </Field>
        </fieldset>

        <Switch label="Switched on" hint="An agent that is off never talks to visitors." checked={d.enabled} onChange={(on) => set("enabled", on)} />
        {save.isError && <ErrorNotice error={save.error} />}
        {uploadAvatar.isError && <ErrorNotice error={uploadAvatar.error} />}
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending || uploadAvatar.isPending}>
            {save.isPending || uploadAvatar.isPending ? "Saving…" : "Save agent"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </EditorPanel>
      {agent && <Sandbox agent={agent} />}
    </div>
  );
}

function Agents() {
  const agents = useAgents();
  const { create, update, remove } = useAgentMutations();
  const depts = useDepartments();
  const [createdDefault, setCreatedDefault] = useState(false);
  const tried = useRef(false);
  const ws = useQueryClient().getQueryData<Session>(keys.me)?.workspace?.id ?? "unknown";
  // First visit with no agent at all: create the default one once per workspace (the browser remembers, so deleting it is final).
  useEffect(() => {
    if (!agents.data || agents.data.length > 0 || tried.current || offered(ws)) return;
    tried.current = true;
    markOffered(ws);
    create.mutate(DEFAULT_AGENT, { onSuccess: () => setCreatedDefault(true), onError: () => markOffered(ws, false) });
  }, [agents.data, create, ws]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [preset, setPreset] = useState<AgentPreset | null>(null);
  const startNew = (p: AgentPreset | null) => (setPreset(p), setEditing("new"));
  const [confirm, setConfirm] = useState<AiAgent | null>(null);
  const data = agents.data ?? [];
  const current = data.find((a) => a.id === editing) ?? null;
  const deptName = (id: string) => depts.data?.find((x) => x.id === id)?.name ?? "a deleted department";
  return (
    <SettingsSection
      title="AI agents"
      description="An agent answers visitors from your knowledge base, collects what your team needs, and hands over to a person when it should. Visitors always know it is an AI and can ask for a person at any time."
      actions={
        <Button size="sm" disabled={data.length >= MAX_AGENTS} onClick={() => startNew(null)}>
          <Plus aria-hidden="true" /> New agent
        </Button>
      }
    >
      {agents.isPending && (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading AI agents">
          <Skeleton className="h-14" />
        </div>
      )}
      {agents.isError && <ErrorNotice error={agents.error} onRetry={() => void agents.refetch()} />}
      {createdDefault && (
        <p role="status" className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary-text">
          We created an AI agent called Aria and switched it on. It answers from your Knowledge base and hands over to your team when it cannot. Add a few knowledge-base entries, then try it below.
        </p>
      )}
      {agents.data && data.length === 0 && editing === null && !create.isPending && (
        <EmptyState icon={Bot} title="No AI agents yet" hint="Add your help-centre answers under Knowledge base first, then create an agent and try it before switching it on." action={<Button onClick={() => startNew(null)}>New agent</Button>} />
      )}
      {data.length > 0 && (
        <RowList>
          {data.map((a) => (
            <ListRow
              key={a.id}
              actions={
                <>
                  <Button variant="outline" size="sm" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a.id)}>
                    <Pencil aria-hidden="true" /> <span className="max-sm:sr-only">Edit</span>
                  </Button>
                  <Button variant="danger-ghost" size="sm" aria-label={`Delete ${a.name}`} onClick={() => setConfirm(a)}>
                    <Trash2 aria-hidden="true" /> <span className="max-sm:sr-only">Delete</span>
                  </Button>
                </>
              }
            >
              <div className="flex items-center gap-3">
                <AgentAvatar url={a.avatar_url} name={a.name} size={36} />
                <div className="min-w-0">
                  <strong className="block truncate text-sm">{a.name}</strong>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                    <Badge tone={a.enabled ? "success" : "neutral"}>{a.enabled ? "On" : "Off"}</Badge>
                    <span>{AUTONOMY[a.autonomy].label}</span>
                    <span>{a.department_ids.length ? a.department_ids.map(deptName).join(", ") : "All departments"}</span>
                  </p>
                </div>
                <div className="ml-auto">
                  <SwitchControl aria-label={`${a.name} on`} checked={a.enabled} onCheckedChange={(on) => update.mutate({ id: a.id, enabled: on })} />
                </div>
              </div>
            </ListRow>
          ))}
        </RowList>
      )}
      {update.isError && <ErrorNotice error={update.error} />}
      {remove.isError && <ErrorNotice error={remove.error} />}
      {editing === "new" && !preset && data.length < MAX_AGENTS && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4" role="group" aria-label="Start from a preset">
          <p className="text-[13px] font-semibold">Start from a preset</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {AGENT_PRESETS.map((p) => (
              <button key={p.key} type="button" onClick={() => setPreset(p)} className="flex items-center gap-3 rounded-md border border-border p-3 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring">
                <AgentAvatar url={p.avatar_url} name={p.name} size={44} />
                <span className="min-w-0">
                  <strong className="block text-sm">{p.name}</strong>
                  <span className="block text-xs text-muted-foreground">{p.tagline}</span>
                </span>
              </button>
            ))}
            <button type="button" onClick={() => setPreset({ key: "aria", name: "", tagline: "", tone: "friendly", persona: "", greeting: "", avatar_url: "", avatar_alt: "", disclosure_label: "AI assistant" })} className="flex items-center gap-3 rounded-md border border-dashed border-border p-3 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring">
              <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-subtle" aria-hidden="true">
                <Plus className="size-4" />
              </span>
              <span>
                <strong className="block text-sm">Blank</strong>
                <span className="block text-xs text-muted-foreground">Write it from scratch</span>
              </span>
            </button>
          </div>
        </div>
      )}
      {editing !== null && (editing !== "new" || preset) && <AgentEditor key={`${editing}:${preset?.key ?? ""}:${preset?.name ?? ""}`} preset={preset && preset.name ? preset : null} agent={editing === "new" ? null : current} onClose={() => (setEditing(null), setPreset(null))} />}
      {confirm && <ConfirmDialog title="Delete AI agent" message={`Delete ${confirm.name}? Tickets it is handling go back to your team.`} onCancel={() => setConfirm(null)} onConfirm={() => (remove.mutate(confirm.id), setConfirm(null))} />}
    </SettingsSection>
  );
}

interface AiChannels {
  sms: { enabled: boolean; max_replies_per_day: number; max_segments: number; quiet_hours: { enabled: boolean; start: string; end: string } };
  email: { enabled: boolean; max_replies_per_day: number; max_chars: number; signature: string };
}
const AI_CHANNELS: AiChannels = { sms: { enabled: false, max_replies_per_day: 5, max_segments: 3, quiet_hours: { enabled: true, start: "21:00", end: "08:00" } }, email: { enabled: false, max_replies_per_day: 5, max_chars: 2000, signature: "" } };

/** The workspace's switches for AI answers by SMS and email (each agent must also have the channel). */
export function AiChannelSettings() {
  const ws = useQuery({ queryKey: ["workspace", "ai-channels"], queryFn: () => api.get<Workspace>("/workspace") });
  if (!ws.data) return ws.isError ? null : <Skeleton className="h-24" />;
  return <AiChannelForm workspace={ws.data} />;
}
function AiChannelForm({ workspace }: { workspace: Workspace }) {
  const qc = useQueryClient();
  const saved = (workspace.settings as { ai_channels?: Partial<AiChannels> } | undefined)?.ai_channels;
  const cur: AiChannels = { sms: { ...AI_CHANNELS.sms, ...(saved?.sms ?? {}), quiet_hours: { ...AI_CHANNELS.sms.quiet_hours, ...(saved?.sms?.quiet_hours ?? {}) } }, email: { ...AI_CHANNELS.email, ...(saved?.email ?? {}) } };
  const [v, setV] = useState<AiChannels>(cur);
  const save = useMutation({
    mutationFn: (ai_channels: AiChannels) => api.patch<Workspace>("/workspace", { settings: { ai_channels } }),
    onSuccess: (w) => {
      qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, workspace: w } : s));
      qc.setQueryData(["workspace", "ai-channels"], w);
      toast({ title: "Saved", tone: "success" });
    },
  });
  const dirty = JSON.stringify(v) !== JSON.stringify(cur);
  const sms = (p: Partial<AiChannels["sms"]>) => setV({ ...v, sms: { ...v.sms, ...p } });
  const email = (p: Partial<AiChannels["email"]>) => setV({ ...v, email: { ...v.email, ...p } });
  return (
    <SettingsSection title="SMS and email answers" description="AI agents can answer texts and emails too: the same knowledge base, safety rules, hand-over and budget as the chat, in plain text through your own Twilio and SendGrid. Off until you switch a channel on here AND give an agent that channel.">
      <form
        className="flex max-w-xl flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(v);
        }}
      >
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">SMS</legend>
          <Switch label="AI agents answer texts" hint="The first reply starts with the agent's name and the AI label and says to reply HUMAN for a person. Buttons become 'Reply 1 for ...'. Never sent to contacts who texted STOP, to short codes or automated texts." checked={v.sms.enabled} onChange={(enabled) => sms({ enabled })} />
          {v.sms.enabled && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="AI replies per conversation per day" hint="Then a person takes over: no endless loops with an automated sender.">
                  <Input type="number" min={1} max={50} value={v.sms.max_replies_per_day} onChange={(e) => sms({ max_replies_per_day: Number(e.target.value) })} />
                </Field>
                <Field label="Longest text (segments)" hint="One segment is 160 plain characters (70 with emoji or accents outside the SMS alphabet); each costs a credit at most providers.">
                  <Input type="number" min={1} max={10} value={v.sms.max_segments} onChange={(e) => sms({ max_segments: Number(e.target.value) })} />
                </Field>
              </div>
              <Switch label="No AI texts at night" hint="In the contact's time zone, else your office-hours zone. The message goes to your team instead." checked={v.sms.quiet_hours.enabled} onChange={(enabled) => sms({ quiet_hours: { ...v.sms.quiet_hours, enabled } })} />
              {v.sms.quiet_hours.enabled && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Night starts">
                    <Input type="time" value={v.sms.quiet_hours.start} onChange={(e) => sms({ quiet_hours: { ...v.sms.quiet_hours, start: e.target.value } })} />
                  </Field>
                  <Field label="Night ends">
                    <Input type="time" value={v.sms.quiet_hours.end} onChange={(e) => sms({ quiet_hours: { ...v.sms.quiet_hours, end: e.target.value } })} />
                  </Field>
                </div>
              )}
            </>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-[13px] font-semibold">Email</legend>
          <Switch label="AI agents answer emails" hint="Replies stay in the customer's thread. The first says it is from an AI; every reply ends with the agent's sign-off. Never sent to out-of-office replies, bounces, mailing lists, no-reply senders or other bots, or to contacts who unsubscribed." checked={v.email.enabled} onChange={(enabled) => email({ enabled })} />
          {v.email.enabled && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="AI replies per conversation per day">
                  <Input type="number" min={1} max={50} value={v.email.max_replies_per_day} onChange={(e) => email({ max_replies_per_day: Number(e.target.value) })} />
                </Field>
                <Field label="Longest answer (characters)">
                  <Input type="number" min={200} max={10000} value={v.email.max_chars} onChange={(e) => email({ max_chars: Number(e.target.value) })} />
                </Field>
              </div>
              <Field label="Extra signature line" hint="Added under the AI's sign-off, for example your opening hours.">
                <Input value={v.email.signature} maxLength={300} onChange={(e) => email({ signature: e.target.value })} />
              </Field>
            </>
          )}
        </fieldset>
        <p className="text-xs text-subtle">Replies go through your connected providers and cost credits like any other message. Without a connected provider (test mode) they are stored as "not sent".</p>
        {save.isError && <ErrorNotice error={save.error} />}
        <div className="flex gap-2">
          <Button type="submit" disabled={!dirty} loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function Turn({ t }: { t: AgentTurn }) {
  return (
    <li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge tone={OUTCOME_TONE[t.outcome]}>{OUTCOME_LABEL[t.outcome]}</Badge>
        {t.reason && <span className="text-muted-foreground">{REASON_LABEL[t.reason] ?? t.reason}</span>}
        {t.confidence !== null && t.confidence > 0 && <span className="text-subtle">{Math.round(t.confidence * 100)}%</span>}
        <Link to={`/inbox/${t.room_id}`} className="ml-auto text-primary-text underline-offset-2 hover:underline">
          Ticket #{t.ticket_number ?? "?"}
        </Link>
        <time className="text-xs text-subtle" dateTime={t.created_at}>
          {new Date(t.created_at).toLocaleString()}
        </time>
      </div>
      <p className="text-sm">
        <span className="text-subtle">Visitor: </span>
        {t.visitor_text}
      </p>
      {t.answer && <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{t.answer}</p>}
      <p className="flex flex-wrap items-center gap-3 text-xs text-subtle">
        {t.sources.length > 0 && <span>From: {t.sources.map((s) => s.question).join("; ")}</span>}
        {t.votes.up > 0 && (
          <span className="inline-flex items-center gap-1 text-success-text">
            <ThumbsUp className="size-3.5" aria-hidden="true" /> {t.votes.up}
            <span className="sr-only"> helpful</span>
          </span>
        )}
        {t.votes.down > 0 && (
          <span className="inline-flex items-center gap-1 text-danger-text">
            <ThumbsDown className="size-3.5" aria-hidden="true" /> {t.votes.down}
            <span className="sr-only"> not helpful</span>
          </span>
        )}
      </p>
    </li>
  );
}

function Review() {
  const agents = useAgents();
  const [f, setF] = useState<TurnFilters>({});
  const turns = useAgentTurns(f);
  const rows = turns.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <SettingsSection title="Review conversations" description="Every step an agent took, with the sources it used and the ratings it received. Start with the answers people marked as not helpful.">
      <div className="flex flex-wrap gap-3">
        <Field label="Rating" className="w-44">
          <Select value={f.rated ?? "all"} onValueChange={(v) => setF({ ...f, rated: v === "all" ? undefined : (v as TurnFilters["rated"]) })} options={[{ value: "all", label: "Any" }, { value: "down", label: "Not helpful" }, { value: "up", label: "Helpful" }, { value: "any", label: "Rated" }]} />
        </Field>
        <Field label="Outcome" className="w-44">
          <Select value={f.outcome ?? "all"} onValueChange={(v) => setF({ ...f, outcome: v === "all" ? undefined : (v as AgentTurnOutcome) })} options={[{ value: "all", label: "Any" }, ...(Object.keys(OUTCOME_LABEL) as AgentTurnOutcome[]).map((o) => ({ value: o, label: OUTCOME_LABEL[o] }))]} />
        </Field>
        {(agents.data?.length ?? 0) > 1 && (
          <Field label="Agent" className="w-44">
            <Select value={f.agent_id ?? "all"} onValueChange={(v) => setF({ ...f, agent_id: v === "all" ? undefined : v })} options={[{ value: "all", label: "All" }, ...(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))]} />
          </Field>
        )}
      </div>
      {turns.isPending && <Skeleton className="h-20" />}
      {turns.isError && <ErrorNotice error={turns.error} onRetry={() => void turns.refetch()} />}
      {turns.data && rows.length === 0 && <EmptyState icon={MessageSquareWarning} title="Nothing to review" hint="Agent answers show up here as visitors talk to them." />}
      {rows.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" aria-label="Agent turns">
          {rows.map((t) => (
            <Turn key={t.id} t={t} />
          ))}
        </ul>
      )}
      {turns.hasNextPage && (
        <div>
          <Button variant="outline" loading={turns.isFetchingNextPage} onClick={() => void turns.fetchNextPage()}>
            Show more
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}

function Unanswered() {
  const [days, setDays] = useState("30");
  const q = useUnanswered(Number(days));
  return (
    <SettingsSection
      title="Questions without an answer"
      description="What visitors asked that the knowledge base could not answer, grouped by what they have in common. The biggest groups are the entries worth writing first."
      actions={<div className="w-40"><Select value={days} onValueChange={setDays} aria-label="Period" options={[{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }]} /></div>}
    >
      {q.isPending && <Skeleton className="h-16" />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState icon={MessageSquareWarning} title="Nothing unanswered" hint="Every question in this period found an answer." />}
      {!!q.data?.length && (
        <RowList>
          {q.data.map((c) => (
            <ListRow key={c.sample} actions={<Link to="/settings/knowledge-base" state={{ question: c.suggested_question }}><Button variant="outline" size="sm" aria-label={`Write an entry for ${c.suggested_question}`}>Write an entry</Button></Link>}>
              <p className="text-sm font-medium">{c.sample}</p>
              <p className="text-[13px] text-muted-foreground">
                Asked {c.count} {c.count === 1 ? "time" : "times"}
                {c.examples.length > 1 ? `, also: ${c.examples.slice(1).join("; ")}` : ""}
              </p>
            </ListRow>
          ))}
        </RowList>
      )}
    </SettingsSection>
  );
}

export function AiAgentsSettings() {
  const [tab, setTab] = useState<"agents" | "review" | "unanswered">("agents");
  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-4">
        <TabsList aria-label="AI agents sections">
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="unanswered">Unanswered</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "agents" && (
        <>
          <Agents />
          <AiChannelSettings />
        </>
      )}
      {tab === "review" && <Review />}
      {tab === "unanswered" && <Unanswered />}
    </>
  );
}
