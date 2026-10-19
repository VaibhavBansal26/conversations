import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import { unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";

/** SMS hard limit. Bodies must be strictly shorter than 1600 characters. */
export const SMS_MAX_CHARS = 1599;

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN = new Set(["START", "YES", "UNSTOP"]);

/** Case, whitespace and punctuation insensitive: " Stop. " and "STOP!" both count; "please stop" does not. */
export function classifySmsKeyword(body: string): "opt_out" | "opt_in" | null {
  const k = body
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
  if (OPT_OUT.has(k)) return "opt_out";
  if (OPT_IN.has(k)) return "opt_in";
  return null;
}

const E164 = /^\+[1-9]\d{6,14}$/;
export const isE164 = (s: string): boolean => E164.test(s);

export interface SmsRoute {
  from: string;
}

/**
 * Pick the sender number for a room. A room keeps the number it already talks to the contact from;
 * otherwise the first owned number that is not pinned to the same recipient by another room.
 * The number of owned numbers is therefore the cap on simultaneous SMS conversations per recipient.
 */
export async function chooseSmsNumber(ctx: AppContext, ws: string, roomId: string, to: string): Promise<SmsRoute> {
  const owned = (await ctx.db.all<{ e164: string }>("SELECT e164 FROM sms_numbers WHERE workspace_id = ? ORDER BY is_default DESC, created_at, id", ws)).map(
    (n) => n.e164,
  );
  if (!owned.length) throw unprocessable("NO_SMS_NUMBERS", "This workspace has no SMS number configured");
  const mine = await ctx.db.get<{ from_addr: string }>("SELECT from_addr FROM message_locks WHERE room_id = ? AND type = 'sms'", roomId);
  if (mine && owned.includes(mine.from_addr)) return { from: mine.from_addr };
  const taken = new Set(
    (
      await ctx.db.all<{ from_addr: string }>(
        "SELECT from_addr FROM message_locks WHERE workspace_id = ? AND type = 'sms' AND to_addr = ? AND room_id != ?",
        ws,
        to,
        roomId,
      )
    ).map((l) => l.from_addr),
  );
  const free = owned.find((n) => !taken.has(n));
  if (!free) throw unprocessable("SMS_NUMBERS_EXHAUSTED", "All SMS numbers are already used in other conversations with this contact. Close one of them first.");
  return { from: free };
}

/** Pin (room, type) to a from/to pair. Replaces the room's previous pin; a pair owned by another room is a conflict. */
export async function lockChannel(ctx: AppContext, ws: string, roomId: string, type: "sms" | "email", from: string, to: string): Promise<void> {
  try {
    await ctx.db.run(
      `INSERT INTO message_locks(id, workspace_id, type, from_addr, to_addr, room_id, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(room_id, type) DO UPDATE SET from_addr = excluded.from_addr, to_addr = excluded.to_addr`,
      newId("lock"),
      ws,
      type,
      from,
      to,
      roomId,
      nowIso(ctx),
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw unprocessable(type === "sms" ? "SMS_NUMBERS_EXHAUSTED" : "ADDRESS_LOCKED", "This sender is already used in another conversation with this contact");
    }
    throw e;
  }
}

/** "Re: <first 70 chars>…" — the ellipsis only appears when the text was actually cut. */
export function deriveSubject(roomSubject: string | null | undefined, firstContactText: string | null | undefined, fallback = "Your conversation"): string {
  if (roomSubject?.trim()) {
    const s = roomSubject.trim();
    return /^re:/i.test(s) ? s : `Re: ${s}`;
  }
  const flat = (firstContactText ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return `Re: ${fallback}`;
  return flat.length > 70 ? `Re: ${flat.slice(0, 70)}…` : `Re: ${flat}`;
}

export interface Sender {
  address: string;
  display_name: string;
}

export async function chooseEmailSender(ctx: AppContext, ws: string, requested?: string | null): Promise<Sender> {
  const senders = await ctx.db.all<{ address: string; display_name: string; verified: number; is_default: number }>(
    "SELECT address, display_name, verified, is_default FROM email_senders WHERE workspace_id = ? ORDER BY is_default DESC, created_at, id",
    ws,
  );
  const verified = senders.filter((s) => s.verified);
  if (!verified.length) throw unprocessable("NO_VERIFIED_SENDER", "No verified email sender address is configured");
  if (requested) {
    const hit = verified.find((s) => s.address.toLowerCase() === requested.toLowerCase());
    if (!hit) throw unprocessable("SENDER_NOT_VERIFIED", "The chosen from-address is not a verified sender");
    return hit;
  }
  return verified[0]!;
}

export interface EmailThread {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
}

export const domainOf = (address: string): string => address.split("@")[1]?.toLowerCase() || "localhost";

/** Message-ID for the new message; In-Reply-To = latest known id in the room; References = the chain (capped). */
export async function buildThread(ctx: AppContext, roomId: string, fromAddress: string): Promise<EmailThread> {
  const ids = (
    await ctx.db.all<{ rfc_message_id: string }>(
      "SELECT rfc_message_id FROM messages WHERE room_id = ? AND rfc_message_id IS NOT NULL ORDER BY seq DESC LIMIT 20",
      roomId,
    )
  )
    .map((r) => r.rfc_message_id)
    .reverse();
  return {
    messageId: `<${newId("m")}@${domainOf(fromAddress)}>`,
    inReplyTo: ids.length ? ids[ids.length - 1]! : null,
    references: ids,
  };
}
