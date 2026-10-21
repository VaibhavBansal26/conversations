import { ArrowDown, ArrowUp, Building2, Clock, FlaskConical, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useDepartments, useRoutingRules, useRuleMutations, useUpdateDepartment, type DepartmentPatch, type RuleDraft } from "../../api/departmentHooks";
import type { Department, DepartmentHours, RoutingMode, RoutingRule, RuleCondition, RuleField, RuleOp, RuleTestResult } from "../../api/types";
import { HoursEditor } from "../../components/settings/HoursEditor";
import { ConfirmDialog } from "../../components/settings/ConfirmDialog";
import { EditorPanel, ListRow, RowList, SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { Badge, Button, EmptyState, ErrorNotice, Field, Input, Select, Skeleton, Switch, Textarea, toast } from "../../ui";

const MODE_LABEL: Record<RoutingMode, string> = {
  round_robin: "Round robin",
  least_busy: "Least busy",
  skills_based: "Skills based",
  manual_pick: "Manual pick",
};
const MODE_HELP: Record<RoutingMode, string> = {
  round_robin: "Each new ticket goes to the next available person in turn.",
  least_busy: "Each new ticket goes to the available person with the fewest open tickets.",
  skills_based: "Prefers people with the skills and languages the ticket needs, then the least busy of them.",
  manual_pick: "Nobody is assigned; tickets wait in the queue and people claim them.",
};

interface MemberDraft {
  member_id: string;
  name: string;
  skills: string;
  languages: string;
  capacity: string;
}
interface Draft {
  description: string;
  live_routing_visibility: boolean;
  routing_mode: RoutingMode | "";
  capacity: string;
  hours: DepartmentHours;
  sla_first_min: string;
  sla_resolution_h: string;
  overflow_inbox_id: string;
  auto_reply_closed: string;
  auto_reply_queued: string;
  members: MemberDraft[];
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const toDraft = (d: Department): Draft => ({
  description: d.description ?? "",
  live_routing_visibility: d.live_routing_visibility,
  routing_mode: d.routing_mode ?? "",
  capacity: String(d.capacity),
  hours: d.hours,
  sla_first_min: d.sla_first_response_s ? String(Math.round(d.sla_first_response_s / 60)) : "",
  sla_resolution_h: d.sla_resolution_s ? String(Math.round(d.sla_resolution_s / 3600)) : "",
  overflow_inbox_id: d.overflow_inbox_id ?? "",
  auto_reply_closed: d.auto_reply_closed,
  auto_reply_queued: d.auto_reply_queued,
  members: d.members.map((m) => ({ member_id: m.member_id, name: m.name, skills: m.skills.join(", "), languages: m.languages.join(", "), capacity: m.capacity === null ? "" : String(m.capacity) })),
});
const toPatch = (d: Draft): DepartmentPatch => ({
  description: d.description,
  live_routing_visibility: d.live_routing_visibility,
  routing_mode: d.routing_mode === "" ? null : d.routing_mode,
  capacity: Number(d.capacity) || 0,
  hours: d.hours,
  sla_first_response_s: d.sla_first_min.trim() ? Math.round(Number(d.sla_first_min) * 60) : null,
  sla_resolution_s: d.sla_resolution_h.trim() ? Math.round(Number(d.sla_resolution_h) * 3600) : null,
  overflow_inbox_id: d.overflow_inbox_id || null,
  auto_reply_closed: d.auto_reply_closed,
  auto_reply_queued: d.auto_reply_queued,
  members: d.members.map((m) => ({ member_id: m.member_id, skills: list(m.skills), languages: list(m.languages), capacity: m.capacity.trim() === "" ? null : Number(m.capacity) })),
});

export const formatWait = (s: number | null): string => (s === null ? "no data yet" : s < 90 ? "under 2 min" : `about ${Math.round(s / 60)} min`);

function StatusBadges({ d }: { d: Department }) {
  const st = d.status;
  return (
    <>
      <Badge tone={st.open ? "success" : "neutral"}>{st.open ? "Open" : "Closed"}</Badge>
      <span className="inline-flex items-center gap-1">
        <Users className="size-3.5" aria-hidden="true" />
        {st.available_agents} free
      </span>
      {st.queue_length > 0 && <Badge tone="warning">{st.queue_length} waiting</Badge>}
    </>
  );
}

function DepartmentEditor({ dept, others, onClose }: { dept: Department; others: Department[]; onClose: () => void }) {
  const save = useUpdateDepartment();
  const [d, setD] = useState<Draft>(() => toDraft(dept));
  const errors = fieldErrors(save.error);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const setMember = (id: string, patch: Partial<MemberDraft>) => set("members", d.members.map((m) => (m.member_id === id ? { ...m, ...patch } : m)));
  const [holiday, setHoliday] = useState("");
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(dept));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ id: dept.id, ...toPatch(d) }, { onSuccess: () => { toast({ title: `${dept.name} saved`, tone: "success" }); onClose(); } });
  };
  return (
    <EditorPanel title={`Edit ${dept.name}`} label={`Edit department ${dept.name}`} onSubmit={submit}>
      <Field label="Description" hint="Shown to visitors who choose a department, and to the AI agent when it decides where a question belongs." error={errors.description}>
        <Textarea rows={2} maxLength={300} value={d.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <Switch label="Offer in the chat widget" hint="Visitors can pick this department before the conversation starts (when the department selector is on in the widget settings)." checked={d.live_routing_visibility} onChange={(v) => set("live_routing_visibility", v)} />

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-[13px] font-semibold">Routing</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mode" hint={d.routing_mode ? MODE_HELP[d.routing_mode] : "Follows the inbox's assignment setting: round robin if it is on, otherwise manual pick."} error={errors.routing_mode}>
            <Select
              value={d.routing_mode}
              onValueChange={(v) => set("routing_mode", v as Draft["routing_mode"])}
              options={[{ value: "", label: "Follow the inbox setting" }, ...(Object.keys(MODE_LABEL) as RoutingMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))]}
            />
          </Field>
          <Field label="Tickets per person" hint="At most this many open tickets per person at once. 0 means no limit." error={errors.capacity}>
            <Input type="number" min={0} max={100} value={d.capacity} onChange={(e) => set("capacity", e.target.value)} />
          </Field>
        </div>
        <Field label="When closed or full, send to" hint="Overflow: a department that takes the ticket when this one is closed or nobody here can take it.">
          <Select value={d.overflow_inbox_id} onValueChange={(v) => set("overflow_inbox_id", v)} options={[{ value: "", label: "Nobody: keep it queued here" }, ...others.map((o) => ({ value: o.id, label: o.name }))]} />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-[13px] font-semibold">Hours and holidays</legend>
        <HoursEditor value={d.hours} onChange={(h) => set("hours", { ...d.hours, ...h })} label="Restrict to opening hours" hint="Off means the department takes tickets whenever someone is available." />
        <Field label="Holidays" hint="Days the department is closed (in its timezone), even inside the hours above.">
          <div className="flex gap-2">
            <Input type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} aria-label="Holiday date" />
            <Button
              variant="outline"
              disabled={!holiday || d.hours.holidays.includes(holiday)}
              onClick={() => {
                set("hours", { ...d.hours, holidays: [...d.hours.holidays, holiday].sort() });
                setHoliday("");
              }}
            >
              Add
            </Button>
          </div>
        </Field>
        {d.hours.holidays.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Holidays">
            {d.hours.holidays.map((h) => (
              <li key={h}>
                <Badge>
                  {h}
                  <button type="button" aria-label={`Remove holiday ${h}`} className="ml-1 rounded-full px-1 hover:bg-surface-3" onClick={() => set("hours", { ...d.hours, holidays: d.hours.holidays.filter((x) => x !== h) })}>
                    ×
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-[13px] font-semibold">Service levels</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First response (minutes)" hint="A ticket nobody answered by then is escalated once. Empty means no target." error={errors.sla_first_response_s}>
            <Input type="number" min={1} value={d.sla_first_min} onChange={(e) => set("sla_first_min", e.target.value)} />
          </Field>
          <Field label="Resolution (hours)" hint="Counted from when the ticket opened. Misses are reported, never moved." error={errors.sla_resolution_s}>
            <Input type="number" min={1} value={d.sla_resolution_h} onChange={(e) => set("sla_resolution_h", e.target.value)} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-[13px] font-semibold">What visitors read</legend>
        <Field label="When closed" hint="Replaces the default text. Leave empty for the default, which names the next opening.">
          <Textarea rows={2} maxLength={500} value={d.auto_reply_closed} onChange={(e) => set("auto_reply_closed", e.target.value)} />
        </Field>
        <Field label="When everyone is busy" hint="Replaces the default text with the place in the queue and the typical wait.">
          <Textarea rows={2} maxLength={500} value={d.auto_reply_queued} onChange={(e) => set("auto_reply_queued", e.target.value)} />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-[13px] font-semibold">People</legend>
        {d.members.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            This department has no members yet. Add them under <Link className="text-primary-text underline" to="/settings/inboxes">Inboxes</Link>.
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {d.members.map((m) => (
            <li key={m.member_id} className="grid gap-3 rounded-md border border-border bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
              <strong className="text-sm sm:col-span-3">{m.name}</strong>
              <Field label="Skills" hint="Comma separated, e.g. billing, api">
                <Input value={m.skills} onChange={(e) => setMember(m.member_id, { skills: e.target.value })} />
              </Field>
              <Field label="Languages" hint="e.g. en, de">
                <Input value={m.languages} onChange={(e) => setMember(m.member_id, { languages: e.target.value })} />
              </Field>
              <Field label="Own limit" hint="Empty: department's">
                <Input type="number" min={0} max={100} value={m.capacity} onChange={(e) => setMember(m.member_id, { capacity: e.target.value })} />
              </Field>
            </li>
          ))}
        </ul>
      </fieldset>

      {save.isError && <ErrorNotice error={save.error} />}
      <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={() => setD(toDraft(dept))} />
    </EditorPanel>
  );
}

/* ---------- routing rules ---------- */

const FIELD_LABEL: Record<RuleField, string> = {
  page_url: "Page address",
  locale: "Language",
  channel: "Channel",
  tag: "Contact tag",
  email_domain: "Email domain",
  attr: "Contact attribute",
};
const OP_LABEL: Record<RuleOp, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  exists: "is set",
};
const blankCondition: RuleCondition = { field: "page_url", op: "contains", value: "" };

function describe(c: RuleCondition): string {
  const subject = c.field === "attr" ? `attribute ${c.key ?? "?"}` : FIELD_LABEL[c.field].toLowerCase();
  return `${subject} ${OP_LABEL[c.op]}${c.op === "exists" ? "" : ` "${c.value}"`}`;
}

function RuleEditor({ rule, departments, onClose }: { rule: RoutingRule | null; departments: Department[]; onClose: () => void }) {
  const m = useRuleMutations();
  const [draft, setDraft] = useState<RuleDraft>(() => (rule ? { name: rule.name, enabled: rule.enabled, conditions: rule.conditions, department_id: rule.department_id } : { name: "", enabled: true, conditions: [blankCondition], department_id: departments[0]?.id ?? "" }));
  const mutation = rule ? m.update : m.create;
  const setCond = (i: number, patch: Partial<RuleCondition>) => setDraft((d) => ({ ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { ...draft, name: draft.name.trim(), conditions: draft.conditions.map((c) => ({ ...c, value: c.op === "exists" ? "" : c.value.trim(), ...(c.field === "attr" ? { key: c.key?.trim() } : { key: undefined }) })) };
    if (rule) m.update.mutate({ id: rule.id, ...body }, { onSuccess: onClose });
    else m.create.mutate(body, { onSuccess: onClose });
  };
  return (
    <EditorPanel title={rule ? "Edit rule" : "New rule"} label={rule ? "Edit routing rule" : "New routing rule"} onSubmit={submit}>
      <Field label="Name">
        <Input value={draft.name} maxLength={80} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[13px] font-medium">When all of these hold</legend>
        {draft.conditions.map((c, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_9rem_minmax(0,1.4fr)_2.25rem]">
            <Select aria-label={`Condition ${i + 1} field`} value={c.field} onValueChange={(v) => setCond(i, { field: v as RuleField })} options={(Object.keys(FIELD_LABEL) as RuleField[]).map((f) => ({ value: f, label: FIELD_LABEL[f] }))} />
            {c.field === "attr" ? <Input aria-label={`Condition ${i + 1} attribute name`} placeholder="plan" value={c.key ?? ""} onChange={(e) => setCond(i, { key: e.target.value })} /> : <span className="hidden sm:block" />}
            <Select aria-label={`Condition ${i + 1} operator`} value={c.op} onValueChange={(v) => setCond(i, { op: v as RuleOp })} options={(Object.keys(OP_LABEL) as RuleOp[]).map((o) => ({ value: o, label: OP_LABEL[o] }))} />
            <Input aria-label={`Condition ${i + 1} value`} placeholder={c.field === "page_url" ? "/pricing" : "value"} disabled={c.op === "exists"} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} />
            <Button variant="danger-ghost" size="icon" aria-label={`Remove condition ${i + 1}`} disabled={draft.conditions.length === 1} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm" disabled={draft.conditions.length >= 5} onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, blankCondition] })}>
            <Plus aria-hidden="true" /> Add a condition
          </Button>
        </div>
      </fieldset>
      <Field label="Send the conversation to">
        <Select value={draft.department_id} onValueChange={(v) => setDraft({ ...draft, department_id: v })} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
      </Field>
      <Switch label="Rule is on" checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
      {mutation.isError && <ErrorNotice error={mutation.error} />}
      <div className="flex gap-2">
        <Button type="submit" loading={mutation.isPending} disabled={!draft.name.trim() || !draft.department_id}>
          Save rule
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </EditorPanel>
  );
}

function RuleSandbox({ departments }: { departments: Department[] }) {
  const { test } = useRuleMutations();
  const [x, setX] = useState({ page_url: "", locale: "", channel: "dm" as "dm" | "sms" | "email", tags: "" });
  const result: RuleTestResult | undefined = test.data;
  const name = (id: string | null) => departments.find((d) => d.id === id)?.name ?? "the default department";
  return (
    <details className="rounded-lg border border-border bg-surface-2/40">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium">
        <FlaskConical className="size-4 text-subtle" aria-hidden="true" /> Try the rules
      </summary>
      <form
        className="flex flex-col gap-3 border-t border-border p-4"
        aria-label="Test the routing rules"
        onSubmit={(e) => {
          e.preventDefault();
          test.mutate({ page_url: x.page_url || undefined, locale: x.locale || undefined, channel: x.channel, tags: x.tags.split(",").map((t) => t.trim()).filter(Boolean) });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Page address">
            <Input value={x.page_url} placeholder="https://example.com/pricing" onChange={(e) => setX({ ...x, page_url: e.target.value })} />
          </Field>
          <Field label="Visitor language">
            <Input value={x.locale} placeholder="de-DE" onChange={(e) => setX({ ...x, locale: e.target.value })} />
          </Field>
          <Field label="Channel">
            <Select value={x.channel} onValueChange={(v) => setX({ ...x, channel: v as typeof x.channel })} options={[{ value: "dm", label: "Chat" }, { value: "sms", label: "SMS" }, { value: "email", label: "Email" }]} />
          </Field>
          <Field label="Contact tags" hint="Comma separated">
            <Input value={x.tags} onChange={(e) => setX({ ...x, tags: e.target.value })} />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="outline" loading={test.isPending}>
            Test
          </Button>
        </div>
        {test.isError && <ErrorNotice error={test.error} />}
        {result && (
          <p role="status" className="rounded-md bg-surface px-3 py-2 text-sm">
            {result.rule ? (
              <>
                Rule <strong>{result.rule.name}</strong> matches: the conversation goes to <strong>{name(result.department_id)}</strong>.
              </>
            ) : (
              <>No rule matches: the visitor's own choice or the widget's default department decides.</>
            )}
            {result.evaluated.length > 0 && <span className="mt-1 block text-xs text-subtle">Looked at: {result.evaluated.map((e) => `${e.name} (${e.matched ? "match" : "no"})`).join(", ")}</span>}
          </p>
        )}
      </form>
    </details>
  );
}

function RoutingRules({ departments }: { departments: Department[] }) {
  const rules = useRoutingRules();
  const m = useRuleMutations();
  const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);
  const [confirm, setConfirm] = useState<RoutingRule | null>(null);
  const name = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const data = rules.data ?? [];
  const move = (i: number, by: -1 | 1) => {
    const ids = data.map((r) => r.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    m.reorder.mutate(ids);
  };
  return (
    <SettingsSection
      title="Routing rules"
      description="Choose the department of a new conversation from the page the visitor is on, their language, the channel or what you know about them. The first rule that matches wins; a department the visitor picks themselves beats the rules."
      actions={
        <Button size="sm" disabled={!departments.length} onClick={() => setEditing("new")}>
          <Plus aria-hidden="true" /> New rule
        </Button>
      }
    >
      {rules.isPending && <Skeleton className="h-12" />}
      {rules.isError && <ErrorNotice error={rules.error} onRetry={() => void rules.refetch()} />}
      {rules.data && data.length === 0 && editing === null && <p className="text-[13px] text-muted-foreground">No rules. Every new conversation goes to the department it picked, or to the widget's default.</p>}
      {data.length > 0 && (
        <RowList>
          {data.map((r, i) => (
            <ListRow
              key={r.id}
              actions={
                <>
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${r.name} down`} disabled={i === data.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(r)}>
                    <Pencil aria-hidden="true" /> Edit
                  </Button>
                  <Button variant="danger-ghost" size="sm" aria-label={`Delete rule ${r.name}`} onClick={() => setConfirm(r)}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </>
              }
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="tabular-nums text-subtle">{i + 1}.</span>
                  <strong>{r.name}</strong>
                  {!r.enabled && <Badge>Off</Badge>}
                  <span className="text-muted-foreground">goes to</span>
                  <Badge tone="primary">{name.get(r.department_id) ?? "deleted department"}</Badge>
                </p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">When {r.conditions.map(describe).join(" and ")}</p>
              </div>
            </ListRow>
          ))}
        </RowList>
      )}
      {(m.reorder.isError || m.remove.isError) && <ErrorNotice error={m.reorder.error ?? m.remove.error} />}
      {editing !== null && <RuleEditor key={editing === "new" ? "new" : editing.id} rule={editing === "new" ? null : editing} departments={departments} onClose={() => setEditing(null)} />}
      <RuleSandbox departments={departments} />
      {confirm && (
        <ConfirmDialog
          title={`Delete the rule "${confirm.name}"?`}
          message="Conversations are not moved; new ones simply stop matching it."
          confirmLabel="Delete rule"
          onCancel={() => setConfirm(null)}
          onConfirm={() => m.remove.mutate(confirm.id, { onSuccess: () => setConfirm(null) })}
        />
      )}
    </SettingsSection>
  );
}

export function DepartmentSettings() {
  const depts = useDepartments();
  const [editing, setEditing] = useState<string | null>(null);
  const data = depts.data ?? [];
  const current = data.find((d) => d.id === editing);
  return (
    <>
      <SettingsSection
        title="Departments"
        description="A department is an inbox with opening hours, a way of choosing who gets a ticket, capacity and service levels. Create inboxes and choose their members under Inboxes."
        actions={
          <Link to="/settings/inboxes" className="text-[13px] font-medium text-primary-text underline-offset-2 hover:underline">
            Manage inboxes
          </Link>
        }
      >
        {depts.isPending && (
          <div className="flex flex-col gap-3" role="status" aria-label="Loading departments">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
        {depts.isError && <ErrorNotice error={depts.error} onRetry={() => void depts.refetch()} />}
        {depts.data && data.length === 0 && <EmptyState icon={Building2} title="No departments yet" hint="Every inbox is a department. Create one under Inboxes." action={<Link to="/settings/inboxes"><Button>Go to inboxes</Button></Link>} />}
        {data.length > 0 && (
          <RowList>
            {data.map((d) => (
              <ListRow
                key={d.id}
                actions={
                  <Button variant="outline" size="sm" onClick={() => setEditing(d.id)} aria-label={`Edit department ${d.name}`}>
                    <Pencil aria-hidden="true" /> Edit
                  </Button>
                }
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-text">
                    <Building2 className="size-[18px]" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">{d.name}</strong>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                      <StatusBadges d={d} />
                      <span>{MODE_LABEL[d.effective_routing_mode]}</span>
                      {d.capacity > 0 && <span>{d.capacity} each</span>}
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3.5" aria-hidden="true" />
                        wait {formatWait(d.status.estimated_wait_s)}
                      </span>
                      {d.live_routing_visibility && <Badge tone="info">In the widget</Badge>}
                    </p>
                  </div>
                </div>
              </ListRow>
            ))}
          </RowList>
        )}
        {current && <DepartmentEditor key={current.id} dept={current} others={data.filter((o) => o.id !== current.id)} onClose={() => setEditing(null)} />}
      </SettingsSection>
      {data.length > 0 && <RoutingRules departments={data} />}
    </>
  );
}
