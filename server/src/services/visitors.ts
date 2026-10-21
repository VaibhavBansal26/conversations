import { ownOrigin, PREVIEW_SESSION_HOURS, verifyPreview } from "./widgetPreview.js";
import { workspaceFromAddress } from "./channelConnections.js";
import { assertWorkspaceActive } from "../admin/suspension.js";
import { can } from "../authz/permissions.js";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import { AppError, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { hmacHex, randomDigits, randomToken, safeEqual, sha256 } from "../util/crypto.js";
import { newId } from "../util/ids.js";
import { recordAudit } from "./audit.js";
import { decideIdentity, type IdentityInput } from "./identity.js";
import { addSeconds } from "../util/time.js";
import { isUniqueViolation } from "../db/index.js";
import { findByEmail, findOrCreateContact, getContact, type ContactRow } from "./contacts.js";
import { getSettings, getWorkspace } from "./workspaces.js";
import type { Actor } from "../domain/types.js";

export const SESSION_TTL_DAYS = 30;
export const OTP_TTL_SECONDS = 120;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

/* ---------- embed tokens ---------- */

export interface TokenRow {
  id: string;
  workspace_id: string;
  domain: string;
  token: string;
  created_by: string | null;
  status: "active" | "revoked";
  last_used_at: string | null;
  last_seen_origin: string | null;
  last_seen_at: string | null;
  /** the hosted full-page chat (/chat) may use this token from the app's own origin */
  hosted_chat_enabled: number;
  created_at: string;
}

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/;

export function normalizeDomain(input: string): string {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!d || !DOMAIN_RE.test(d)) throw unprocessable("INVALID_DOMAIN", "Enter a domain such as example.com, *.example.com or localhost:3000");
  return d;
}

/**
 * Does the browser Origin belong to the token's domain pattern?
 *  - exact host match, case-insensitive; the port must match when the pattern has one, otherwise only default ports match
 *  - `*.example.com` matches any depth of subdomain but not the apex and not look-alikes (`evilexample.com`)
 *  - a missing or "null" Origin never matches
 */
export function originMatches(origin: string | null | undefined, pattern: string): boolean {
  if (!origin || origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const p = pattern.toLowerCase();
  const [pHost, pPort] = p.split(":");
  if (pPort ? url.port !== pPort : url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  if (pHost!.startsWith("*.")) return host.endsWith(pHost!.slice(1)) && host.length > pHost!.length - 1;
  return host === pHost;
}

export const tokenDto = (t: TokenRow) => ({
  id: t.id,
  domain: t.domain,
  token: t.token,
  status: t.status,
  last_used_at: t.last_used_at,
  /** the newest widget config request from a real site (never the in-app preview) and the Origin it came from */
  last_seen_origin: t.last_seen_origin,
  last_seen_at: t.last_seen_at,
  hosted_chat_enabled: !!t.hosted_chat_enabled,
  created_at: t.created_at,
});

export async function createToken(ctx: AppContext, actor: Actor, domainInput: string, opts: { hosted_chat_enabled?: boolean } = {}): Promise<TokenRow> {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage embed tokens");
  const domain = normalizeDomain(domainInput);
  if (await ctx.db.get("SELECT 1 FROM tokens WHERE workspace_id = ? AND domain = ? AND status = 'active'", actor.workspaceId, domain)) {
    throw new AppError(409, "TOKEN_EXISTS", "This domain already has an active token. Rotate it instead.");
  }
  const id = newId("tok");
  await ctx.db.run(
    "INSERT INTO tokens(id, workspace_id, domain, token, created_by, created_at, hosted_chat_enabled) VALUES (?,?,?,?,?,?,?)",
    id,
    actor.workspaceId,
    domain,
    `cvt_${randomToken(24)}`,
    actor.memberId,
    nowIso(ctx),
    !!opts.hosted_chat_enabled,
  );
  return (await ctx.db.get<TokenRow>("SELECT * FROM tokens WHERE id = ?", id))!;
}

export async function rotateToken(ctx: AppContext, actor: Actor, id: string): Promise<TokenRow> {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage embed tokens");
  const old = await ctx.db.get<TokenRow>("SELECT * FROM tokens WHERE id = ? AND workspace_id = ? AND status = 'active'", id, actor.workspaceId);
  if (!old) throw notFound("Token");
  return await ctx.db.tx(async () => {
    await ctx.db.run("UPDATE tokens SET status = 'revoked' WHERE id = ?", id);
    // a rotated token keeps its hosted-chat setting
    return await createToken(ctx, actor, old.domain, { hosted_chat_enabled: !!old.hosted_chat_enabled });
  });
}

/** Switch the hosted full-page chat on or off for one token. Existing hosted sessions stop working immediately when it goes off. */
export async function setHostedChat(ctx: AppContext, actor: Actor, id: string, enabled: boolean): Promise<TokenRow> {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage embed tokens");
  const res = await ctx.db.run("UPDATE tokens SET hosted_chat_enabled = ? WHERE id = ? AND workspace_id = ? AND status = 'active'", enabled, id, actor.workspaceId);
  if (!res.changes) throw notFound("Token");
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "token.hosted_chat_changed", target: id, detail: { enabled } });
  return (await ctx.db.get<TokenRow>("SELECT * FROM tokens WHERE id = ?", id))!;
}

export async function revokeToken(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  if (!can(actor, "tokens:manage")) throw forbidden("Only managers can manage embed tokens");
  const res = await ctx.db.run("UPDATE tokens SET status = 'revoked' WHERE id = ? AND workspace_id = ? AND status = 'active'", id, actor.workspaceId);
  if (!res.changes) throw notFound("Token");
}

export const listTokens = (ctx: AppContext, workspaceId: string) =>
  ctx.db.all<TokenRow>("SELECT * FROM tokens WHERE workspace_id = ? AND status = 'active' ORDER BY created_at, id", workspaceId);

/**
 * x-api-key + Origin -> the token (and thereby the workspace). 401 for unknown/revoked keys, 403 for a foreign origin.
 * `preview` (the signed flag of the in-app preview) replaces the key and the domain check by "this exact token, from the app's own origin".
 */
export async function authenticateToken(
  ctx: AppContext,
  apiKey: string | undefined,
  origin: string | undefined,
  opts: { seen?: boolean; preview?: string; hostedChat?: boolean } = {},
): Promise<TokenRow & { preview?: boolean }> {
  if (opts.preview) {
    const claim = verifyPreview(ctx, opts.preview);
    const t = await ctx.db.get<TokenRow>("SELECT * FROM tokens WHERE id = ? AND workspace_id = ?", claim.tokenId, claim.workspaceId);
    if (!t || t.status !== "active") throw unauthorized("Invalid or revoked API key", "INVALID_API_KEY");
    // the flag opens the app's own origin only; a same-origin GET has no Origin header, a POST has the app's
    if (origin !== undefined && origin !== ownOrigin(ctx)) throw forbidden("This origin is not allowed for the API key", "ORIGIN_NOT_ALLOWED");
    await assertWorkspaceActive(ctx, t.workspace_id);
    return { ...t, preview: true };
  }
  const row = apiKey ? await ctx.db.get<TokenRow>("SELECT * FROM tokens WHERE token = ?", apiKey) : undefined;
  if (!row || row.status !== "active") throw unauthorized("Invalid or revoked API key", "INVALID_API_KEY");
  // the hosted chat page runs on the app's own origin: allowed only for a token that opted in, from exactly that origin, or (a same-origin GET carries no
  // Origin header) from a request that says it is the hosted page. A cross-site browser request always carries an Origin, so this opens nothing to other sites.
  const hosted = !!row.hosted_chat_enabled && hostedOriginOk(ctx, origin, !!opts.hostedChat);
  if (!hosted && !originMatches(origin, row.domain)) throw forbidden("This origin is not allowed for the API key", "ORIGIN_NOT_ALLOWED");
  await assertWorkspaceActive(ctx, row.workspace_id);
  if (opts.seen && !hosted && origin) await ctx.db.run("UPDATE tokens SET last_used_at = ?, last_seen_at = ?, last_seen_origin = ? WHERE id = ?", nowIso(ctx), nowIso(ctx), origin!.slice(0, 200), row.id);
  else await ctx.db.run("UPDATE tokens SET last_used_at = ? WHERE id = ?", nowIso(ctx), row.id);
  return row;
}

/** The app's own origin, or no Origin at all from a request marked `x-hosted-chat` (same-origin GET). Never "null". */
export function hostedOriginOk(ctx: AppContext, origin: string | undefined, marked: boolean): boolean {
  if (origin === undefined) return marked;
  return origin === ownOrigin(ctx);
}

/* ---------- visitor sessions ---------- */

export interface SessionRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  token_id: string | null;
  secret_hash: string;
  device_id: string;
  ip: string | null;
  verified: number;
  otp_hash: string | null;
  otp_sent_at: string | null;
  otp_expires_at: string | null;
  otp_attempts: number;
  otp_channel: string | null;
  user_info: string;
  /** minted through the in-app preview: accepted from the app's own origin only */
  preview: number;
  /** minted by a call link: it can only take part in that link's call, and sees nothing else of the conversation */
  call_link_id: string | null;
  expires_at: string;
  expired: number;
  created_at: string;
}

export interface VisitorInfo {
  name?: string;
  email?: string;
  phone?: string;
}

/** May a request from `origin` use this session? Normal sessions: the embed token's domain; preview sessions: the app's own origin only. */
export function sessionOriginAllowed(ctx: AppContext, session: Pick<SessionRow, "preview">, token: Pick<TokenRow, "domain" | "status" | "hosted_chat_enabled">, origin: string): boolean {
  if (token.status !== "active") return false;
  if (session.preview) return origin === ownOrigin(ctx);
  return originMatches(origin, token.domain) || (!!token.hosted_chat_enabled && origin === ownOrigin(ctx));
}

export async function createSession(ctx: AppContext, token: TokenRow & { preview?: boolean }, input: { device_id: string; ip?: string | null } & VisitorInfo & IdentityInput) {
  const ws = token.workspace_id;
  const identity = await decideIdentity(ctx, ws, input);
  const widget = (await getSettings(ctx, ws)).widget;
  const need = new Set<string>([...widget.required_info, ...((["name", "email", "phone"] as const).filter((k) => widget.visitor_info.fields[k] === "required"))]);
  const missing = [...need].filter((k) => !(input as unknown as Record<string, unknown>)[k]?.toString().trim());
  if (missing.length) throw unprocessable("REQUIRED_INFO_MISSING", `Please provide: ${missing.join(", ")}`, { missing });

  let contact: ContactRow;
  const identified = identity.mode === "legacy" && !!(input.email?.trim() || input.phone?.trim());
  if (identity.mode === "verified") contact = await verifiedContact(ctx, ws, identity, input.name);
  else if (identified) contact = (await findOrCreateContact(ctx, ws, { name: input.name, email: input.email, phone: input.phone, source: "widget" })).contact;
  else {
    // anonymous visitors keep their contact per device so a returning browser continues its conversation
    const prev = await ctx.db.get<{ contact_id: string }>(
      "SELECT s.contact_id FROM visitor_sessions s JOIN contacts c ON c.id = s.contact_id WHERE s.workspace_id = ? AND s.device_id = ? AND c.email IS NULL AND c.phone IS NULL AND c.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 1",
      ws,
      input.device_id,
    );
    contact = prev
      ? await getContact(ctx, ws, prev.contact_id)
      : (await findOrCreateContact(ctx, ws, { name: input.name?.trim() || "Visitor", source: "widget" })).contact;
    if (prev && input.name?.trim() && (!contact.name || contact.name === "Visitor")) {
      await ctx.db.run("UPDATE contacts SET name = ? WHERE id = ?", input.name.trim(), contact.id);
    }
  }

  const id = newId("ses");
  const secret = `ses_${randomToken(32)}`;
  const now = ctx.clock();
  const previous = await ctx.db.all<SessionRow>(
    "SELECT * FROM visitor_sessions WHERE workspace_id = ? AND contact_id = ? AND device_id = ? AND expired = 0",
    ws,
    contact.id,
    input.device_id,
  );
  // same device continuing: keep its verification and conversation; anyone else starts unverified
  const inheritVerified = identity.mode === "verified" || previous.some((p) => p.verified && p.expires_at > now.toISOString());
  await ctx.db.tx(async () => {
    await ctx.db.run(
      "INSERT INTO visitor_sessions(id, workspace_id, contact_id, token_id, secret_hash, device_id, ip, verified, user_info, expires_at, created_at, preview) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      ws,
      contact.id,
      token.id,
      sha256(secret),
      input.device_id,
      input.ip ?? null,
      inheritVerified,
      // what the visitor typed, for support staff; under enforcement or a verified identity only the signed parts are trusted elsewhere
      JSON.stringify(identity.mode === "legacy" ? { name: input.name, email: input.email, phone: input.phone } : { name: input.name }),
      addSeconds(now, token.preview ? PREVIEW_SESSION_HOURS * 3600 : SESSION_TTL_DAYS * 86400).toISOString(),
      now.toISOString(),
      !!token.preview,
    );
    for (const p of previous) {
      await ctx.db.run("UPDATE visitor_sessions SET expired = 1 WHERE id = ?", p.id);
      await ctx.db.run("UPDATE rooms SET session_id = ? WHERE session_id = ?", id, p.id);
    }
  });
  const hasHistory = !!(await ctx.db.get(
    "SELECT 1 FROM rooms WHERE workspace_id = ? AND contact_id = ? AND archived = 0 AND (session_id IS NULL OR session_id != ?)",
    ws,
    contact.id,
    id,
  ));
  return {
    session: (await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", id))!,
    secret,
    contact,
    requires_verification: !inheritVerified && hasHistory,
  };
}

/** A signed identity maps to exactly one contact: by external id first, then by email (which adopts the external id). Never by anything unsigned. */
async function verifiedContact(ctx: AppContext, ws: string, id: { externalId?: string; email?: string }, name?: string): Promise<ContactRow> {
  const byExternal = id.externalId ? await ctx.db.get<ContactRow>("SELECT * FROM contacts WHERE workspace_id = ? AND external_id = ? AND deleted_at IS NULL", ws, id.externalId) : undefined;
  let contact = byExternal ?? (id.email ? await findByEmail(ctx, ws, id.email) : undefined);
  if (contact) {
    if (id.externalId && contact.external_id && contact.external_id !== id.externalId) {
      throw new AppError(409, "IDENTITY_CONFLICT", "This email already belongs to another user id");
    }
    const sets: string[] = [];
    const args: (string | number)[] = [];
    if (id.externalId && !contact.external_id) (sets.push("external_id = ?"), args.push(id.externalId));
    if (id.email && !contact.email) (sets.push("email = ?"), args.push(id.email));
    if (name?.trim() && !contact.name) (sets.push("name = ?"), args.push(name.trim()));
    if (sets.length) {
      try {
        await ctx.db.run(`UPDATE contacts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...args, nowIso(ctx), contact.id);
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, "IDENTITY_CONFLICT", "Another contact already uses this email or user id");
        throw e;
      }
      contact = await getContact(ctx, ws, contact.id);
    }
    return contact;
  }
  const created = (await findOrCreateContact(ctx, ws, { name: name?.trim() || "Visitor", email: id.email, source: "widget" })).contact;
  if (!id.externalId) return created;
  try {
    await ctx.db.run("UPDATE contacts SET external_id = ? WHERE id = ?", id.externalId, created.id);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "IDENTITY_CONFLICT", "Another contact already uses this user id");
    throw e;
  }
  return await getContact(ctx, ws, created.id);
}

export const sessionDto = (s: SessionRow, contact: ContactRow, secret?: string) => ({
  session_id: s.id,
  session_token: secret,
  workspace_id: s.workspace_id,
  verified: !!s.verified,
  expires_at: s.expires_at,
  contact: { id: contact.id, name: contact.name },
});

/**
 * Session lookup for REST and sockets. Rejects expired sessions, and enforces "same device OR same IP" so a stolen token
 * used from elsewhere (different device and different network) stops working.
 */
export async function authenticateSession(
  ctx: AppContext,
  secret: string | undefined,
  use: { deviceId?: string; ip?: string | null },
  workspaceId?: string,
): Promise<SessionRow> {
  const row = secret ? await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE secret_hash = ?", sha256(secret)) : undefined;
  if (!row) throw unauthorized("Invalid session", "INVALID_SESSION");
  // sessions are bound to one workspace; a token from workspace A is a stranger in workspace B
  if (workspaceId && row.workspace_id !== workspaceId) throw unauthorized("Invalid session", "INVALID_SESSION");
  if (row.expired || row.expires_at <= nowIso(ctx)) {
    await ctx.db.run("UPDATE visitor_sessions SET expired = 1 WHERE id = ?", row.id);
    throw unauthorized("Session expired", "SESSION_EXPIRED");
  }
  const deviceOk = !!use.deviceId && use.deviceId === row.device_id;
  const ipOk = !!use.ip && !!row.ip && use.ip === row.ip;
  if (!deviceOk && !ipOk) throw unauthorized("Session cannot be used from this device", "SESSION_DEVICE_MISMATCH");
  return row;
}

/* ---------- OTP ---------- */

const otpHash = (ctx: AppContext, sessionId: string, code: string) => hmacHex(ctx.config.JWT_SECRET, `otp|${sessionId}|${code}`);

export async function sendOtp(ctx: AppContext, session: SessionRow): Promise<{ channel: "email" | "sms"; expires_at: string; resend_after: string }> {
  if (session.verified) throw new AppError(409, "ALREADY_VERIFIED", "This session is already verified");
  const now = ctx.clock();
  if (session.otp_sent_at && now.getTime() - Date.parse(session.otp_sent_at) < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    throw new AppError(429, "OTP_COOLDOWN", `Please wait ${OTP_RESEND_COOLDOWN_SECONDS} seconds before requesting another code`);
  }
  const contact = await getContact(ctx, session.workspace_id, session.contact_id);
  const channel: "email" | "sms" | null = contact.email ? "email" : contact.phone ? "sms" : null;
  if (!channel) throw unprocessable("OTP_CHANNEL_UNAVAILABLE", "Add an email address or phone number to receive a code");
  const code = randomDigits(5);
  const workspace = await getWorkspace(ctx, session.workspace_id);
  const text = `Your ${workspace.name} verification code is ${code}. It expires in 2 minutes.`;
  const smsFrom =
    channel === "sms"
      ? await ctx.db.get<{ e164: string }>("SELECT e164 FROM sms_numbers WHERE workspace_id = ? ORDER BY is_default DESC, created_at LIMIT 1", session.workspace_id)
      : undefined;
  if (channel === "sms" && !smsFrom) throw unprocessable("OTP_CHANNEL_UNAVAILABLE", "SMS verification is not available for this workspace");
  try {
    if (channel === "email") {
      const route = await ctx.providers.email(session.workspace_id);
      // through the workspace's own SendGrid account the code must come from one of ITS verified senders
      const fromAddress = route.source === "workspace" ? await workspaceFromAddress(ctx, session.workspace_id) : ctx.config.SYSTEM_EMAIL_FROM;
      if (!fromAddress) throw new Error("no verified sender for the workspace's email connection");
      await route.provider.send({
        from: { address: fromAddress, name: workspace.name },
        to: contact.email!,
        subject: "Your verification code",
        text,
        html: `<p>${text}</p>`,
        messageId: `<${newId("otp")}@${fromAddress.split("@")[1] ?? "localhost"}>`,
      });
    } else {
      await (await ctx.providers.sms(session.workspace_id)).provider.send({ to: contact.phone!, from: smsFrom!.e164, body: text, idempotencyKey: newId("otp") });
    }
  } catch (e) {
    ctx.log.warn("otp delivery failed", { session: session.id, channel, error: e instanceof Error ? e.message : String(e) });
    throw new AppError(502, "OTP_DELIVERY_FAILED", "We could not send the verification code. Please try again shortly.");
  }
  const expires = addSeconds(now, OTP_TTL_SECONDS);
  await ctx.db.run(
    "UPDATE visitor_sessions SET otp_hash = ?, otp_sent_at = ?, otp_expires_at = ?, otp_attempts = 0, otp_channel = ? WHERE id = ?",
    otpHash(ctx, session.id, code),
    now.toISOString(),
    expires.toISOString(),
    channel,
    session.id,
  );
  return { channel, expires_at: expires.toISOString(), resend_after: addSeconds(now, OTP_RESEND_COOLDOWN_SECONDS).toISOString() };
}

export async function verifyOtp(ctx: AppContext, session: SessionRow, code: string): Promise<{ verified: true }> {
  const s = (await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", session.id))!;
  if (s.verified) throw new AppError(409, "ALREADY_VERIFIED", "This session is already verified");
  if (!s.otp_hash || !s.otp_expires_at) throw unprocessable("NO_ACTIVE_OTP", "Request a new code first");
  if (ctx.clock().toISOString() >= s.otp_expires_at) {
    await ctx.db.run("UPDATE visitor_sessions SET otp_hash = NULL WHERE id = ?", s.id);
    throw unprocessable("OTP_EXPIRED", "The code has expired. Request a new one.");
  }
  if (!/^\d{5}$/.test(code) || !safeEqual(otpHash(ctx, s.id, code), s.otp_hash)) {
    const attempts = s.otp_attempts + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await ctx.db.run("UPDATE visitor_sessions SET otp_hash = NULL, otp_attempts = ? WHERE id = ?", attempts, s.id);
      throw new AppError(429, "OTP_ATTEMPTS_EXCEEDED", "Too many wrong codes. Request a new one.");
    }
    await ctx.db.run("UPDATE visitor_sessions SET otp_attempts = ? WHERE id = ?", attempts, s.id);
    throw unprocessable("OTP_INVALID", "That code is not correct", { attempts_left: OTP_MAX_ATTEMPTS - attempts });
  }
  // single use: clearing the hash makes a replay impossible
  await ctx.db.run("UPDATE visitor_sessions SET verified = 1, otp_hash = NULL, otp_attempts = 0 WHERE id = ?", s.id);
  await ctx.bus.refreshVisitorAccess(s.workspace_id, s.id);
  return { verified: true };
}
