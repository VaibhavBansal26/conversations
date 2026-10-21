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
  widget: WidgetShape.default(() => WidgetShape.parse({})),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
export type WidgetSettings = z.infer<typeof WidgetShape>;
export type OfficeHours = z.infer<typeof OfficeHoursSchema>;

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
  tickets: TicketSettingsSchema.partial().optional(),
  widget: WidgetShape.partial().optional(),
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
  const { widget, tickets, ...rest } = patch;
  return WorkspaceSettingsSchema.parse({
    ...cur,
    ...rest,
    tickets: { ...cur.tickets, ...(tickets ?? {}) },
    widget: { ...cur.widget, ...(widget ?? {}) },
  });
}

/** Public subset exposed to anonymous visitors. */
export function publicWidgetConfig(w: WidgetSettings) {
  const { default_inbox_id: _drop, ...pub } = w;
  return pub;
}
