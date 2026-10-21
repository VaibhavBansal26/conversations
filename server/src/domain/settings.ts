import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");

export const OfficeHoursSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().default("UTC"),
  /** day: 0 = Sunday .. 6 = Saturday */
  days: z.array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).default([1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" }))),
});

export const RequiredInfoSchema = z.enum(["name", "email", "phone"]);

/** Ticket lifecycle (docs/AI-AGENTS.md). Minutes and hours are wall-clock; 0 turns the matching automation off. */
export const TicketSettingsSchema = z.object({
  /** a reply to a resolved ticket reopens it within this many hours, otherwise it opens a new ticket (0 = always a new ticket) */
  reopen_hours: z.number().int().min(0).max(720).default(72),
  /** a ticket the AI agent is handling, quiet for this long, is resolved as abandoned (0 = off; otherwise at least 5) */
  bot_idle_minutes: z.union([z.literal(0), z.number().int().min(5).max(1440)]).default(30),
  /** a ticket waiting on the customer, quiet for this long, is resolved as abandoned (0 = off) */
  pending_idle_hours: z.number().int().min(0).max(720).default(72),
  /** resolved tickets are closed after this many hours without a reply */
  close_resolved_hours: z.number().int().min(1).max(720).default(72),
  /** ask the visitor for a rating when a ticket is resolved */
  csat_prompt: z.boolean().default(true),
  closing_message: z.string().max(500).default("This conversation has been marked as resolved. If you need anything else, just reply here."),
});
export type TicketSettings = z.infer<typeof TicketSettingsSchema>;

/** Routing of tickets to people (docs/AI-AGENTS.md). */
export const RoutingSettingsSchema = z.object({
  /** a seat only receives a handoff while it is connected (a seat that is active but has the app closed is not available) */
  require_online: z.boolean().default(true),
});

/** How a piece of visitor information is handled: never asked, asked and skippable, asked and required, or asked only when something needs it. */
export const InfoModeSchema = z.enum(["off", "optional", "required", "ask_when_needed"]);
const InfoFields = z.object({ name: InfoModeSchema.default("off"), email: InfoModeSchema.default("off"), phone: InfoModeSchema.default("off") });
export const CustomFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, "Use lower-case letters, digits and underscores"),
    label: z.string().trim().min(1).max(60),
    type: z.enum(["text", "select"]).default("text"),
    options: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    mode: InfoModeSchema.default("ask_when_needed"),
  })
  .refine((f) => f.type !== "select" || f.options.length >= 2, { message: "A choice field needs at least two options", path: ["options"] });
const InfoMoments = z.object({
  /** a ticket goes to a person */
  handoff: z.boolean().default(true),
  /** nobody can take it now (department closed or everybody busy) */
  no_agent: z.boolean().default(true),
  /** a callback or a call is requested */
  callback: z.boolean().default(true),
  /** the conversation was resolved: ask for an email to follow up */
  after: z.boolean().default(false),
});
export const VisitorInfoSchema = z.object({
  fields: InfoFields.default(() => InfoFields.parse({})),
  custom_fields: z.array(CustomFieldSchema).max(5).default([]),
  moments: InfoMoments.default(() => InfoMoments.parse({})),
  consent: z
    .object({
      enabled: z.boolean().default(false),
      text: z.string().trim().min(1).max(300).default("I agree that you may contact me about this conversation."),
      privacy_url: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), "Use an http or https address").nullable().default(null),
    })
    .default(() => ({ enabled: false, text: "I agree that you may contact me about this conversation.", privacy_url: null })),
});
export type VisitorInfoSettings = z.infer<typeof VisitorInfoSchema>;
/** A department may override the fields and the moments (the rest stays the workspace's). */
export const DepartmentInfoSchema = z.object({
  fields: z.object({ name: InfoModeSchema.optional(), email: InfoModeSchema.optional(), phone: InfoModeSchema.optional() }).optional(),
  moments: z.object({ handoff: z.boolean().optional(), no_agent: z.boolean().optional(), callback: z.boolean().optional(), after: z.boolean().optional() }).optional(),
});
export type DepartmentInfo = z.infer<typeof DepartmentInfoSchema>;

/** Voice and video calls (docs/CALLS.md). Everything is off until a manager switches it on. */
export const CallSettingsSchema = z.object({
  browser: z
    .object({
      enabled: z.boolean().default(false),
      voice: z.boolean().default(true),
      video: z.boolean().default(true),
      screen_share: z.boolean().default(true),
    })
    .default(() => ({ enabled: false, voice: true, video: true, screen_share: true })),
  /** click-to-call: the app rings the agent's phone, then the visitor's, through the workspace's own Twilio account */
  phone: z
    .object({
      enabled: z.boolean().default(false),
      /** one of the workspace's imported Twilio numbers; shown to the visitor as the caller */
      caller_id: z.string().regex(/^\+[1-9]\d{6,14}$/).nullable().default(null),
      /** at most this many phone calls per workspace per UTC day (spend guard) */
      daily_limit: z.number().int().min(1).max(1000).default(50),
      /** ISO 3166-1 alpha-2 codes the visitor's number may be in; empty = none (nothing is called until a manager chooses) */
      allowed_countries: z.array(z.string().length(2).toUpperCase()).max(60).default([]),
      /** the bridge ends after this many seconds */
      max_duration_s: z.number().int().min(60).max(7200).default(1800),
      /** no calls to a visitor at night in the visitor's time zone (their browser's, else the workspace's office-hours zone) */
      quiet_hours: z
        .object({ enabled: z.boolean().default(true), start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("21:00"), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("08:00") })
        .default(() => ({ enabled: true, start: "21:00", end: "08:00" })),
    })
    .default(() => ({ enabled: false, caller_id: null, daily_limit: 50, allowed_countries: [], max_duration_s: 1800, quiet_hours: { enabled: true, start: "21:00", end: "08:00" } })),
  /** calls with the AI agent (ADR 0033): off until a manager switches them on. The visitor's browser does the speech; no audio reaches this server and nothing is recorded. */
  ai: z
    .object({
      enabled: z.boolean().default(false),
      voice: z.boolean().default(true),
      /** "video" with the AI is an animated avatar: the visitor's camera is never sent anywhere */
      video: z.boolean().default(true),
      /** hard limit of one call */
      max_duration_s: z.number().int().min(60).max(1800).default(600),
      /** a call with no speech for this long ends */
      idle_timeout_s: z.number().int().min(30).max(600).default(120),
      /** calls with the AI at the same time in this workspace (also bounded by the ai.concurrency policy) */
      max_concurrent: z.number().int().min(1).max(20).default(3),
      /** AI calls started per workspace per UTC day (spend guard) */
      daily_limit: z.number().int().min(1).max(1000).default(100),
      /** the realtime engine only: minutes of realtime calls per workspace per UTC day, and how many may run at once (it is the costly one) */
      realtime_minutes_daily: z.number().int().min(1).max(1000).default(30),
      realtime_max_concurrent: z.number().int().min(1).max(10).default(2),
    })
    .default(() => ({ enabled: false, voice: true, video: true, max_duration_s: 600, idle_timeout_s: 120, max_concurrent: 3, daily_limit: 100, realtime_minutes_daily: 30, realtime_max_concurrent: 2 })),
  /** who does the speech in AI calls: the visitor's browser (free, the default) or the optional realtime engine (OpenAI, needs OPENAI_API_KEY and a model on the server; falls back to the browser when unavailable) */
  ai_engine: z.enum(["browser", "realtime"]).default("browser"),
  /** how long a call rings before it counts as missed */
  ring_seconds: z.number().int().min(15).max(120).default(45),
  /** where relay (TURN) credentials come from: none = STUN only (calls fail behind strict NATs), static = the server's TURN_URLS and TURN_SECRET, twilio = the workspace's own Twilio account */
  turn_provider: z.enum(["none", "static", "twilio"]).default("none"),
});
export type CallSettings = z.infer<typeof CallSettingsSchema>;
/** A patch names only what changes: `.partial()` of the schema above would put the defaults back for everything it leaves out. */
export const CallsPatchSchema = z.object({
  browser: z.object({ enabled: z.boolean(), voice: z.boolean(), video: z.boolean(), screen_share: z.boolean() }).partial().optional(),
  ring_seconds: z.number().int().min(15).max(120).optional(),
  turn_provider: z.enum(["none", "static", "twilio"]).optional(),
  ai: z
    .object({
      enabled: z.boolean(),
      voice: z.boolean(),
      video: z.boolean(),
      max_duration_s: z.number().int().min(60).max(1800),
      idle_timeout_s: z.number().int().min(30).max(600),
      max_concurrent: z.number().int().min(1).max(20),
      daily_limit: z.number().int().min(1).max(1000),
      realtime_minutes_daily: z.number().int().min(1).max(1000),
      realtime_max_concurrent: z.number().int().min(1).max(10),
    })
    .partial()
    .optional(),
  ai_engine: z.enum(["browser", "realtime"]).optional(),
  phone: z
    .object({
      enabled: z.boolean(),
      caller_id: z.string().regex(/^\+[1-9]\d{6,14}$/).nullable(),
      daily_limit: z.number().int().min(1).max(1000),
      allowed_countries: z.array(z.string().length(2).toUpperCase()).max(60),
      max_duration_s: z.number().int().min(60).max(7200),
      quiet_hours: z.object({ enabled: z.boolean(), start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).partial(),
    })
    .partial()
    .optional(),
});

const WidgetShape = z.object({
  title: z.string().max(80).default("Chat with us"),
  intro: z.string().max(240).default("We usually reply within a few minutes."),
  primary_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#4f46e5"),
  text_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#ffffff"),
  logo_url: z.string().url().max(500).nullable().default(null),
  launcher_position: z.enum(["left", "right"]).default("right"),
  launcher_spacing: z.number().int().min(0).max(200).default(20),
  /** bubble = round icon button, pill = icon + label, icon = rounded-square icon button */
  launcher_style: z.enum(["bubble", "pill", "icon"]).default("bubble"),
  launcher_label: z.string().max(24).default("Chat with us"),
  /** corner radius of the chat panel in px (message bubbles and controls scale from it) */
  radius: z.number().int().min(0).max(24).default(16),
  sound: z.boolean().default(true),
  welcome_message: z.string().max(500).default("Hi there! How can we help you today?"),
  away_message: z.string().max(500).default("We're currently away. Leave a message and we'll get back to you."),
  required_info: z.array(RequiredInfoSchema).default([]),
  chat_type: z.enum(["live_chat", "sms"]).default("live_chat"),
  office_hours: OfficeHoursSchema.default(() => OfficeHoursSchema.parse({})),
  default_inbox_id: z.string().nullable().default(null),
  /** ask the visitor which department they need before the conversation starts (departments marked visible in the widget) */
  department_selector: z.boolean().default(false),
  /** what the widget asks visitors, and when (docs/AI-AGENTS.md section 4) */
  visitor_info: VisitorInfoSchema.default(() => VisitorInfoSchema.parse({})),
});

export const WidgetSettingsSchema = WidgetShape;

export const WorkspaceSettingsSchema = z.object({
  default_region: z.string().length(2).toUpperCase().default("US"),
  edit_window_seconds: z.number().int().min(0).max(86400).default(900),
  /** messages older than this are archived to object storage and removed (0 = keep forever) */
  retention_days: z.number().int().min(0).max(3650).default(0),
  /** team chat messages older than this are deleted (0 = keep forever; pinned messages are kept) */
  team_retention_days: z.number().int().min(0).max(3650).default(0),
  credits_enforced: z.boolean().default(false),
  ai_triage_enabled: z.boolean().default(false),
  ai_autoresponder_enabled: z.boolean().default(false),
  ai_redact_pii: z.boolean().default(false),
  ai_tone: z.enum(["friendly", "professional", "concise", "empathetic"]).default("friendly"),
  tickets: TicketSettingsSchema.default(() => TicketSettingsSchema.parse({})),
  routing: RoutingSettingsSchema.default(() => RoutingSettingsSchema.parse({})),
  calls: CallSettingsSchema.default(() => CallSettingsSchema.parse({})),
  widget: WidgetShape.default(() => WidgetShape.parse({})),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
export type WidgetSettings = z.infer<typeof WidgetShape>;
export type OfficeHours = z.infer<typeof OfficeHoursSchema>;

/**
 * The patch form of an object schema: every field optional and NO default applied for a field that is left out. (`.partial()` alone keeps the
 * defaults inside, so a patch that named one widget field would put every other field back to its default.)
 */
function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, f] of Object.entries(schema.shape)) shape[k] = (f instanceof z.ZodDefault ? (f as z.ZodDefault<z.ZodType>).removeDefault() : (f as z.ZodType)).optional();
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<z.ZodType<z.output<T[K]>>> }>;
}

export const WorkspaceSettingsPatchSchema = z.object({
  default_region: WorkspaceSettingsSchema.shape.default_region.optional(),
  edit_window_seconds: WorkspaceSettingsSchema.shape.edit_window_seconds.optional(),
  retention_days: WorkspaceSettingsSchema.shape.retention_days.optional(),
  team_retention_days: WorkspaceSettingsSchema.shape.team_retention_days.optional(),
  credits_enforced: z.boolean().optional(),
  ai_triage_enabled: z.boolean().optional(),
  ai_autoresponder_enabled: z.boolean().optional(),
  ai_redact_pii: z.boolean().optional(),
  ai_tone: WorkspaceSettingsSchema.shape.ai_tone.optional(),
  tickets: patchOf(TicketSettingsSchema).optional(),
  routing: patchOf(RoutingSettingsSchema).optional(),
  calls: CallsPatchSchema.optional(),
  widget: patchOf(WidgetShape).optional(),
});

export function parseSettings(raw: string | null | undefined): WorkspaceSettings {
  let obj: unknown = {};
  try {
    obj = raw ? JSON.parse(raw) : {};
  } catch {
    obj = {};
  }
  const r = WorkspaceSettingsSchema.safeParse(obj);
  return r.success ? r.data : WorkspaceSettingsSchema.parse({});
}

export function mergeSettings(cur: WorkspaceSettings, patch: z.infer<typeof WorkspaceSettingsPatchSchema>): WorkspaceSettings {
  const { widget, tickets, routing, calls, ...rest } = patch;
  return WorkspaceSettingsSchema.parse({
    ...cur,
    ...rest,
    tickets: { ...cur.tickets, ...(tickets ?? {}) },
    routing: { ...cur.routing, ...(routing ?? {}) },
    calls: { ...cur.calls, ...(calls ?? {}), browser: { ...cur.calls.browser, ...(calls?.browser ?? {}) }, ai: { ...cur.calls.ai, ...(calls?.ai ?? {}) }, phone: { ...cur.calls.phone, ...(calls?.phone ?? {}), quiet_hours: { ...cur.calls.phone.quiet_hours, ...(calls?.phone?.quiet_hours ?? {}) } } },
    widget: { ...cur.widget, ...(widget ?? {}) },
  });
}

/** Public subset exposed to anonymous visitors. */
export function publicWidgetConfig(w: WidgetSettings) {
  const { default_inbox_id: _drop, ...pub } = w;
  return pub;
}
