import { z } from "zod";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { DepartmentInfoSchema, type VisitorInfoSettings } from "../domain/settings.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { normalizeEmail, normalizePhone } from "../util/phone.js";
import { findByEmail, findByPhone, getContact, patchContact, type ContactRow } from "./contacts.js";
import { emitInserted, emitMessage, insertMessage, postSystemMessage, type MessageRow } from "./messageStore.js";
import { getRoomRow, type RoomRow } from "./roomStore.js";
import { liveTicketOf, recordTicketEvent, type TicketRow } from "./tickets.js";
import type { SessionRow } from "./visitors.js";
import { getVisitorRoom, visitorSend } from "./visitorChat.js";
import { getSettings } from "./workspaces.js";
import { recordAudit } from "./audit.js";

/**
 * Visitor details captured in the conversation (docs/AI-AGENTS.md section 4). The workspace (and, per department, an override) decides which of
 * name, email, phone and a few custom fields are asked, and at which moment. A moment asks with a structured form card in the thread, never by
 * reading free text: the server validates every value, stores it on the contact and never asks for something it already knows.
 */

export type Moment = "handoff" | "no_agent" | "callback" | "after" | "agent";
export interface CardField {
  key: string;
  label: string;
  type: "text" | "email" | "tel" | "select" | "checkbox";
  required: boolean;
  options?: string[];
  /** a value the contact already has, shown for confirmation (the phone number a visitor is asked to agree to be called on) */
  prefill?: string;
}
export interface ContactFormCard {
  type: "contact_form";
  id: string;
  moment: Moment;
  fields: CardField[];
  skippable: boolean;
  consent: { text: string; privacy_url: string | null } | null;
  answered?: "submitted" | "skipped";
}

const BASE_LABELS = { name: "Your name", email: "Email", phone: "Phone number" } as const;
const BASE_TYPES = { name: "text", email: "email", phone: "tel" } as const;
const PROMPTS: Record<Moment, string> = {
  handoff: "So our team can follow up, could you share your contact details?",
  no_agent: "Nobody is available right now. Leave your details and we will get back to you.",
  callback: "What number can we reach you on?",
  after: "Want us to follow up? Leave your email.",
  agent: "Could you share a few details so we can help?",
};

/** The workspace's settings with the department's overrides on top. */
export async function effectiveInfo(ctx: AppContext, ws: string, departmentId: string | null): Promise<VisitorInfoSettings> {
  const base = (await getSettings(ctx, ws)).widget.visitor_info;
  if (!departmentId) return base;
  const row = await ctx.db.get<{ visitor_info: string }>("SELECT visitor_info FROM inboxes WHERE id = ? AND workspace_id = ?", departmentId, ws);
  const o = DepartmentInfoSchema.safeParse(parseJson<unknown>(row?.visitor_info ?? "{}", {}));
  if (!o.success) return base;
  const cf = o.data.custom_fields ?? {};
  return {
    ...base,
    fields: { ...base.fields, ...(o.data.fields ?? {}) },
    custom_fields: base.custom_fields.map((f) => (cf[f.key] ? { ...f, mode: cf[f.key]! } : f)),
    moments: { ...base.moments, ...(o.data.moments ?? {}) },
    // the department's own consent wording (a different legal entity, a different privacy policy) wins over the workspace's
    consent: { ...base.consent, ...Object.fromEntries(Object.entries(o.data.consent ?? {}).filter(([, v]) => v !== undefined)) },
  };
}

const knownName = (c: Pick<ContactRow, "name">) => !!c.name.trim() && c.name.trim() !== "Visitor";

/** The pieces of information the contact lacks and the settings ask for. `only` limits it to what a tool asked for. */
export function fieldsToAsk(info: VisitorInfoSettings, contact: ContactRow, moment: Moment, only?: string[]): CardField[] {
  const attrs = parseJson<Record<string, unknown>>(contact.attrs, {});
  const out: CardField[] = [];
  const consider = (key: string, mode: string) => {
    // a callback needs a number, whatever the workspace says about asking for phone numbers in general
    if (moment === "callback" && key === "phone") mode = "required";
    if (mode === "off") return;
    if (only && !only.includes(key)) return;
    if (moment === "after" && key !== "email") return;
    if (moment === "callback" && key !== "phone" && !only) return;
    out.push({ key, label: "", type: "text", required: moment === "callback" && key === "phone" ? true : mode === "required" });
  };
  for (const k of ["name", "email", "phone"] as const) {
    const known = k === "name" ? knownName(contact) : !!contact[k];
    if (known) continue;
    consider(k, info.fields[k]);
    const f = out[out.length - 1];
    if (f && f.key === k) ((f.label = BASE_LABELS[k]), (f.type = BASE_TYPES[k]));
  }
  if (moment !== "after" && moment !== "callback") {
    for (const c of info.custom_fields) {
      if (attrs[c.key] !== undefined && attrs[c.key] !== "") continue;
      // shown in the pre-chat form already (required or optional there): not asked a second time
      if (attrs.prechat_at && (c.mode === "required" || c.mode === "optional")) continue;
      const before = out.length;
      consider(c.key, c.mode);
      if (out.length > before) Object.assign(out[out.length - 1]!, { label: c.label, type: c.type, options: c.type === "select" ? c.options : undefined });
    }
  }
  // a callback needs the visitor's agreement to be called on the number we hold: confirm it even when it is already known
  if (moment === "callback" && !out.some((f) => f.key === "phone") && contact.phone && !parseJson<{ call_consent?: { phone?: string } }>(contact.attrs, {}).call_consent?.phone) {
    out.unshift({ key: "phone", label: BASE_LABELS.phone, type: "tel", required: true, prefill: contact.phone });
  }
  return out.filter((f) => f.label);
}

async function botLine(ctx: AppContext, room: RoomRow, text: string, meta: Record<string, unknown>): Promise<MessageRow> {
  const r = await insertMessage(ctx, { workspaceId: room.workspace_id, roomId: room.id, senderType: "bot", senderName: "Support assistant", kind: "text", source: "dm", content: text, contentText: text, meta });
  await emitInserted(ctx, r);
  return r.message;
}

/**
 * Put a form card in the thread if the settings ask for it at this moment and the contact lacks something. At most once per moment per ticket
 * (`tickets.meta.info_asked`), so a visitor is never asked twice for the same thing and a repeated handoff does not repeat the card.
 */
export async function requestVisitorInfo(ctx: AppContext, ticketId: string, moment: Moment, opts: { only?: string[]; text?: string; force?: boolean } = {}): Promise<MessageRow | null> {
  const ticket = await ctx.db.get<TicketRow>("SELECT * FROM tickets WHERE id = ?", ticketId);
  if (!ticket) return null;
  if (moment !== "after" && (ticket.status === "resolved" || ticket.status === "closed")) return null;
  const meta = parseJson<{ info_asked?: string[] }>(ticket.meta, {});
  if ((meta.info_asked ?? []).includes(moment) && !opts.force) return null;
  const info = await effectiveInfo(ctx, ticket.workspace_id, ticket.department_id);
  if (moment !== "agent" && !info.moments[moment]) return null;
  const contact = await getContact(ctx, ticket.workspace_id, ticket.contact_id);
  const fields = fieldsToAsk(info, contact, moment, opts.only);
  if (!fields.length) return null;
  // claim the moment first: two concurrent callers send one card
  const asked = [...new Set([...(meta.info_asked ?? []), moment])];
  const claimed = await ctx.db.run("UPDATE tickets SET meta = ? WHERE id = ? AND meta = ?", JSON.stringify({ ...meta, info_asked: asked }), ticket.id, ticket.meta);
  if (!claimed.changes) return null;
  const room = await getRoomRow(ctx, ticket.workspace_id, ticket.room_id);
  // a callback always asks to be called on that number, in words that say so, whatever the workspace's general consent setting is
  const askConsent = moment === "callback" ? fields.some((f) => f.key === "phone") : info.consent.enabled && fields.some((f) => f.key !== "name");
  const consentText = moment === "callback" ? "I agree that you may call me on this number." : info.consent.text;
  const card: ContactFormCard = {
    type: "contact_form",
    id: newId("frm"),
    moment,
    fields,
    skippable: !fields.some((f) => f.required),
    consent: askConsent ? { text: consentText, privacy_url: info.consent.privacy_url } : null,
  };
  const msg = await botLine(ctx, room, opts.text ?? PROMPTS[moment], { card, sub_type: "contact_form" });
  await recordTicketEvent(ctx, ticket, "info_requested", { type: "system" }, { moment, fields: fields.map((f) => f.key) });
  return msg;
}

/* ---------- the visitor answers ---------- */

export const FormSubmission = z.object({
  values: z.record(z.string().max(60), z.string().max(300)).default({}),
  consent: z.boolean().default(false),
  /** ISO 3166 region the visitor picked for the phone number (default: the workspace's region) */
  country: z.string().length(2).toUpperCase().optional(),
  /** the visitor's IANA time zone (their browser's): quiet hours for phone calls are judged in it */
  timezone: z.string().max(64).optional(),
  /** honeypot: a real visitor never sees or fills this */
  website: z.string().max(300).optional(),
});

const NAME_RE = /^[\p{L}\p{M}0-9 .,'’()-]{1,100}$/u;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f<>]/;

/** One value of a form (in the thread or the pre-chat form), validated on the server; the same rules for both. */
export function validate(f: Pick<CardField, "key" | "type" | "required" | "options">, raw: string, region: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.trim();
  if (f.type === "checkbox") {
    const on = /^(yes|true|on|1)$/i.test(v);
    if (f.required && !on) return { ok: false, error: "Please tick this box" };
    return { ok: true, value: v === "" && !f.required ? "" : on ? "yes" : "no" };
  }
  if (!v) return f.required ? { ok: false, error: "This is required" } : { ok: true, value: "" };
  if (f.key === "name") return NAME_RE.test(v) ? { ok: true, value: v } : { ok: false, error: "Use letters, numbers and spaces only (up to 100 characters)" };
  if (f.key === "email") {
    const e = normalizeEmail(v)!;
    return e.length <= 254 && EMAIL_RE.test(e) ? { ok: true, value: e } : { ok: false, error: "Enter a valid email address" };
  }
  if (f.key === "phone") {
    const p = normalizePhone(v, region);
    return p ? { ok: true, value: p } : { ok: false, error: "Enter a valid phone number" };
  }
  if (f.type === "select") return f.options?.includes(v) ? { ok: true, value: v } : { ok: false, error: "Choose one of the options" };
  return v.length <= 200 && !CONTROL_RE.test(v) ? { ok: true, value: v } : { ok: false, error: "Use plain text (up to 200 characters)" };
}

async function findCard(ctx: AppContext, room: RoomRow, messageId: string) {
  const m = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND room_id = ? AND deleted_at IS NULL", messageId, room.id);
  const meta = m ? parseJson<Record<string, unknown> & { card?: ContactFormCard }>(m.meta, {}) : null;
  if (!m || m.sender_type !== "bot" || meta?.card?.type !== "contact_form") throw notFound("Form");
  return { m, meta: meta!, card: meta!.card! };
}

/** Close the card with a compare-and-set, so a double submit (or a retry) stores once and the second gets 409. */
async function closeCard(ctx: AppContext, room: RoomRow, m: MessageRow, meta: Record<string, unknown>, card: ContactFormCard, how: "submitted" | "skipped") {
  const r = await ctx.db.run("UPDATE messages SET meta = ? WHERE room_id = ? AND id = ? AND meta = ?", JSON.stringify({ ...meta, card: { ...card, answered: how } }), room.id, m.id, m.meta);
  if (!r.changes) throw new AppError(409, "ALREADY_ANSWERED", "This form was already answered");
  const fresh = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ? AND room_id = ?", m.id, room.id);
  await emitMessage(ctx, await getRoomRow(ctx, room.workspace_id, room.id), fresh!, "message:updated");
}

export async function submitContactForm(ctx: AppContext, session: SessionRow, roomId: string, messageId: string, input: z.infer<typeof FormSubmission>) {
  const room = await getVisitorRoom(ctx, session, roomId);
  const { m, meta, card } = await findCard(ctx, room, messageId);
  if (card.answered) throw new AppError(409, "ALREADY_ANSWERED", "This form was already answered");
  // a bot filled it in: pretend it worked and store nothing (no signal to tune against)
  if (input.website?.trim()) return { ok: true as const, saved: [] as string[] };
  const region = input.country ?? (await getSettings(ctx, room.workspace_id)).default_region;
  const errors: Record<string, string> = {};
  const clean: Record<string, string> = {};
  for (const f of card.fields) {
    const r = validate(f, input.values[f.key] ?? "", region);
    if (!r.ok) errors[f.key] = r.error;
    else if (r.value) clean[f.key] = r.value;
  }
  for (const k of Object.keys(input.values)) if (!card.fields.some((f) => f.key === k)) errors[k] = "Not asked";
  if (card.consent && Object.keys(clean).some((k) => k !== "name") && !input.consent) errors.consent = "Please agree to continue";
  if (Object.keys(errors).length) throw unprocessable("INVALID_FORM", "Some details need another look", { errors });
  await closeCard(ctx, room, m, meta, card, "submitted");

  const contact = await getContact(ctx, room.workspace_id, room.contact_id);
  const saved = await applyToContact(ctx, contact, card, clean, input.consent, nowIso(ctx), validZone(input.timezone));
  await recordAudit(ctx, { workspaceId: room.workspace_id, actor: { type: "system" }, action: "contact.info_submitted", target: contact.id, detail: { moment: card.moment, fields: saved } });
  const label = saved.length ? saved.join(", ") : "nothing";
  await visitorSend(ctx, session, room.id, { content: `Shared my details: ${label}`, client_msg_id: `form-${m.id.slice(-24)}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) }, { meta: { form_submission: { message_id: m.id, fields: saved } } });
  const ticket = await liveTicketOf(ctx, room.id);
  if (ticket) {
    await recordTicketEvent(ctx, ticket, "info_submitted", { type: "contact" }, { moment: card.moment, fields: saved });
    if (card.moment === "callback") await recordTicketEvent(ctx, ticket, "callback_requested", { type: "contact" }, {});
    const lines = [`The visitor shared: ${label}.`, card.moment === "callback" && clean.phone ? "They asked to be called back on the phone number of the contact." : null].filter(Boolean);
    await postSystemMessage(ctx, room.id, room.workspace_id, lines.join(" "), { sub_type: "info_submitted", moment: card.moment });
  }
  // an address given after the ticket was resolved, with consent: the automatic copy can go now (when the workspace sends one)
  if (card.moment === "after" && m.ticket_id && saved.includes("email")) {
    const tid = m.ticket_id;
    ctx.background.run(async () => (await import("./transcripts.js")).maybeSendAfterResolve(ctx, tid));
  }
  return { ok: true as const, saved };
}

export async function skipContactForm(ctx: AppContext, session: SessionRow, roomId: string, messageId: string) {
  const room = await getVisitorRoom(ctx, session, roomId);
  const { m, meta, card } = await findCard(ctx, room, messageId);
  if (card.answered) throw new AppError(409, "ALREADY_ANSWERED", "This form was already answered");
  if (!card.skippable) throw unprocessable("NOT_SKIPPABLE", "This information is needed");
  await closeCard(ctx, room, m, meta, card, "skipped");
  return { ok: true as const };
}

/**
 * Store what was submitted. Email and phone are linked to the contact only when no OTHER contact has them: an anonymous visitor who types an
 * address that belongs to someone else does not get that person's history (and learns nothing about whether it exists); the value is kept on the
 * visitor's own contact as `unverified_email` / `unverified_phone` for the team, and merging stays with the existing identity checks (OTP).
 */
const validZone = (z: string | undefined): string | null => {
  if (!z) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return z;
  } catch {
    return null;
  }
};

async function applyToContact(ctx: AppContext, contact: ContactRow, card: ContactFormCard, values: Record<string, string>, consent: boolean, now: string, timezone: string | null): Promise<string[]> {
  const saved: string[] = [];
  const attrs: Record<string, unknown> = {};
  const patch: { name?: string; email?: string; phone?: string } = {};
  if (values.name && !knownName(contact)) (patch.name = values.name, saved.push("name"));
  if (values.email && !contact.email) {
    const other = await findByEmail(ctx, contact.workspace_id, values.email);
    if (other && other.id !== contact.id) (attrs.unverified_email = values.email, saved.push("email"));
    else (patch.email = values.email, saved.push("email"));
  }
  if (values.phone && !contact.phone) {
    const other = await findByPhone(ctx, contact.workspace_id, values.phone);
    if (other && other.id !== contact.id) (attrs.unverified_phone = values.phone, saved.push("phone"));
    else {
      patch.phone = values.phone;
      saved.push("phone");
      // agreeing to be called is recorded with the number it was given for: a call goes only to a number with a matching agreement
      if (consent && card.consent && card.moment === "callback") attrs.call_consent = { at: now, phone: values.phone, text: card.consent.text };
    }
  } else if (values.phone && contact.phone === values.phone && consent && card.consent && card.moment === "callback") {
    attrs.call_consent = { at: now, phone: contact.phone, text: card.consent.text };
    saved.push("call consent");
  } else if (values.phone && contact.phone && contact.phone !== values.phone) attrs.unverified_phone = values.phone;
  if (timezone) attrs.timezone = timezone;
  for (const f of card.fields) if (!["name", "email", "phone"].includes(f.key) && values[f.key]) (attrs[f.key] = values[f.key], saved.push(f.label));
  // which address the consent came with: only an address given in THIS form (and so linked to this contact) counts as confirmed for a copy by email
  if (consent && card.consent) attrs.contact_consent = { at: now, text: card.consent.text, email: patch.email ?? null };
  if (!Object.keys(patch).length && !Object.keys(attrs).length) return saved;
  try {
    await patchContact(ctx, contact.workspace_id, contact.id, { ...patch, attrs });
  } catch (e) {
    // somebody else took the address between the check and the write: keep it unverified rather than fail the visitor
    if (!(e instanceof AppError) || e.code !== "CONTACT_EXISTS") throw e;
    const rest: Record<string, unknown> = { ...attrs };
    if (patch.email) rest.unverified_email = patch.email;
    if (patch.phone) rest.unverified_phone = patch.phone;
    await patchContact(ctx, contact.workspace_id, contact.id, { name: patch.name, attrs: rest });
  }
  return saved;
}
