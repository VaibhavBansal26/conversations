import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { isUniqueViolation } from "../db/index.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound } from "../errors.js";
import { escapeHtml } from "../util/html.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { getContact, type ContactRow } from "./contacts.js";
import { getWorkspace } from "./workspaces.js";

export interface TemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  channel: "any" | "email" | "sms" | "dm";
  subject: string | null;
  body: string;
  shortcut: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const templateDto = (t: TemplateRow) => ({ id: t.id, name: t.name, channel: t.channel, subject: t.subject, body: t.body, shortcut: t.shortcut, created_at: t.created_at, updated_at: t.updated_at });

export const listTemplates = (ctx: AppContext, ws: string) => ctx.db.all<TemplateRow>("SELECT * FROM templates WHERE workspace_id = ? ORDER BY name COLLATE NOCASE, id", ws);

export function getTemplate(ctx: AppContext, ws: string, id: string): TemplateRow {
  const t = ctx.db.get<TemplateRow>("SELECT * FROM templates WHERE id = ? AND workspace_id = ?", id, ws);
  if (!t) throw notFound("Template");
  return t;
}

export interface TemplateInput {
  name: string;
  channel: TemplateRow["channel"];
  subject?: string | null;
  body: string;
  shortcut?: string | null;
}

export function createTemplate(ctx: AppContext, actor: Actor, i: TemplateInput): TemplateRow {
  const id = newId("tpl");
  const now = nowIso(ctx);
  try {
    ctx.db.run("INSERT INTO templates(id, workspace_id, name, channel, subject, body, shortcut, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, actor.workspaceId, i.name, i.channel, i.subject ?? null, i.body, i.shortcut || null, actor.memberId, now, now);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "TEMPLATE_EXISTS", "A template with this shortcut already exists");
    throw e;
  }
  return getTemplate(ctx, actor.workspaceId, id);
}

export function updateTemplate(ctx: AppContext, actor: Actor, id: string, i: Partial<TemplateInput>): TemplateRow {
  const cur = getTemplate(ctx, actor.workspaceId, id);
  ctx.db.run("UPDATE templates SET name = ?, channel = ?, subject = ?, body = ?, shortcut = ?, updated_at = ? WHERE id = ?",
    i.name ?? cur.name, i.channel ?? cur.channel, i.subject === undefined ? cur.subject : i.subject, i.body ?? cur.body, i.shortcut === undefined ? cur.shortcut : i.shortcut || null, nowIso(ctx), id);
  return getTemplate(ctx, actor.workspaceId, id);
}

export function deleteTemplate(ctx: AppContext, actor: Actor, id: string): void {
  getTemplate(ctx, actor.workspaceId, id);
  ctx.db.run("DELETE FROM templates WHERE id = ?", id);
}

export interface MergeData {
  contact?: Pick<ContactRow, "name" | "email" | "phone" | "attrs"> | null;
  agent?: { name: string } | null;
  workspace?: { name: string } | null;
}

const FIELD = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g;
const first = (n: string) => n.trim().split(/\s+/)[0] ?? "";
const rest = (n: string) => n.trim().split(/\s+/).slice(1).join(" ");

function lookup(path: string, d: MergeData): string {
  const [scope, ...parts] = path.toLowerCase().split(".");
  const key = parts.join(".");
  if (scope === "contact" && d.contact) {
    const c = d.contact;
    switch (key) {
      case "name": return c.name ?? "";
      case "first_name": return first(c.name ?? "");
      case "last_name": return rest(c.name ?? "");
      case "email": return c.email ?? "";
      case "phone": return c.phone ?? "";
      default: {
        const attrs = parseJson<Record<string, unknown>>(c.attrs, {});
        const hit = Object.entries(attrs).find(([k]) => k.toLowerCase() === key.replace(/^attrs\./, ""));
        return hit && (typeof hit[1] === "string" || typeof hit[1] === "number") ? String(hit[1]) : "";
      }
    }
  }
  if (scope === "agent" && d.agent) return key === "name" ? d.agent.name : key === "first_name" ? first(d.agent.name) : "";
  if (scope === "workspace" && d.workspace) return key === "name" ? d.workspace.name : "";
  return "";
}

/**
 * Server-side merge. `{{contact.first_name|there}}` falls back to "there" when the value is empty; unknown fields render as
 * the fallback or an empty string, never as raw `{{...}}`. For HTML output every substituted value is escaped.
 */
export function renderTemplateText(text: string, data: MergeData, format: "text" | "html" = "text"): string {
  return text.replace(FIELD, (_m, path: string, fallback?: string) => {
    const v = lookup(path, data).trim();
    const out = v || (fallback ?? "").trim();
    return format === "html" ? escapeHtml(out) : out;
  });
}

export function renderTemplate(ctx: AppContext, actor: Actor, id: string, input: { contact_id?: string; room_id?: string; format: "text" | "html" }) {
  const t = getTemplate(ctx, actor.workspaceId, id);
  let contactId = input.contact_id;
  if (!contactId && input.room_id) contactId = ctx.db.get<{ contact_id: string }>("SELECT contact_id FROM rooms WHERE id = ? AND workspace_id = ?", input.room_id, actor.workspaceId)?.contact_id;
  const data: MergeData = {
    contact: contactId ? getContact(ctx, actor.workspaceId, contactId) : null,
    agent: { name: actor.name },
    workspace: { name: getWorkspace(ctx, actor.workspaceId).name },
  };
  return { subject: t.subject ? renderTemplateText(t.subject, data, input.format) : null, body: renderTemplateText(t.body, data, input.format) };
}
