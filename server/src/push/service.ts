import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, notFound, unprocessable } from "../errors.js";
import { enqueueJob } from "../jobs/queue.js";
import { RateLimitedError } from "../ratelimit/errors.js";
import { newId } from "../util/ids.js";
import { parseJson } from "../util/json.js";
import { recordAudit } from "../services/audit.js";
import { findMember, isDnd, memberScope, type MemberRow } from "../services/members.js";
import { getSettings } from "../services/workspaces.js";
import { buildPushRequest, fetchTransport, validVapid, type PushTransport, type VapidKeys } from "./webpush.js";

/**
 * Web Push for team members (docs/NOTIFICATIONS.md). A member subscribes each browser in Settings > Notifications and picks the events it wants:
 *   missed_call  a call from a teammate (1:1 or group) that rang out; sent even when the app is open in another tab
 *   assigned     a conversation or ticket assigned to them; only when the app is closed (no live socket)
 *   message      a new customer message in a conversation assigned to them; only when the app is closed
 * Never while do-not-disturb is on. The payload has no message text unless the workspace switched previews on (`push_message_previews`).
 * Delivery is a background job; 404/410 from the push service deletes the subscription, five failures in a row disable it.
 */
export const PUSH_EVENTS = ["missed_call", "assigned", "message"] as const;
export type PushEvent = (typeof PUSH_EVENTS)[number];
export const MAX_SUBSCRIPTIONS = 10;

/** Swapped by tests for a fake push service. */
let transport: PushTransport = fetchTransport;
export const setPushTransport = (t: PushTransport | null) => void (transport = t ?? fetchTransport);

export function vapidOf(ctx: AppContext): VapidKeys | null {
  const k = { publicKey: ctx.config.VAPID_PUBLIC_KEY, privateKey: ctx.config.VAPID_PRIVATE_KEY, subject: ctx.config.VAPID_SUBJECT };
  return validVapid(k) ? k : null;
}
export function pushConfig(ctx: AppContext) {
  const k = vapidOf(ctx);
  const any = ctx.config.VAPID_PUBLIC_KEY || ctx.config.VAPID_PRIVATE_KEY;
  return { enabled: !!k, public_key: k?.publicKey ?? null, reason: k ? null : any ? "invalid_keys" : "not_configured", events: PUSH_EVENTS };
}

interface SubRow {
  id: string;
  workspace_id: string;
  member_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  user_agent: string;
  events: string;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
  failures: number;
  disabled_at: string | null;
}
/** The endpoint is a capability (anyone holding it can push to that browser): only its host is shown. */
const subDto = (s: SubRow) => ({
  id: s.id,
  label: s.label,
  user_agent: s.user_agent,
  push_service: new URL(s.endpoint).host,
  events: parseJson<string[]>(s.events, []),
  created_at: s.created_at,
  last_success_at: s.last_success_at,
  last_error: s.last_error,
  disabled: !!s.disabled_at,
});

/** Push services we will POST to. Anything else (an internal address, a metadata service) is refused: the endpoint comes from a browser. */
const DEFAULT_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com", "*.push.apple.com", "*.notify.windows.com"];
export function endpointAllowed(ctx: AppContext, endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  const hosts = ctx.config.PUSH_ALLOWED_HOSTS ? ctx.config.PUSH_ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) : DEFAULT_HOSTS;
  const host = u.hostname.toLowerCase();
  const ok = hosts.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h));
  if (!ok || u.username || u.password) return false;
  // plain http only for a local fake push service that an operator listed explicitly
  return u.protocol === "https:" || (u.protocol === "http:" && (host === "127.0.0.1" || host === "localhost"));
}

export async function listSubscriptions(ctx: AppContext, actor: Actor) {
  const rows = await ctx.db.all<SubRow>("SELECT * FROM push_subscriptions WHERE workspace_id = ? AND member_id = ? ORDER BY created_at", actor.workspaceId, actor.memberId);
  return { data: rows.map(subDto), config: { ...pushConfig(ctx), previews: (await getSettings(ctx, actor.workspaceId)).push_message_previews } };
}

export async function subscribe(ctx: AppContext, actor: Actor, input: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string; events?: PushEvent[] }, userAgent: string) {
  if (!vapidOf(ctx)) throw new AppError(503, "PUSH_NOT_CONFIGURED", "Push notifications are not set up on this server");
  if (!endpointAllowed(ctx, input.endpoint)) throw unprocessable("PUSH_ENDPOINT_NOT_ALLOWED", "This push service is not allowed");
  const p = Buffer.from(input.keys.p256dh, "base64url");
  const a = Buffer.from(input.keys.auth, "base64url");
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw unprocessable("INVALID_SUBSCRIPTION", "The browser's subscription keys are not valid");
  const count = (await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ? AND endpoint <> ?", actor.memberId, input.endpoint))!.n;
  if (count >= MAX_SUBSCRIPTIONS) throw unprocessable("TOO_MANY_DEVICES", `At most ${MAX_SUBSCRIPTIONS} devices can receive notifications`);
  const now = nowIso(ctx);
  const events = JSON.stringify(input.events ?? PUSH_EVENTS);
  const id = newId("push");
  await ctx.db.run(
    `INSERT INTO push_subscriptions(id, workspace_id, member_id, endpoint, p256dh, auth, label, user_agent, events, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(member_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, user_agent = excluded.user_agent, events = excluded.events, failures = 0, disabled_at = NULL, last_error = NULL`,
    id, actor.workspaceId, actor.memberId, input.endpoint, input.keys.p256dh, input.keys.auth, (input.label ?? "").slice(0, 60), userAgent.slice(0, 200), events, now,
  );
  const row = (await ctx.db.get<SubRow>("SELECT * FROM push_subscriptions WHERE member_id = ? AND endpoint = ?", actor.memberId, input.endpoint))!;
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "push.subscribed", target: row.id, detail: { push_service: new URL(row.endpoint).host } });
  return subDto(row);
}

async function mine(ctx: AppContext, actor: Actor, id: string): Promise<SubRow> {
  const r = await ctx.db.get<SubRow>("SELECT * FROM push_subscriptions WHERE id = ? AND workspace_id = ? AND member_id = ?", id, actor.workspaceId, actor.memberId);
  if (!r) throw notFound("Device");
  return r;
}
export async function updateSubscription(ctx: AppContext, actor: Actor, id: string, patch: { events?: PushEvent[]; label?: string }) {
  const r = await mine(ctx, actor, id);
  await ctx.db.run("UPDATE push_subscriptions SET events = ?, label = ? WHERE id = ?", JSON.stringify(patch.events ?? parseJson(r.events, [])), (patch.label ?? r.label).slice(0, 60), id);
  return subDto((await ctx.db.get<SubRow>("SELECT * FROM push_subscriptions WHERE id = ?", id))!);
}
export async function deleteSubscription(ctx: AppContext, actor: Actor, id: string) {
  await mine(ctx, actor, id);
  await ctx.db.run("DELETE FROM push_subscriptions WHERE id = ?", id);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "push.unsubscribed", target: id });
  return { ok: true };
}

/** "Send a test": straight to this device (also during do-not-disturb, because the member asked for it), rate-limited. */
export async function testSubscription(ctx: AppContext, actor: Actor, id: string) {
  const r = await mine(ctx, actor, id);
  const rl = await ctx.ratelimit.check("push.test", { key: `${actor.workspaceId}:${actor.memberId}`, workspaceId: actor.workspaceId });
  if (!rl.allowed) throw new RateLimitedError(rl);
  const res = await deliver(ctx, r, { title: "Test notification", body: "Notifications work on this device.", url: "/settings/notifications", tag: "test" });
  return { result: res };
}

export interface PushMessage {
  title: string;
  body: string;
  /** a path in the app the click opens */
  url: string;
  tag: string;
}

/**
 * Queue a push to every device of a member that wants `event`, unless they are on do-not-disturb, or (for assigned and message) have the app open.
 * Rate-limited per member so a burst of messages does not become a burst of notifications.
 */
export async function notifyPush(ctx: AppContext, m: MemberRow, event: PushEvent, msg: PushMessage & { preview?: string; /** what makes this push unique (a message id); defaults to the tag */ key?: string }): Promise<number> {
  if (!vapidOf(ctx)) return 0;
  if (isDnd(ctx, m) || m.availability === "inactive") return 0;
  if (event !== "missed_call" && (await ctx.presence.isOnline(memberScope(m.workspace_id), m.id))) return 0;
  const subs = (await ctx.db.all<SubRow>("SELECT * FROM push_subscriptions WHERE workspace_id = ? AND member_id = ? AND disabled_at IS NULL", m.workspace_id, m.id)).filter((s) => parseJson<string[]>(s.events, []).includes(event));
  if (!subs.length) return 0;
  const rl = await ctx.ratelimit.check("push.member", { key: `${m.workspace_id}:${m.id}`, workspaceId: m.workspace_id });
  if (!rl.allowed) return 0;
  const previews = (await getSettings(ctx, m.workspace_id)).push_message_previews;
  const body = previews && msg.preview ? msg.preview.slice(0, 140) : msg.body;
  for (const s of subs) await enqueueJob(ctx, "push_send", { subscription_id: s.id, message: { title: msg.title, body, url: msg.url, tag: msg.tag } }, { dedupeKey: `push:${s.id}:${msg.key ?? msg.tag}`, maxAttempts: 4, workspaceId: m.workspace_id });
  return subs.length;
}

type Outcome = "sent" | "gone" | "failed" | "retry";
async function deliver(ctx: AppContext, s: SubRow, msg: PushMessage): Promise<Outcome> {
  const k = vapidOf(ctx);
  if (!k) return "failed";
  if (!endpointAllowed(ctx, s.endpoint)) {
    await ctx.db.run("UPDATE push_subscriptions SET disabled_at = ?, last_error = 'endpoint_not_allowed' WHERE id = ?", nowIso(ctx), s.id);
    return "failed";
  }
  const req = await buildPushRequest(s, msg, k, ctx.clock(), { ttl: msg.tag.startsWith("call") ? 60 : 3600, urgency: msg.tag.startsWith("call") ? "high" : "normal", topic: msg.tag });
  let status: number;
  try {
    status = (await transport(req)).status;
  } catch {
    status = 0;
  }
  const outcome: Outcome = status >= 200 && status < 300 ? "sent" : status === 404 || status === 410 ? "gone" : status === 0 || status === 429 || status >= 500 ? "retry" : "failed";
  ctx.metrics.pushSends.inc({ outcome });
  const now = nowIso(ctx);
  if (status >= 200 && status < 300) {
    await ctx.db.run("UPDATE push_subscriptions SET last_success_at = ?, failures = 0, last_error = NULL WHERE id = ?", now, s.id);
    return "sent";
  }
  if (status === 404 || status === 410) {
    // the browser unsubscribed or the subscription expired: forget it
    await ctx.db.run("DELETE FROM push_subscriptions WHERE id = ?", s.id);
    return "gone";
  }
  const failures = s.failures + 1;
  await ctx.db.run("UPDATE push_subscriptions SET failures = ?, last_error = ?, disabled_at = CASE WHEN ? >= 5 THEN ? ELSE disabled_at END WHERE id = ?", failures, `http_${status}`, failures, now, s.id);
  return status === 0 || status === 429 || status >= 500 ? "retry" : "failed";
}

/** Job handler. A temporary failure (network, 429, 5xx) throws so the queue retries with backoff. */
export async function sendPushJob(ctx: AppContext, p: { subscription_id: string; message: PushMessage }): Promise<void> {
  const s = await ctx.db.get<SubRow>("SELECT * FROM push_subscriptions WHERE id = ? AND disabled_at IS NULL", p.subscription_id);
  if (!s) return;
  const m = await findMember(ctx, s.workspace_id, s.member_id);
  if (!m) {
    await ctx.db.run("DELETE FROM push_subscriptions WHERE member_id = ?", s.member_id);
    return;
  }
  if (isDnd(ctx, m)) return;
  const out = await deliver(ctx, s, p.message);
  if (out === "retry") throw new Error("push service unavailable, will retry");
}

/** Convenience for callers that have a member id. */
export async function notifyPushById(ctx: AppContext, ws: string, memberId: string, event: PushEvent, msg: PushMessage & { preview?: string; key?: string }) {
  const m = await findMember(ctx, ws, memberId);
  if (m) await notifyPush(ctx, m, event, msg).catch((e) => ctx.log.warn("push failed", { error: e instanceof Error ? e.message : String(e) }));
}
