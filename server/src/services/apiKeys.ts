import { randomBytes } from "node:crypto";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { badRequest, notFound, unauthorized, forbidden } from "../errors.js";
import { inAnyCidr, validCidr } from "../util/cidr.js";
import { sha256 } from "../util/crypto.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "./audit.js";
import { can, type Permission } from "../authz/permissions.js";

export const API_KEY_SCOPES = ["analytics:read", "analytics:export", "analytics_identity:manage"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  ip_allowlist: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

export const apiKeyDto = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: parseJson<string[]>(k.scopes, []),
  ip_allowlist: parseJson<string[]>(k.ip_allowlist, []),
  expires_at: k.expires_at,
  last_used_at: k.last_used_at,
  last_used_ip: k.last_used_ip,
  revoked_at: k.revoked_at,
  created_at: k.created_at,
});

/** Format `ca_live_<random>`; only the SHA-256 is stored, so the plaintext exists once, in the creation response. */
export async function createApiKey(ctx: AppContext, actor: Actor, input: { name: string; scopes: string[]; ip_allowlist?: string[]; expires_at?: string | null }) {
  const scopes = [...new Set(input.scopes)];
  if (!scopes.length || !scopes.every((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s))) throw badRequest("INVALID_SCOPES", `scopes must be among: ${API_KEY_SCOPES.join(", ")}`);
  // a key can never do more than the person creating it
  for (const s of scopes) if (!can(actor, s as Permission)) throw forbidden(`You cannot create a key with the scope ${s} because your role does not hold that permission`, "PRIVILEGE_ESCALATION");
  const ips = input.ip_allowlist ?? [];
  if (!ips.every(validCidr)) throw badRequest("INVALID_CIDR", "ip_allowlist entries must be IPs or CIDR blocks such as 203.0.113.0/24");
  if (input.expires_at && (Number.isNaN(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= ctx.clock().getTime())) throw badRequest("INVALID_EXPIRY", "expires_at must be a future date");
  const secret = `ca_live_${randomBytes(24).toString("base64url")}`;
  const id = newId("key");
  await ctx.db.run(
    "INSERT INTO api_keys(id, workspace_id, name, prefix, key_hash, scopes, ip_allowlist, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id,
    actor.workspaceId,
    input.name.trim(),
    secret.slice(0, 12),
    sha256(secret),
    JSON.stringify(scopes),
    JSON.stringify(ips),
    input.expires_at ? new Date(input.expires_at).toISOString() : null,
    actor.memberId,
    nowIso(ctx),
  );
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "api_key.create", target: id, detail: { name: input.name, scopes, ip_allowlist: ips, expires_at: input.expires_at ?? null } });
  const row = (await ctx.db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ?", id))!;
  return { ...apiKeyDto(row), key: secret };
}

export async function listApiKeys(ctx: AppContext, workspaceId: string) {
  return (await ctx.db.all<ApiKeyRow>("SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC, id", workspaceId)).map(apiKeyDto);
}

export async function revokeApiKey(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  const r = await ctx.db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL", nowIso(ctx), id, actor.workspaceId);
  if (!r.changes) throw notFound("API key");
  await ctx.cache.invalidate("apikey:*");
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "api_key.revoke", target: id });
}

export interface AuthenticatedKey {
  id: string;
  workspaceId: string;
  scopes: string[];
}

/**
 * Resolve `Authorization: Bearer ca_live_...` to a key. Every failure is the same 401 (no hint whether the key exists, is expired, revoked or
 * used from the wrong address). The key row is cached for a few seconds; revocation invalidates it on every node. `last_used_at` is written at
 * most once a minute per key so a busy consumer does not turn every request into a write.
 */
export async function authenticateApiKey(ctx: AppContext, header: string | undefined, ip: string | null): Promise<AuthenticatedKey> {
  const m = header?.match(/^Bearer\s+(ca_(?:live|test)_[A-Za-z0-9_-]{20,})$/);
  const fail = () => unauthorized("Invalid API key", "INVALID_API_KEY");
  if (!m) throw fail();
  const hash = sha256(m[1]!);
  const row = await ctx.cache.wrap(`apikey:${hash}`, () => ctx.db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE key_hash = ?", hash));
  if (!row || row.revoked_at) throw fail();
  if (row.expires_at && row.expires_at <= nowIso(ctx)) throw fail();
  if (!inAnyCidr(ip, parseJson<string[]>(row.ip_allowlist, []))) throw fail();
  const now = ctx.clock();
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > 60_000) {
    await ctx.db.run("UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?", now.toISOString(), ip, row.id);
    row.last_used_at = now.toISOString();
  }
  return { id: row.id, workspaceId: row.workspace_id, scopes: parseJson<string[]>(row.scopes, []) };
}
