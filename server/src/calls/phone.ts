import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import type { Actor } from "../domain/types.js";
import { AppError, unprocessable } from "../errors.js";
import { ProviderError } from "../providers/types.js";
import type { ConnectionRow } from "../providers/registry.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { normalizePhone } from "../util/phone.js";
import { recordAudit } from "../services/audit.js";
import { getContact } from "../services/contacts.js";
import { getRoomRow, getVisibleRoom } from "../services/roomStore.js";
import { liveTicketOf, recordTicketEvent } from "../services/tickets.js";
import { requestVisitorInfo } from "../services/visitorInfo.js";
import { claimEvent } from "../webhooks/signatures.js";
import { getSettings } from "../services/workspaces.js";
import { callDto, callSettings, finishPhone, postCardFor, publish, stepCall, type CallRow } from "./service.js";
import { IllegalTransition, type CallEvent } from "./machine.js";

/**
 * Phone calls: click-to-call through the workspace's OWN Twilio account (docs/CALLS.md, Phone calls). The app asks Twilio to ring the agent's
 * phone; when the agent answers, Twilio asks us for instructions (TwiML) and we dial the visitor's number from the workspace's caller ID.
 * Progress comes back as status callbacks, verified with the workspace's auth token. The visitor's number always comes from their contact (never
 * from a request), and only after they agreed, on that number, to be called.
 */

const BLOCKED_TYPES = new Set(["PREMIUM_RATE", "SHARED_COST", "UAN", "PERSONAL_NUMBER", "PAGER", "VOICEMAIL"]);
const PHONE_MAX_RING_S = 45;
const PHONE_CONNECT_S = 90;
const last4 = (n: string) => n.slice(-4);

export interface PhoneReadiness {
  enabled: boolean;
  ready: boolean;
  caller_id: string | null;
  allowed_countries: string[];
  /** what still has to be done before the first call, in plain words */
  problems: string[];
}

async function twilioRow(ctx: AppContext, ws: string): Promise<ConnectionRow | null> {
  const row = await ctx.providers.connection(ws, "sms");
  return row && row.provider === "twilio" && row.status === "verified" ? row : null;
}

/** The caller ID must be a number the workspace imported from its own Twilio account: nobody can show a number they do not own. */
export async function assertCallerId(ctx: AppContext, ws: string, e164: string | null | undefined): Promise<void> {
  if (e164 && !(await ctx.db.get("SELECT 1 FROM sms_numbers WHERE workspace_id = ? AND e164 = ?", ws, e164))) throw unprocessable("UNKNOWN_CALLER_ID", "The caller ID must be one of the numbers imported under SMS & email");
}

export async function phoneReadiness(ctx: AppContext, ws: string): Promise<PhoneReadiness> {
  const p = (await callSettings(ctx, ws)).phone;
  const problems: string[] = [];
  if (!(await twilioRow(ctx, ws))) problems.push("Connect and verify your own Twilio account under SMS & email: phone calls use it, never a shared account.");
  if (!p.caller_id) problems.push("Choose the caller ID: one of your imported Twilio numbers.");
  if (!p.allowed_countries.length) problems.push("Choose the countries that may be called. Nothing is called until you do.");
  return { enabled: p.enabled, ready: p.enabled && problems.length === 0, caller_id: p.caller_id, allowed_countries: p.allowed_countries, problems };
}

/** Local minutes since midnight in a time zone. */
function minutesIn(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((x) => x.type === "hour")!.value) * 60 + Number(parts.find((x) => x.type === "minute")!.value);
}
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export function inQuietHours(zone: string, at: Date, start: string, end: string): boolean {
  const m = minutesIn(zone, at);
  const a = hm(start);
  const b = hm(end);
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
}

/** Everything that may stop a call, in order, each with its own code and a sentence a person can act on. */
async function guards(ctx: AppContext, actor: Actor, room: { id: string; workspace_id: string; contact_id: string }, agentPhone: string) {
  const ws = room.workspace_id;
  const s = (await callSettings(ctx, ws)).phone;
  if (!s.enabled) throw new AppError(403, "PHONE_CALLS_DISABLED", "Phone calls are switched off for this workspace");
  const conn = await twilioRow(ctx, ws);
  if (!conn) throw new AppError(409, "NO_TWILIO", "Phone calls need your own verified Twilio account (Settings > SMS & email)");
  if (!s.caller_id) throw new AppError(409, "NO_CALLER_ID", "Choose a caller ID in Settings > Calls first");
  const contact = await getContact(ctx, ws, room.contact_id);
  if (!contact.phone) throw new AppError(409, "CONTACT_NO_PHONE", "This contact has no phone number yet: ask for one with the callback form");
  const consent = parseJson<{ call_consent?: { phone?: string; at?: string } }>(contact.attrs, {}).call_consent;
  if (!consent || consent.phone !== contact.phone) throw new AppError(409, "NO_CALL_CONSENT", "The contact has not agreed to be called on this number yet: ask them with the callback form");
  if (contact.sms_opt_out || contact.unsubscribed) throw new AppError(409, "DO_NOT_CALL", "This contact opted out (STOP or unsubscribed): they are not called");
  const parsed = parsePhoneNumberFromString(contact.phone);
  const type = parsed?.getType();
  if (!parsed || !parsed.isValid()) throw unprocessable("INVALID_NUMBER", "The contact's phone number is not valid");
  if (type && BLOCKED_TYPES.has(type)) throw unprocessable("DESTINATION_BLOCKED", "Premium-rate, shared-cost and similar numbers are never called");
  if (!parsed.country || !s.allowed_countries.includes(parsed.country)) throw unprocessable("DESTINATION_BLOCKED", `Calls to ${parsed.country ?? "this country"} are not allowed in Settings > Calls`);
  const wsSettings = await getSettings(ctx, ws);
  const zone = parseJson<{ timezone?: string }>(contact.attrs, {}).timezone ?? wsSettings.widget.office_hours.timezone ?? "UTC";
  if (s.quiet_hours.enabled && inQuietHours(zone, ctx.clock(), s.quiet_hours.start, s.quiet_hours.end)) {
    throw new AppError(409, "QUIET_HOURS", `It is night for the visitor (${zone}): calls are not placed between ${s.quiet_hours.start} and ${s.quiet_hours.end}`, { zone });
  }
  const agent = normalizePhone(agentPhone, wsSettings.default_region);
  if (!agent) throw unprocessable("INVALID_AGENT_PHONE", "Enter your own phone number, with the country code");
  if (agent === contact.phone) throw unprocessable("INVALID_AGENT_PHONE", "Your number and the contact's number are the same");
  const rate = await ctx.ratelimit.check("calls.phone.agent", { key: `${ws}:${actor.memberId}`, workspaceId: ws });
  if (!rate.allowed) throw new RateLimitedError(rate);
  return { s, conn, contact, visitorPhone: contact.phone, agentPhone: agent, country: parsed.country };
}

const publicBase = (ctx: AppContext) => ctx.config.PUBLIC_URL.replace(/\/$/, "");
const hook = (ctx: AppContext, conn: ConnectionRow, path: string, callId: string, extra = "") => `${publicBase(ctx)}/webhooks/c/${conn.webhook_id}/twilio/voice/${path}?call=${encodeURIComponent(callId)}${extra}`;

/** Place the call: guards, a row (the spend guard), then Twilio rings the agent. */
export async function placePhoneCall(ctx: AppContext, actor: Actor, roomId: string, input: { agent_phone: string }) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket) throw new AppError(409, "NO_CONVERSATION", "The visitor has not written yet");
  const g = await guards(ctx, actor, room, input.agent_phone);
  const id = newId("call");
  const now = nowIso(ctx);
  const meta = { agent_last4: last4(g.agentPhone), visitor_last4: last4(g.visitorPhone), caller_id: g.s.caller_id, country: g.country, agent_phone: undefined };
  try {
    await ctx.db.run(
      "INSERT INTO calls(id, workspace_id, room_id, ticket_id, contact_id, transport, kind, state, initiated_by, created_at, updated_at, meta) VALUES (?,?,?,?,?,'phone','voice','ringing',?,?,?,?)",
      id,
      room.workspace_id,
      room.id,
      ticket.id,
      room.contact_id,
      actor.memberId,
      now,
      now,
      JSON.stringify(meta),
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CALL_IN_PROGRESS", "There is already a call in this conversation");
    throw e;
  }
  // the spend guard: count the calls of this workspace today up to and including this one; an attempt over the limit is refused and does not count
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const n = Number(
    (await ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM calls WHERE workspace_id = ? AND transport = 'phone' AND created_at >= ? AND (created_at < ? OR (created_at = ? AND id <= ?)) AND (end_reason IS NULL OR end_reason NOT LIKE 'guard:%')",
      room.workspace_id,
      dayStart,
      now,
      now,
      id,
    ))!.n,
  );
  if (n > g.s.daily_limit) {
    await ctx.db.run("UPDATE calls SET state = 'failed', ended_at = ?, end_reason = 'guard:daily_limit', ended_by = 'system', updated_at = ? WHERE id = ?", now, now, id);
    throw new AppError(429, "DAILY_LIMIT", `This workspace reached its limit of ${g.s.daily_limit} phone calls today`, { limit: g.s.daily_limit });
  }
  let row = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", id))!;
  const messageId = await postCardFor(ctx, await getRoomRow(ctx, room.workspace_id, room.id), row);
  await ctx.db.run("UPDATE calls SET message_id = ? WHERE id = ?", messageId, id);
  try {
    const twilio = ctx.providers.twilioFor(g.conn);
    const created = await twilio.createCall({ to: g.agentPhone, from: g.s.caller_id!, url: hook(ctx, g.conn, "connect", id), statusCallback: hook(ctx, g.conn, "status", id, "&leg=agent"), timeoutS: PHONE_MAX_RING_S - 15, idempotencyKey: id });
    await ctx.db.run("UPDATE calls SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, agent_call_sid: created.sid, visitor_phone: g.visitorPhone }), id);
  } catch (e) {
    ctx.log.warn("phone call could not be placed", { workspace_id: room.workspace_id, call_id: id, error: e instanceof Error ? e.message : String(e) });
    row = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", id))!;
    await finishPhone(ctx, row, "fail", { ended_by: "system", end_reason: "provider_error" });
    const why = e instanceof ProviderError ? e.hint ?? e.message : "Twilio did not answer";
    throw new AppError(502, "PROVIDER_ERROR", `Twilio could not place the call: ${why}`);
  }
  await recordTicketEvent(ctx, ticket, "call_started", { type: "member", id: actor.memberId }, { call_id: id, kind: "phone", visitor_last4: last4(g.visitorPhone) });
  await recordAudit(ctx, { workspaceId: room.workspace_id, actor: { type: "member", id: actor.memberId }, action: "call.invited", target: id, detail: { room_id: room.id, transport: "phone", country: g.country, visitor_last4: last4(g.visitorPhone) } });
  row = (await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ?", id))!;
  await publish(ctx, row);
  return { call: callDto(row) };
}

/** Ask the visitor, in the thread, to agree to be called on their number (and to give it when we have none). */
export async function requestCallConsent(ctx: AppContext, actor: Actor, roomId: string) {
  const room = await getVisibleRoom(ctx, actor, roomId);
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket) throw new AppError(409, "NO_CONVERSATION", "The visitor has not written yet");
  const m = await requestVisitorInfo(ctx, ticket.id, "callback", { force: true, text: "May we call you? Please confirm your number and agree below." });
  return { asked: !!m };
}

/** The agent hangs up (or cancels while their own phone rings): ends the agent's leg; Twilio ends the bridge. */
export async function hangupPhoneCall(ctx: AppContext, actor: Actor, callId: string) {
  const c = await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ? AND workspace_id = ?", callId, actor.workspaceId);
  if (!c || c.transport !== "phone") throw new AppError(404, "NOT_FOUND", "Call not found");
  if (c.initiated_by !== actor.memberId) throw new AppError(403, "NOT_YOUR_CALL", "Only the person who placed the call can control it");
  const meta = parseJson<{ agent_call_sid?: string }>(c.meta, {});
  const conn = await twilioRow(ctx, c.workspace_id);
  try {
    if (conn && meta.agent_call_sid) await ctx.providers.twilioFor(conn).endCall(meta.agent_call_sid);
  } catch (e) {
    throw new AppError(502, "PROVIDER_ERROR", `Twilio could not end the call: ${e instanceof ProviderError ? e.hint ?? e.message : "no answer"}`);
  }
  const event: CallEvent = c.state === "ringing" ? "cancel" : "end";
  const row = await finishPhone(ctx, c, event, { ended_by: "agent", end_reason: c.state === "ringing" ? "cancelled" : "completed" });
  return { call: callDto(row ?? c) };
}

/* ---------- Twilio webhooks (verified by the route with the workspace's auth token) ---------- */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const hangup = (say: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(say)}</Say><Hangup/></Response>`;

/** The agent answered their phone: connect them to the visitor. */
export async function voiceConnect(ctx: AppContext, conn: ConnectionRow, callId: string, p: Record<string, string>): Promise<string> {
  const c = await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ? AND workspace_id = ? AND transport = 'phone'", callId, conn.workspace_id);
  const meta = c ? parseJson<{ agent_call_sid?: string; visitor_phone?: string; caller_id?: string }>(c.meta, {}) : {};
  if (!c || c.state !== "ringing" || !meta.visitor_phone || (meta.agent_call_sid && p.CallSid !== meta.agent_call_sid)) return hangup("This call is no longer available.");
  const s = (await callSettings(ctx, c.workspace_id)).phone;
  try {
    await stepCall(ctx, c, "accept");
  } catch (e) {
    if (e instanceof AppError || e instanceof IllegalTransition) return hangup("This call is no longer available.");
    throw e;
  }
  const status = hook(ctx, conn, "status", c.id, "&leg=visitor");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting you to the customer.</Say>` +
    `<Dial callerId="${esc(meta.caller_id ?? s.caller_id ?? "")}" timeLimit="${s.max_duration_s}" timeout="${PHONE_CONNECT_S - 45}" answerOnBridge="true">` +
    `<Number statusCallback="${esc(status)}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed">${esc(meta.visitor_phone)}</Number></Dial></Response>`
  );
}

/** One status callback of either leg. Duplicates and out-of-order callbacks are harmless: every transition is a compare-and-set. */
export async function voiceStatus(ctx: AppContext, conn: ConnectionRow, callId: string, leg: "agent" | "visitor", p: Record<string, string>): Promise<"processed" | "duplicate" | "ignored"> {
  if (!p.CallSid || !p.CallStatus) return "ignored";
  if (!(await claimEvent(ctx, "twilio_voice", `${conn.id}|${p.CallSid}|${p.CallStatus}|${p.SequenceNumber ?? ""}`))) return "duplicate";
  const c = await ctx.db.get<CallRow>("SELECT * FROM calls WHERE id = ? AND workspace_id = ? AND transport = 'phone'", callId, conn.workspace_id);
  if (!c) return "ignored";
  const meta = parseJson<{ agent_call_sid?: string; visitor_call_sid?: string; first_completed?: string }>(c.meta, {});
  // the leg must be the one we created: the agent's sid, or a child of it
  if (leg === "agent" && meta.agent_call_sid && p.CallSid !== meta.agent_call_sid) return "ignored";
  if (leg === "visitor") {
    if (meta.agent_call_sid && p.ParentCallSid !== meta.agent_call_sid) return "ignored";
    if (!meta.visitor_call_sid) await ctx.db.run("UPDATE calls SET meta = ? WHERE id = ?", JSON.stringify({ ...meta, visitor_call_sid: p.CallSid }), c.id);
  }
  const done = async (event: CallEvent, who: string, reason: string) => void (await finishPhone(ctx, c, event, { ended_by: who, end_reason: reason }));
  const st = p.CallStatus;
  if (st === "completed") {
    // whoever's leg completed first hung up; the other completes because the bridge ends
    const first = meta.first_completed ?? leg;
    if (!meta.first_completed) await ctx.db.run("UPDATE calls SET meta = ? WHERE id = ? AND meta = ?", JSON.stringify({ ...meta, first_completed: leg }), c.id, c.meta);
    const who = first === "agent" ? "agent" : "visitor";
    if (c.state === "ringing") await done("cancel", "agent", "cancelled");
    else await done("end", who, "completed");
  } else if (leg === "agent" && (st === "busy" || st === "no-answer" || st === "failed")) {
    if (c.state === "ringing") await done("fail", "system", st === "failed" ? "agent_unreachable" : "agent_no_answer");
  } else if (leg === "agent" && st === "canceled") {
    await done(c.state === "ringing" ? "cancel" : "end", "agent", "cancelled");
  } else if (leg === "visitor") {
    if (st === "in-progress") await stepQuiet(ctx, c, "connected");
    else if (st === "busy") await done("busy", "visitor", "declined");
    else if (st === "no-answer") await done("no_answer", "system", "no_answer");
    else if (st === "failed") await done("fail", "system", "visitor_unreachable");
    else if (st === "canceled") await done("end", "system", "cancelled");
  }
  return "processed";
}

async function stepQuiet(ctx: AppContext, c: CallRow, event: CallEvent) {
  try {
    await stepCall(ctx, c, event);
  } catch (e) {
    if (!(e instanceof IllegalTransition) && !(e instanceof AppError)) throw e;
  }
}

/**
 * Time limits of the phone legs (called by the call sweep): an agent who does not pick up within the ring time and a bridge that never completes
 * are ended; the provider is asked to hang up so nothing keeps ringing and billing.
 */
export async function sweepPhone(ctx: AppContext, c: CallRow): Promise<"ended" | null> {
  const age = (ctx.clock().getTime() - Date.parse(c.updated_at)) / 1000;
  const limit = c.state === "ringing" ? PHONE_MAX_RING_S : c.state === "connecting" ? PHONE_CONNECT_S : Infinity;
  if (age < limit) return null;
  const meta = parseJson<{ agent_call_sid?: string }>(c.meta, {});
  const conn = await twilioRow(ctx, c.workspace_id);
  if (conn && meta.agent_call_sid) await ctx.providers.twilioFor(conn).endCall(meta.agent_call_sid).catch(() => {});
  await finishPhone(ctx, c, "fail", { ended_by: "system", end_reason: c.state === "ringing" ? "agent_no_answer" : "connect_timeout" });
  return "ended";
}

export async function phoneConsentGiven(ctx: AppContext, roomId: string): Promise<boolean> {
  const row = await ctx.db.get<{ contact_id: string; workspace_id: string }>("SELECT contact_id, workspace_id FROM rooms WHERE id = ?", roomId);
  if (!row) return false;
  const c = await getContact(ctx, row.workspace_id, row.contact_id);
  return !!c.phone && parseJson<{ call_consent?: { phone?: string } }>(c.attrs, {}).call_consent?.phone === c.phone;
}

