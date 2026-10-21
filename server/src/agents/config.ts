import { z } from "zod";
import { can } from "../authz/permissions.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { OfficeHoursSchema } from "../domain/settings.js";
import type { Actor } from "../domain/types.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "../services/audit.js";
import { isOpen } from "../services/office.js";
import { DEFAULT_SENSITIVE_TOPICS } from "./humanRequest.js";
import { BUNDLED_AVATAR_PATH } from "./presets.js";

/** What an AI agent may do on its own. Everything else is a person's decision; there is no plugin or free-form HTTP tool in v1 (docs/AI-AGENTS.md). */
export const AGENT_ACTIONS = ["collect_info", "route", "resolve", "quick_replies", "request_human", "schedule_callback", "offer_call", "ai_call", "share_call_link", "send_transcript"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];
/** Chat (the widget and the hosted page). SMS and email replies would go through the delivery pipeline and its credits: not built in v1. */
export const AGENT_CHANNELS = ["widget", "sms", "email"] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];
export const AUTONOMY = ["suggest_only", "auto_answer", "auto_resolve"] as const;

export const HandoffTriggersSchema = z.object({
  human_request: z.boolean().default(true),
  low_confidence: z.boolean().default(true),
  repeated_rephrase: z.boolean().default(true),
  negative_sentiment: z.boolean().default(true),
  high_urgency: z.boolean().default(true),
  sensitive_topic: z.boolean().default(true),
  vip_contact: z.boolean().default(true),
  tool_failure: z.boolean().default(true),
  sensitive_topics: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(100).default(DEFAULT_SENSITIVE_TOPICS),
});
export type HandoffTriggers = z.infer<typeof HandoffTriggersSchema>;

const language = z.string().trim().toLowerCase().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/, "Use a language code such as en or pt-br");
const url = z.string().trim().max(500).refine((u) => BUNDLED_AVATAR_PATH.test(u) || (/^https?:\/\//i.test(u) && z.url().safeParse(u).success), "Use an http or https address, or one of the bundled pictures");

export const AgentBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  avatar_url: url.nullable().default(null),
  /** what a screen reader says about the portrait (empty = the agent's name and label) */
  avatar_alt: z.string().trim().max(200).default(""),
  persona: z.string().trim().max(2000).default(""),
  tone: z.enum(["friendly", "professional", "concise", "empathetic"]).default("friendly"),
  languages: z.array(language).max(10).default([]),
  greeting: z.string().trim().max(500).default(""),
  department_ids: z.array(z.string().min(1).max(64)).max(50).default([]),
  hours: OfficeHoursSchema.default(() => OfficeHoursSchema.parse({})),
  kb_collections: z.array(z.string().trim().max(60)).max(30).default([]),
  autonomy: z.enum(AUTONOMY).default("auto_answer"),
  confidence_threshold: z.number().min(0).max(1).default(0.6),
  coverage_threshold: z.number().min(0).max(1).default(0.5),
  max_turns: z.number().int().min(1).max(30).default(6),
  max_attempts: z.number().int().min(1).max(10).default(2),
  allowed_actions: z.array(z.enum(AGENT_ACTIONS)).max(10).default([...AGENT_ACTIONS]),
  handoff_triggers: HandoffTriggersSchema.default(() => HandoffTriggersSchema.parse({})),
  waiting_behavior: z.enum(["silent", "gather_info"]).default("gather_info"),
  disclosure_label: z.string().trim().min(2).max(40).default("AI assistant"),
  channels: z.array(z.enum(AGENT_CHANNELS)).min(1).max(3).default(["widget"]),
  enabled: z.boolean().default(false),
});
/** A patch names only what changes: `.partial()` of the body would fill every field it leaves out with its default (and reset persona, hours, picture...). */
export const AgentPatchSchema = z.object(Object.fromEntries(Object.entries(AgentBodySchema.shape).map(([k, v]) => [k, (v instanceof z.ZodDefault ? v.removeDefault() : v).optional()]))) as unknown as z.ZodType<Partial<z.infer<typeof AgentBodySchema>>>;
export type AgentBody = z.infer<typeof AgentBodySchema>;

export interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  avatar_url: string | null;
  avatar_key: string | null;
  avatar_alt: string;
  persona: string;
  tone: AgentBody["tone"];
  languages: string;
  greeting: string;
  department_ids: string;
  hours: string;
  kb_collections: string;
  autonomy: (typeof AUTONOMY)[number];
  confidence_threshold: number;
  coverage_threshold: number;
  max_turns: number;
  max_attempts: number;
  allowed_actions: string;
  handoff_triggers: string;
  waiting_behavior: "silent" | "gather_info";
  disclosure_label: string;
  channels: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export const agentDto = (a: AgentRow) => ({
  id: a.id,
  name: a.name,
  avatar_url: a.avatar_url,
  avatar_alt: a.avatar_alt,
  /** the picture is an upload held by this app (rather than a link to a picture elsewhere) */
  avatar_uploaded: !!a.avatar_key,
  persona: a.persona,
  tone: a.tone,
  languages: parseJson<string[]>(a.languages, []),
  greeting: a.greeting,
  department_ids: parseJson<string[]>(a.department_ids, []),
  hours: OfficeHoursSchema.parse(parseJson<unknown>(a.hours, {})),
  kb_collections: parseJson<string[]>(a.kb_collections, []),
  autonomy: a.autonomy,
  confidence_threshold: a.confidence_threshold,
  coverage_threshold: a.coverage_threshold,
  max_turns: a.max_turns,
  max_attempts: a.max_attempts,
  allowed_actions: parseJson<AgentAction[]>(a.allowed_actions, []),
  handoff_triggers: HandoffTriggersSchema.parse(parseJson<unknown>(a.handoff_triggers, {})),
  waiting_behavior: a.waiting_behavior,
  disclosure_label: a.disclosure_label,
  channels: parseJson<AgentChannel[]>(a.channels, ["widget"]),
  enabled: !!a.enabled,
  created_at: a.created_at,
  updated_at: a.updated_at,
});
export type AgentDto = ReturnType<typeof agentDto>;

const MAX_AGENTS = 5;
const requireManage = (actor: Actor) => {
  if (!can(actor, "agents:manage")) throw forbidden("You need the AI agents permission", "PERMISSION_DENIED");
};

export const findAgent = (ctx: AppContext, ws: string, id: string) => ctx.db.get<AgentRow>("SELECT * FROM ai_agents WHERE id = ? AND workspace_id = ?", id, ws);
export async function getAgent(ctx: AppContext, ws: string, id: string): Promise<AgentRow> {
  const a = await findAgent(ctx, ws, id);
  if (!a) throw notFound("AI agent");
  return a;
}
export const listAgentRows = (ctx: AppContext, ws: string) => ctx.db.all<AgentRow>("SELECT * FROM ai_agents WHERE workspace_id = ? ORDER BY created_at, id", ws);

async function assertDepartments(ctx: AppContext, ws: string, ids: string[]) {
  for (const id of ids) if (!(await ctx.db.get("SELECT 1 FROM inboxes WHERE id = ? AND workspace_id = ?", id, ws))) throw unprocessable("UNKNOWN_DEPARTMENT", `Department ${id} does not exist`);
}

const toColumns = (b: AgentBody) => [
  b.name,
  b.avatar_url,
  b.avatar_alt,
  b.persona,
  b.tone,
  JSON.stringify([...new Set(b.languages)]),
  b.greeting,
  JSON.stringify([...new Set(b.department_ids)]),
  JSON.stringify(b.hours),
  JSON.stringify([...new Set(b.kb_collections.filter(Boolean))]),
  b.autonomy,
  b.confidence_threshold,
  b.coverage_threshold,
  b.max_turns,
  b.max_attempts,
  JSON.stringify([...new Set(b.allowed_actions)]),
  JSON.stringify(b.handoff_triggers),
  b.waiting_behavior,
  b.disclosure_label,
  JSON.stringify([...new Set(b.channels)]),
  b.enabled,
];
const COLS = "name, avatar_url, avatar_alt, persona, tone, languages, greeting, department_ids, hours, kb_collections, autonomy, confidence_threshold, coverage_threshold, max_turns, max_attempts, allowed_actions, handoff_triggers, waiting_behavior, disclosure_label, channels, enabled";

export async function createAgent(ctx: AppContext, actor: Actor, body: AgentBody): Promise<AgentRow> {
  requireManage(actor);
  if ((await listAgentRows(ctx, actor.workspaceId)).length >= MAX_AGENTS) throw unprocessable("TOO_MANY_AGENTS", `At most ${MAX_AGENTS} AI agents per workspace`);
  await assertDepartments(ctx, actor.workspaceId, body.department_ids);
  const id = newId("agt");
  const now = nowIso(ctx);
  await ctx.db.run(`INSERT INTO ai_agents(id, workspace_id, ${COLS}, created_at, updated_at) VALUES (?,?,${COLS.split(", ").map(() => "?").join(",")},?,?)`, id, actor.workspaceId, ...toColumns(body), now, now);
  await invalidateAgents(ctx, actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ai_agent.created", target: id, detail: { name: body.name, enabled: body.enabled } });
  return (await getAgent(ctx, actor.workspaceId, id))!;
}

export async function updateAgent(ctx: AppContext, actor: Actor, id: string, patch: Partial<AgentBody>): Promise<AgentRow> {
  requireManage(actor);
  const cur = await getAgent(ctx, actor.workspaceId, id);
  if (patch.department_ids) await assertDepartments(ctx, actor.workspaceId, patch.department_ids);
  const merged = AgentBodySchema.parse({ ...agentDtoBody(cur), ...patch });
  // pointing the picture somewhere else (or clearing it) replaces an upload: the stored file goes away with it
  if (cur.avatar_key && patch.avatar_url !== undefined && patch.avatar_url !== cur.avatar_url) {
    await ctx.storage.remove(cur.avatar_key).catch(() => {});
    await ctx.db.run("UPDATE ai_agents SET avatar_key = NULL WHERE id = ?", id);
  }
  await ctx.db.run(`UPDATE ai_agents SET ${COLS.split(", ").map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...toColumns(merged), nowIso(ctx), id);
  await invalidateAgents(ctx, actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ai_agent.updated", target: id, detail: { fields: Object.keys(patch) } });
  return getAgent(ctx, actor.workspaceId, id);
}

const agentDtoBody = (a: AgentRow): AgentBody => {
  const { id: _i, created_at: _c, updated_at: _u, ...rest } = agentDto(a);
  return rest as AgentBody;
};

export async function deleteAgent(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  requireManage(actor);
  const gone = await getAgent(ctx, actor.workspaceId, id);
  if (gone.avatar_key) await ctx.storage.remove(gone.avatar_key).catch(() => {});
  await ctx.db.tx(async () => {
    // tickets the agent was handling go back to people
    await ctx.db.run("UPDATE tickets SET handler = NULL, status = CASE WHEN status = 'bot_handling' THEN 'new' ELSE status END WHERE workspace_id = ? AND handler = ? AND status <> 'closed'", actor.workspaceId, `bot:${id}`);
    await ctx.db.run("DELETE FROM ai_agents WHERE id = ?", id);
  });
  await invalidateAgents(ctx, actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ai_agent.deleted", target: id });
}

/**
 * The agent that works a conversation now: enabled, switched on for the channel, covering the department (an empty list covers all), in the order
 * they were created. Hours are reported separately (`inHours`) because an agent outside its hours hands over instead of staying silent.
 */
export async function selectAgent(ctx: AppContext, ws: string, o: { channel: AgentChannel; departmentId: string | null; at?: Date }): Promise<{ agent: AgentRow; inHours: boolean } | null> {
  const rows = await ctx.cache.wrap(`agents:${ws}`, () => listAgentRows(ctx, ws));
  for (const a of rows) {
    if (!a.enabled || !parseJson<string[]>(a.channels, ["widget"]).includes(o.channel)) continue;
    const depts = parseJson<string[]>(a.department_ids, []);
    if (depts.length && !(o.departmentId && depts.includes(o.departmentId))) continue;
    return { agent: a, inHours: isOpen(OfficeHoursSchema.parse(parseJson<unknown>(a.hours, {})), o.at ?? ctx.clock()) };
  }
  return null;
}

export const invalidateAgents = (ctx: AppContext, ws: string) => ctx.cache.invalidate(`agents:${ws}`);
