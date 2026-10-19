import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { decodeCursor, encodeCursor } from "../util/cursor.js";
import { parseCsv } from "../util/csv.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { normalizeEmail, normalizePhone } from "../util/phone.js";
import { getSettings } from "./workspaces.js";

export interface ContactRow {
  id: string;
  workspace_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  attrs: string;
  tags: string;
  sms_opt_out: number;
  unsubscribed: number;
  source: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export async function contactDtos(ctx: AppContext, rows: ContactRow[]) {
  const followers = new Map<string, string[]>();
  if (rows.length) {
    const found = await ctx.db.all<{ contact_id: string; member_id: string }>(
      `SELECT contact_id, member_id FROM contact_followers WHERE contact_id IN (${rows.map(() => "?").join(",")}) ORDER BY member_id`,
      ...rows.map((r) => r.id),
    );
    for (const f of found) followers.set(f.contact_id, [...(followers.get(f.contact_id) ?? []), f.member_id]);
  }
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    attrs: parseJson<Record<string, unknown>>(c.attrs, {}),
    tags: parseJson<string[]>(c.tags, []),
    sms_opt_out: !!c.sms_opt_out,
    unsubscribed: !!c.unsubscribed,
    source: c.source,
    followers: followers.get(c.id) ?? [],
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}

export async function contactDto(ctx: AppContext, c: ContactRow) {
  return (await contactDtos(ctx, [c]))[0]!;
}

export const contactBrief = (c: Pick<ContactRow, "id" | "name" | "email" | "phone" | "sms_opt_out">) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  sms_opt_out: !!c.sms_opt_out,
});

export async function findContact(ctx: AppContext, workspaceId: string, id: string): Promise<ContactRow | undefined> {
  return await ctx.db.get<ContactRow>("SELECT * FROM contacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL", id, workspaceId);
}

export async function getContact(ctx: AppContext, workspaceId: string, id: string): Promise<ContactRow> {
  const c = await findContact(ctx, workspaceId, id);
  if (!c) throw notFound("Contact");
  return c;
}

export const findByEmail = (ctx: AppContext, ws: string, email: string) =>
  ctx.db.get<ContactRow>("SELECT * FROM contacts WHERE workspace_id = ? AND email IS NOT NULL AND lower(email) = ? AND deleted_at IS NULL", ws, email.toLowerCase());
export const findByPhone = (ctx: AppContext, ws: string, phone: string) =>
  ctx.db.get<ContactRow>("SELECT * FROM contacts WHERE workspace_id = ? AND phone = ? AND deleted_at IS NULL", ws, phone);

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

async function cleanIdentity(ctx: AppContext, ws: string, input: { email?: string | null; phone?: string | null }) {
  const email = normalizeEmail(input.email);
  let phone: string | null = null;
  if (input.phone && input.phone.trim()) {
    phone = normalizePhone(input.phone, (await getSettings(ctx, ws)).default_region);
    if (!phone) throw unprocessable("INVALID_PHONE", "Phone number is not valid");
  }
  return { email, phone };
}

export interface ContactInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  attrs?: Record<string, unknown>;
  tags?: string[];
  source?: string;
}

export async function createContact(ctx: AppContext, ws: string, input: ContactInput): Promise<ContactRow> {
  const { email, phone } = await cleanIdentity(ctx, ws, input);
  if (!email && !phone && !input.name?.trim()) throw unprocessable("CONTACT_EMPTY", "A contact needs a name, an email or a phone number");
  const dup = (email && (await findByEmail(ctx, ws, email))) || (phone && (await findByPhone(ctx, ws, phone)));
  if (dup) throw new AppError(409, "CONTACT_EXISTS", "A contact with this email or phone already exists", { existing_id: dup.id });
  const id = newId("con");
  const now = nowIso(ctx);
  try {
    await ctx.db.run(
      "INSERT INTO contacts(id, workspace_id, name, email, phone, attrs, tags, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id,
      ws,
      input.name?.trim() ?? "",
      email,
      phone,
      JSON.stringify(input.attrs ?? {}),
      JSON.stringify(normalizeTags(input.tags ?? [])),
      input.source ?? "manual",
      now,
      now,
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "CONTACT_EXISTS", "A contact with this email or phone already exists");
    throw e;
  }
  return await getContact(ctx, ws, id);
}

/**
 * Identity resolution for widget visitors, inbound SMS and inbound email: email wins, then phone.
 * Missing details found on the request are merged into the existing contact. Race-safe through the unique indexes.
 */
export async function findOrCreateContact(ctx: AppContext, ws: string, input: ContactInput): Promise<{ contact: ContactRow; created: boolean }> {
  const { email, phone } = await cleanIdentity(ctx, ws, input);
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = (email && (await findByEmail(ctx, ws, email))) || (phone && (await findByPhone(ctx, ws, phone))) || undefined;
    if (existing) {
      const patch: Partial<ContactInput> = {};
      if (email && !existing.email) patch.email = email;
      if (phone && !existing.phone) patch.phone = phone;
      if (input.name?.trim() && !existing.name) patch.name = input.name.trim();
      if (Object.keys(patch).length) {
        try {
          return { contact: await patchContact(ctx, ws, existing.id, patch), created: false };
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
        }
      }
      return { contact: existing, created: false };
    }
    try {
      return { contact: await createContact(ctx, ws, { ...input, email, phone }), created: true };
    } catch (e) {
      if (!(e instanceof AppError && e.code === "CONTACT_EXISTS")) throw e;
    }
  }
  throw new AppError(409, "CONTACT_EXISTS", "Could not resolve contact");
}

async function patchContact(ctx: AppContext, ws: string, id: string, patch: ContactInput & { sms_opt_out?: boolean; unsubscribed?: boolean }): Promise<ContactRow> {
  const cur = await getContact(ctx, ws, id);
  const email = patch.email === undefined ? cur.email : normalizeEmail(patch.email);
  const phone = patch.phone === undefined ? cur.phone : (await cleanIdentity(ctx, ws, { phone: patch.phone })).phone;
  if (email && email.toLowerCase() !== cur.email?.toLowerCase() && (await findByEmail(ctx, ws, email)))
    throw new AppError(409, "CONTACT_EXISTS", "Another contact already uses this email");
  if (phone && phone !== cur.phone && (await findByPhone(ctx, ws, phone))) throw new AppError(409, "CONTACT_EXISTS", "Another contact already uses this phone number");
  const attrs = patch.attrs ? { ...parseJson<Record<string, unknown>>(cur.attrs, {}), ...patch.attrs } : parseJson(cur.attrs, {});
  for (const k of Object.keys(attrs)) if ((attrs as Record<string, unknown>)[k] === null) delete (attrs as Record<string, unknown>)[k];
  await ctx.db.run(
    "UPDATE contacts SET name = ?, email = ?, phone = ?, attrs = ?, tags = ?, sms_opt_out = ?, unsubscribed = ?, updated_at = ? WHERE id = ?",
    patch.name === undefined ? cur.name : patch.name.trim(),
    email,
    phone,
    JSON.stringify(attrs),
    patch.tags ? JSON.stringify(normalizeTags(patch.tags)) : cur.tags,
    patch.sms_opt_out ?? !!cur.sms_opt_out,
    patch.unsubscribed ?? !!cur.unsubscribed,
    nowIso(ctx),
    id,
  );
  return await getContact(ctx, ws, id);
}

export async function updateContact(ctx: AppContext, actor: Actor, id: string, patch: ContactInput & { sms_opt_out?: boolean; unsubscribed?: boolean }) {
  const c = await patchContact(ctx, actor.workspaceId, id, patch);
  ctx.bus.toWorkspace(actor.workspaceId, "contact:updated", await contactDto(ctx, c));
  return c;
}

export async function setSmsOptOut(ctx: AppContext, ws: string, contactId: string, optOut: boolean): Promise<void> {
  await ctx.db.run("UPDATE contacts SET sms_opt_out = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", optOut, nowIso(ctx), contactId, ws);
}

export async function deleteContact(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  await getContact(ctx, actor.workspaceId, id);
  const rooms = await ctx.db.all<{ id: string }>("SELECT id FROM rooms WHERE contact_id = ? AND archived = 0", id);
  await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?", nowIso(ctx), nowIso(ctx), id);
    await ctx.db.run("UPDATE rooms SET archived = 1, updated_at = ? WHERE contact_id = ? AND archived = 0", nowIso(ctx), id);
    await ctx.db.run("DELETE FROM message_locks WHERE room_id IN (SELECT id FROM rooms WHERE contact_id = ?)", id);
  });
  for (const r of rooms) ctx.bus.toRoom(actor.workspaceId, r.id, "room:deleted", { room_id: r.id }, { visitor: { room_id: r.id } });
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;

export async function listContacts(ctx: AppContext, ws: string, q: { search?: string; tag?: string; cursor?: string; limit: number }) {
  const where = ["c.workspace_id = ?", "c.deleted_at IS NULL"];
  const params: (string | number)[] = [ws];
  if (q.search?.trim()) {
    const op = ctx.db.ilike;
    where.push(`(c.name ${op} ? ESCAPE '\\' OR c.email ${op} ? ESCAPE '\\' OR c.phone ${op} ? ESCAPE '\\')`);
    const l = like(q.search.trim());
    params.push(l, l, l);
  }
  if (q.tag) {
    where.push(ctx.db.jsonArrayHas("c.tags"));
    params.push(q.tag.toLowerCase());
  }
  const w = where.join(" AND ");
  // the total is only computed for the first page: counting on every page would make deep paging linear again
  const total = q.cursor ? null : (await ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM contacts c WHERE ${w}`, ...params))!.n;
  const cur = decodeCursor(q.cursor, 2);
  const keyset = cur ? " AND (c.created_at, c.id) < (?, ?)" : "";
  const rows = await ctx.db.all<ContactRow>(
    `SELECT c.* FROM contacts c WHERE ${w}${keyset} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
    ...params,
    ...(cur ?? []),
    q.limit + 1,
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { data: await contactDtos(ctx, page), pagination: { limit: q.limit, total, has_more: more, next_cursor: more && last ? encodeCursor([last.created_at, last.id]) : null } };
}

export async function addFollower(ctx: AppContext, contactId: string, memberId: string): Promise<void> {
  await ctx.db.run("INSERT OR IGNORE INTO contact_followers(contact_id, member_id) VALUES (?,?)", contactId, memberId);
}

export async function addNote(ctx: AppContext, actor: Actor, contactId: string, body: string) {
  await getContact(ctx, actor.workspaceId, contactId);
  const id = newId("cnt");
  await ctx.db.run(
    "INSERT INTO contact_notes(id, workspace_id, contact_id, member_id, body, created_at) VALUES (?,?,?,?,?,?)",
    id,
    actor.workspaceId,
    contactId,
    actor.memberId,
    body,
    nowIso(ctx),
  );
  return (await ctx.db.get("SELECT id, member_id, body, created_at FROM contact_notes WHERE id = ?", id))!;
}

export async function listNotes(ctx: AppContext, ws: string, contactId: string) {
  await getContact(ctx, ws, contactId);
  return await ctx.db.all(
    "SELECT id, member_id, body, created_at FROM contact_notes WHERE contact_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC",
    contactId,
    ws,
  );
}

export async function deleteNote(ctx: AppContext, actor: Actor, contactId: string, noteId: string): Promise<void> {
  const n = await ctx.db.get<{ member_id: string }>(
    "SELECT member_id FROM contact_notes WHERE id = ? AND contact_id = ? AND workspace_id = ?",
    noteId,
    contactId,
    actor.workspaceId,
  );
  if (!n) throw notFound("Note");
  if (n.member_id !== actor.memberId && actor.role === "agent") throw new AppError(403, "FORBIDDEN", "You can only delete your own notes");
  await ctx.db.run("DELETE FROM contact_notes WHERE id = ?", noteId);
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

/** Basic CSV import. Columns: name,email,phone,tags (";"-separated); any other column becomes a custom attribute. */
export async function importContactsCsv(ctx: AppContext, ws: string, csv: string, maxRows = 2000): Promise<ImportResult> {
  const rows = parseCsv(csv);
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  if (rows.length < 2) return result;
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const known = new Set(["name", "email", "phone", "tags"]);
  if (!header.some((h) => known.has(h))) throw unprocessable("CSV_HEADERS", "CSV needs a header row with at least one of: name, email, phone, tags");
  if (rows.length - 1 > maxRows) throw unprocessable("CSV_TOO_LARGE", `At most ${maxRows} rows per import`);
  for (const [i, cells] of rows.slice(1).entries()) {
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => (rec[h] = (cells[idx] ?? "").trim()));
    const attrs: Record<string, unknown> = {};
    for (const h of header) if (h && !known.has(h) && rec[h]) attrs[h] = rec[h];
    const tags = rec.tags ? rec.tags.split(";") : [];
    try {
      if (!rec.email && !rec.phone && !rec.name) {
        result.skipped++;
        continue;
      }
      const { contact, created } = await findOrCreateContact(ctx, ws, { name: rec.name, email: rec.email, phone: rec.phone, attrs, tags, source: "import" });
      if (created) result.created++;
      else {
        const merged = [...parseJson<string[]>(contact.tags, []), ...tags];
        await patchContact(ctx, ws, contact.id, { tags: merged, attrs });
        result.updated++;
      }
    } catch (e) {
      result.errors.push({ row: i + 2, error: e instanceof AppError ? e.message : "Unexpected error" });
    }
  }
  return result;
}
