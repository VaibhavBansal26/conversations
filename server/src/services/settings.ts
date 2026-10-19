import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import type { Actor } from "../domain/types.js";
import { AppError, forbidden, notFound, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";
import { normalizeEmail, normalizePhone } from "../util/phone.js";
import { getSettings } from "./workspaces.js";
import type { KbDoc } from "../ai/retrieval.js";

const manager = (a: Actor) => {
  if (a.role === "agent") throw forbidden("Only managers can change channel settings");
};

/* ---------- SMS numbers ---------- */
export interface SmsNumberRow {
  id: string;
  workspace_id: string;
  e164: string;
  label: string;
  is_default: number;
  created_at: string;
}
export const listSmsNumbers = (ctx: AppContext, ws: string) =>
  ctx.db.all<SmsNumberRow>("SELECT * FROM sms_numbers WHERE workspace_id = ? ORDER BY is_default DESC, created_at, id", ws);

export async function addSmsNumber(ctx: AppContext, actor: Actor, i: { e164: string; label?: string; is_default?: boolean }): Promise<SmsNumberRow> {
  manager(actor);
  const e164 = normalizePhone(i.e164, (await getSettings(ctx, actor.workspaceId)).default_region);
  if (!e164) throw unprocessable("INVALID_PHONE", "Phone number is not valid");
  const id = newId("num");
  try {
    await ctx.db.tx(async () => {
      await ctx.db.run(
        "INSERT INTO sms_numbers(id, workspace_id, e164, label, is_default, created_at) VALUES (?,?,?,?,?,?)",
        id,
        actor.workspaceId,
        e164,
        i.label ?? "",
        false,
        nowIso(ctx),
      );
      const first = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM sms_numbers WHERE workspace_id = ?", actor.workspaceId))!.n === 1;
      if (i.is_default || first) await setDefaultNumber(ctx, actor.workspaceId, id);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "NUMBER_EXISTS", "This number is already registered");
    throw e;
  }
  return (await ctx.db.get<SmsNumberRow>("SELECT * FROM sms_numbers WHERE id = ?", id))!;
}

async function setDefaultNumber(ctx: AppContext, ws: string, id: string) {
  await ctx.db.run("UPDATE sms_numbers SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE workspace_id = ?", id, ws);
}

export async function setSmsDefault(ctx: AppContext, actor: Actor, id: string) {
  manager(actor);
  if (!(await ctx.db.get("SELECT 1 FROM sms_numbers WHERE id = ? AND workspace_id = ?", id, actor.workspaceId))) throw notFound("SMS number");
  await setDefaultNumber(ctx, actor.workspaceId, id);
}

export async function removeSmsNumber(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  manager(actor);
  const n = await ctx.db.get<SmsNumberRow>("SELECT * FROM sms_numbers WHERE id = ? AND workspace_id = ?", id, actor.workspaceId);
  if (!n) throw notFound("SMS number");
  await ctx.db.tx(async () => {
    await ctx.db.run("DELETE FROM message_locks WHERE workspace_id = ? AND type = 'sms' AND from_addr = ?", actor.workspaceId, n.e164);
    await ctx.db.run("DELETE FROM sms_numbers WHERE id = ?", id);
    if (n.is_default) {
      const next = await ctx.db.get<{ id: string }>("SELECT id FROM sms_numbers WHERE workspace_id = ? ORDER BY created_at LIMIT 1", actor.workspaceId);
      if (next) await setDefaultNumber(ctx, actor.workspaceId, next.id);
    }
  });
}

/* ---------- email senders ---------- */
export interface SenderRow {
  id: string;
  workspace_id: string;
  address: string;
  display_name: string;
  verified: number;
  is_default: number;
  created_at: string;
}
export const listSenders = (ctx: AppContext, ws: string) =>
  ctx.db.all<SenderRow>("SELECT * FROM email_senders WHERE workspace_id = ? ORDER BY is_default DESC, created_at, id", ws);

export async function addSender(
  ctx: AppContext,
  actor: Actor,
  i: { address: string; display_name?: string; verified?: boolean; is_default?: boolean },
): Promise<SenderRow> {
  manager(actor);
  const address = normalizeEmail(i.address)!;
  const id = newId("snd");
  try {
    await ctx.db.tx(async () => {
      await ctx.db.run(
        "INSERT INTO email_senders(id, workspace_id, address, display_name, verified, is_default, created_at) VALUES (?,?,?,?,?,?,?)",
        id,
        actor.workspaceId,
        address,
        i.display_name ?? "",
        i.verified ?? false,
        false,
        nowIso(ctx),
      );
      if (i.is_default) await ctx.db.run("UPDATE email_senders SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE workspace_id = ?", id, actor.workspaceId);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "SENDER_EXISTS", "This sender already exists");
    throw e;
  }
  return (await ctx.db.get<SenderRow>("SELECT * FROM email_senders WHERE id = ?", id))!;
}

export async function updateSender(
  ctx: AppContext,
  actor: Actor,
  id: string,
  i: { display_name?: string; verified?: boolean; is_default?: boolean },
): Promise<SenderRow> {
  manager(actor);
  const cur = await ctx.db.get<SenderRow>("SELECT * FROM email_senders WHERE id = ? AND workspace_id = ?", id, actor.workspaceId);
  if (!cur) throw notFound("Sender");
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE email_senders SET display_name = ?, verified = ? WHERE id = ?", i.display_name ?? cur.display_name, i.verified ?? !!cur.verified, id);
    if (i.is_default) await ctx.db.run("UPDATE email_senders SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE workspace_id = ?", id, actor.workspaceId);
  });
  return (await ctx.db.get<SenderRow>("SELECT * FROM email_senders WHERE id = ?", id))!;
}

export async function removeSender(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  manager(actor);
  if (!(await ctx.db.run("DELETE FROM email_senders WHERE id = ? AND workspace_id = ?", id, actor.workspaceId)).changes) throw notFound("Sender");
}

/* ---------- inbound addresses ---------- */
export const listInboundAddresses = (ctx: AppContext, ws: string) =>
  ctx.db.all<{ address: string; created_at: string }>("SELECT address, created_at FROM inbound_addresses WHERE workspace_id = ? ORDER BY created_at", ws);

export async function addInboundAddress(ctx: AppContext, actor: Actor, addressIn: string) {
  manager(actor);
  const address = normalizeEmail(addressIn)!;
  try {
    await ctx.db.run("INSERT INTO inbound_addresses(address, workspace_id, created_at) VALUES (?,?,?)", address, actor.workspaceId, nowIso(ctx));
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "ADDRESS_EXISTS", "This address is already in use");
    throw e;
  }
  return { address };
}

export async function removeInboundAddress(ctx: AppContext, actor: Actor, address: string): Promise<void> {
  manager(actor);
  if (!(await ctx.db.run("DELETE FROM inbound_addresses WHERE address = ? AND workspace_id = ?", address, actor.workspaceId)).changes) throw notFound("Address");
}

/* ---------- knowledge base ---------- */
export interface KbRow extends KbDoc {
  workspace_id: string;
  created_at: string;
  updated_at: string;
}
export const listKb = (ctx: AppContext, ws: string) => ctx.db.all<KbRow>("SELECT * FROM kb_entries WHERE workspace_id = ? ORDER BY created_at DESC, id", ws);

export async function createKb(ctx: AppContext, actor: Actor, i: { question: string; answer: string }): Promise<KbRow> {
  manager(actor);
  const id = newId("kb");
  const now = nowIso(ctx);
  await ctx.db.run(
    "INSERT INTO kb_entries(id, workspace_id, question, answer, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    id,
    actor.workspaceId,
    i.question,
    i.answer,
    now,
    now,
  );
  return (await ctx.db.get<KbRow>("SELECT * FROM kb_entries WHERE id = ?", id))!;
}

export async function updateKb(ctx: AppContext, actor: Actor, id: string, i: { question: string; answer: string }): Promise<KbRow> {
  manager(actor);
  if (
    !(
      await ctx.db.run(
        "UPDATE kb_entries SET question = ?, answer = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
        i.question,
        i.answer,
        nowIso(ctx),
        id,
        actor.workspaceId,
      )
    ).changes
  )
    throw notFound("Knowledge entry");
  return (await ctx.db.get<KbRow>("SELECT * FROM kb_entries WHERE id = ?", id))!;
}

export async function deleteKb(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  manager(actor);
  if (!(await ctx.db.run("DELETE FROM kb_entries WHERE id = ? AND workspace_id = ?", id, actor.workspaceId)).changes) throw notFound("Knowledge entry");
}
