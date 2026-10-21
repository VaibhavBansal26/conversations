import type { Policy } from "./types.js";

/**
 * THE policy registry. Every limit in the product is a row here; routes and socket events refer to rows by id (routePolicies.ts), and a
 * test fails when a route or event has no entry. docs/RATE-LIMITING.md renders this table (scripts/gen-ratelimit-doc.mjs checks it is current).
 *
 * `limit` per `windowSec`; GCRA policies are smooth with `burst` back-to-back, window policies are sliding-window counters (hour/day quotas).
 * `tiers` replaces `limit` per workspace plan. onFail says what happens when Redis is unreachable.
 */
const P = (p: Policy): Policy => p;

export const POLICIES: Policy[] = [
  // ---- layer 1: global per-IP guard ----
  P({ id: "ip.global", description: "Every HTTP request, per client IP (/64 for IPv6). Cheapest check, runs first.", keyBy: "ip", algo: "gcra", limit: 100, windowSec: 1, burst: 400, onFail: "open", lease: true }),

  // ---- auth: strict, fail-closed, escalating ----
  P({ id: "auth.login.ip", description: "Login attempts per IP", keyBy: "ip", algo: "gcra", limit: 10, windowSec: 60, burst: 10, onFail: "closed", penalty: true }),
  P({ id: "auth.register.ip", description: "Workspace registrations per IP", keyBy: "ip", algo: "gcra", limit: 10, windowSec: 60, burst: 10, onFail: "closed", penalty: true }),
  P({ id: "auth.fail.account", description: "Failed logins per account (hashed email): 5 failures in 15 min lock the account, escalating 1 min -> 5 min -> 30 min -> 24 h", keyBy: "composite", algo: "strike", limit: 5, windowSec: 900, onFail: "closed" }),
  P({ id: "auth.fail.ip", description: "Failed logins per IP: 20 failures in 15 min block the IP, escalating", keyBy: "ip", algo: "strike", limit: 20, windowSec: 900, onFail: "closed" }),

  P({ id: "auth.refresh.ip", description: "Refresh-token exchanges per IP", keyBy: "ip", algo: "gcra", limit: 60, windowSec: 60, burst: 60, onFail: "open" }),
  P({ id: "auth.mfa.ip", description: "Second-factor submissions per IP", keyBy: "ip", algo: "gcra", limit: 10, windowSec: 60, burst: 10, onFail: "closed", penalty: true }),
  P({ id: "auth.fail.mfa", description: "Wrong second-factor codes per user: 5 in 15 min lock the second step, escalating", keyBy: "composite", algo: "strike", limit: 5, windowSec: 900, onFail: "closed" }),
  P({ id: "auth.forgot.ip", description: "Password-reset requests per IP per hour", keyBy: "ip", algo: "window", limit: 10, windowSec: 3600, onFail: "closed" }),
  P({ id: "auth.forgot.email", description: "Password-reset requests per address per hour (stops mail bombing)", keyBy: "composite", algo: "window", limit: 3, windowSec: 3600, onFail: "closed" }),
  P({ id: "auth.reset.ip", description: "Password-reset and invitation token submissions per IP", keyBy: "ip", algo: "gcra", limit: 10, windowSec: 600, burst: 10, onFail: "closed", penalty: true }),

  // ---- platform admin console: stricter than workspace login, always fail-closed ----
  P({ id: "admin.login.ip", description: "Platform admin sign-in steps per IP (5 per minute)", keyBy: "ip", algo: "gcra", limit: 5, windowSec: 60, burst: 5, onFail: "closed", penalty: true }),
  P({ id: "admin.fail.account", description: "Failed platform admin logins per account: 5 in 15 min lock it, escalating", keyBy: "composite", algo: "strike", limit: 5, windowSec: 900, onFail: "closed" }),
  P({ id: "admin.fail.ip", description: "Failed platform admin logins per IP: 10 in 15 min block the IP, escalating", keyBy: "ip", algo: "strike", limit: 10, windowSec: 900, onFail: "closed" }),
  P({ id: "admin.fail.mfa", description: "Wrong platform admin second-factor codes per admin: 5 in 15 min lock the second step, escalating", keyBy: "composite", algo: "strike", limit: 5, windowSec: 900, onFail: "closed" }),
  P({ id: "admin.api", description: "Platform admin API calls, per admin", keyBy: "user", algo: "gcra", limit: 10, windowSec: 1, burst: 40, onFail: "closed" }),

  // ---- widget (public) ----
  P({ id: "public.config", description: "Widget config fetch, per IP", keyBy: "ip", algo: "gcra", limit: 60, windowSec: 60, burst: 60, onFail: "open" }),
  P({ id: "public.session", description: "Visitor session creation, per IP + Origin + embed token", keyBy: "composite", algo: "gcra", limit: 20, windowSec: 60, burst: 20, onFail: "closed", penalty: true }),
  P({ id: "public.room", description: "Visitor starts a conversation", keyBy: "visitor", algo: "gcra", limit: 10, windowSec: 50, burst: 10, onFail: "open" }),
  P({ id: "public.send", description: "Visitor sends a message", keyBy: "visitor", algo: "gcra", limit: 30, windowSec: 30, burst: 30, onFail: "open" }),
  P({ id: "public.read", description: "Visitor read receipts", keyBy: "visitor", algo: "gcra", limit: 60, windowSec: 30, burst: 60, onFail: "open" }),
  P({ id: "public.query", description: "Visitor reads (session, rooms, messages)", keyBy: "visitor", algo: "gcra", limit: 10, windowSec: 1, burst: 40, onFail: "open", lease: true }),
  P({ id: "public.upload", description: "Visitor file uploads (camera and photo attachments), 10 per minute per visitor", keyBy: "visitor", algo: "gcra", limit: 10, windowSec: 60, burst: 10, onFail: "closed" }),
  P({ id: "public.otp.send", description: "OTP sends per visitor session (5 per 10 min)", keyBy: "visitor", algo: "gcra", limit: 5, windowSec: 600, burst: 5, onFail: "closed", penalty: true }),
  P({ id: "public.otp.contact", description: "OTP sends per contact per day (caps cost of SMS pumping)", keyBy: "composite", algo: "window", limit: 10, windowSec: 86400, onFail: "closed" }),
  P({ id: "public.otp.ip", description: "OTP sends per IP per hour", keyBy: "ip", algo: "window", limit: 30, windowSec: 3600, onFail: "closed" }),
  P({ id: "public.otp.verify", description: "OTP verification attempts per visitor session", keyBy: "visitor", algo: "gcra", limit: 10, windowSec: 300, burst: 10, onFail: "closed", penalty: true }),

  // ---- message volume (REST + socket) ----
  P({ id: "msg.room", description: "Messages per room (visitor + agents together): stops a runaway client or loop", keyBy: "composite", algo: "window", limit: 300, windowSec: 60, onFail: "open" }),
  P({ id: "msg.workspace", description: "Messages per workspace per hour, by plan", keyBy: "workspace", algo: "window", limit: 5000, windowSec: 3600, tiers: { free: 5000, pro: 50000, business: 500000 }, onFail: "open" }),

  // ---- team chat (internal messages between members) ----
  P({ id: "team.send", description: "Team chat messages, per member (REST and socket)", keyBy: "user", algo: "gcra", limit: 90, windowSec: 60, burst: 40, onFail: "open" }),
  P({ id: "team.channel", description: "Team chat messages per channel per minute: stops a runaway client or loop", keyBy: "composite", algo: "window", limit: 300, windowSec: 60, onFail: "open" }),
  P({ id: "team.workspace", description: "Team chat messages per workspace per hour, by plan", keyBy: "workspace", algo: "window", limit: 20000, windowSec: 3600, tiers: { free: 20000, pro: 200000, business: 2000000 }, onFail: "open" }),
  P({ id: "team.search", description: "Team chat searches, per member (20 per minute)", keyBy: "user", algo: "gcra", limit: 20, windowSec: 60, burst: 10, onFail: "open" }),
  P({ id: "team.create", description: "Channel and group message creation per workspace per hour", keyBy: "workspace", algo: "window", limit: 100, windowSec: 3600, onFail: "open" }),

  // ---- authenticated API ----
  P({ id: "api.read", description: "Authenticated reads, per user", keyBy: "user", algo: "gcra", limit: 20, windowSec: 1, burst: 100, onFail: "open", lease: true }),
  P({ id: "api.write", description: "Authenticated writes, per user", keyBy: "user", algo: "gcra", limit: 10, windowSec: 1, burst: 50, onFail: "open", lease: true }),
  P({ id: "api.workspace", description: "All API calls per workspace per minute, by plan", keyBy: "workspace", algo: "window", limit: 1200, windowSec: 60, tiers: { free: 1200, pro: 6000, business: 30000 }, onFail: "open" }),
  P({ id: "api.send", description: "Agent message sends, per user", keyBy: "user", algo: "gcra", limit: 120, windowSec: 60, burst: 60, onFail: "open" }),
  P({ id: "api.upload", description: "Uploads, per user", keyBy: "user", algo: "gcra", limit: 30, windowSec: 60, burst: 30, cost: 1, onFail: "open" }),
  P({ id: "api.import", description: "CSV imports (cost 5 of a small bucket), per workspace", keyBy: "workspace", algo: "gcra", limit: 10, windowSec: 600, burst: 10, cost: 5, onFail: "open" }),
  P({ id: "heavy.concurrency", description: "Concurrent heavy requests (imports) per workspace", keyBy: "workspace", algo: "concurrency", limit: 2, windowSec: 120, ttlMs: 120_000, onFail: "open" }),
  P({ id: "ai.minute", description: "AI calls, per user", keyBy: "user", algo: "gcra", limit: 30, windowSec: 60, burst: 20, onFail: "open" }),
  P({ id: "ai.workspace", description: "AI calls per workspace per day, by plan", keyBy: "workspace", algo: "window", limit: 200, windowSec: 86400, tiers: { free: 200, pro: 5000, business: 50000 }, onFail: "open" }),
  P({ id: "ai.concurrency", description: "Concurrent AI calls per workspace", keyBy: "workspace", algo: "concurrency", limit: 4, windowSec: 60, ttlMs: 60_000, onFail: "open" }),

  // ---- analytics API (API keys) ----
  P({ id: "analytics.read", description: "Analytics API reads, per API key (60 per minute)", keyBy: "apiKey", algo: "gcra", limit: 60, windowSec: 60, burst: 60, onFail: "open" }),
  P({ id: "analytics.export", description: "Analytics exports, per API key (10 per minute)", keyBy: "apiKey", algo: "gcra", limit: 10, windowSec: 60, burst: 10, cost: 1, onFail: "open" }),
  P({ id: "analytics.workspace", description: "Analytics API calls per workspace per minute, by plan", keyBy: "workspace", algo: "window", limit: 120, windowSec: 60, tiers: { free: 120, pro: 600, business: 3000 }, onFail: "open" }),
  P({ id: "analytics.concurrency", description: "Concurrent exports per API key", keyBy: "apiKey", algo: "concurrency", limit: 2, windowSec: 60, ttlMs: 60_000, onFail: "open" }),

  // ---- billing ----
  P({ id: "billing.checkout", description: "Creating Stripe checkout/portal/onboarding sessions, per user (each is a paid API call to Stripe)", keyBy: "user", algo: "gcra", limit: 10, windowSec: 60, burst: 10, onFail: "open" }),
  P({ id: "payments.workspace", description: "Customer payment requests per workspace per hour, by plan", keyBy: "workspace", algo: "window", limit: 20, windowSec: 3600, tiers: { free: 20, pro: 300, business: 3000 }, onFail: "open" }),

  // ---- channel connections (every call here reaches Twilio or SendGrid with the workspace's own credentials) ----
  P({ id: "channels.verify", description: "Credential checks and number/sender imports (read-only provider calls), per user", keyBy: "user", algo: "gcra", limit: 6, windowSec: 60, burst: 6, onFail: "open" }),
  P({ id: "channels.test", description: "Test texts and test emails per workspace per hour (they cost the workspace money at its provider)", keyBy: "workspace", algo: "window", limit: 10, windowSec: 3600, onFail: "closed" }),
  P({ id: "webhook.connection", description: "Inbound provider events per workspace connection (its webhook id), 20/s with a burst of 100", keyBy: "composite", algo: "gcra", limit: 20, windowSec: 1, burst: 100, onFail: "open" }),

  // ---- provider webhooks ----
  P({ id: "webhook.provider", description: "Provider webhooks (Twilio, SendGrid), per IP", keyBy: "ip", algo: "gcra", limit: 300, windowSec: 60, burst: 300, onFail: "closed" }),
  P({ id: "webhook.stripe", description: "Stripe webhooks (platform and Connect), per IP. Signature-verified; Stripe retries what is delayed", keyBy: "ip", algo: "gcra", limit: 600, windowSec: 60, burst: 600, onFail: "open" }),
  P({ id: "webhook.badsig", description: "Webhook signature failures per IP: 10 in 10 min block the IP, escalating", keyBy: "ip", algo: "strike", limit: 10, windowSec: 600, onFail: "closed" }),

  // ---- outbound sends (pacing, not rejection) ----
  P({ id: "sms.number", description: "SMS pacing per sending number (carrier-friendly: 1 message/s, queue instead of reject)", keyBy: "composite", algo: "gcra", limit: 1, windowSec: 1, burst: 1, onFail: "open" }),
  P({ id: "email.sender", description: "Email pacing per sender address (10/s, queue instead of reject)", keyBy: "composite", algo: "gcra", limit: 10, windowSec: 1, burst: 10, onFail: "open" }),
  P({ id: "sms.workspace", description: "SMS sends per workspace per day, by plan (rejected with 429 once exceeded)", keyBy: "workspace", algo: "window", limit: 100, windowSec: 86400, tiers: { free: 100, pro: 2000, business: 20000 }, onFail: "open" }),
  P({ id: "email.workspace", description: "Email sends per workspace per day, by plan", keyBy: "workspace", algo: "window", limit: 500, windowSec: 86400, tiers: { free: 500, pro: 10000, business: 100000 }, onFail: "open" }),
  P({ id: "sms.contact", description: "SMS to one contact per hour (anti-harassment cap)", keyBy: "composite", algo: "window", limit: 20, windowSec: 3600, onFail: "open" }),

  // ---- Socket.IO ----
  P({ id: "ws.connect.ip", description: "Handshake attempts per IP (reconnect storms)", keyBy: "ip", algo: "gcra", limit: 20, windowSec: 1, burst: 40, onFail: "open" }),
  P({ id: "ws.conn.user", description: "Concurrent sockets per team seat", keyBy: "user", algo: "concurrency", limit: 20, windowSec: 60, ttlMs: 300_000, onFail: "open" }),
  P({ id: "ws.conn.visitor", description: "Concurrent sockets per visitor session", keyBy: "visitor", algo: "concurrency", limit: 5, windowSec: 60, ttlMs: 300_000, onFail: "open" }),
  P({ id: "ws.conn.workspace", description: "Concurrent sockets per workspace, by plan (enforced when PLAN_ENFORCEMENT=true)", keyBy: "workspace", algo: "concurrency", limit: 500, windowSec: 60, ttlMs: 300_000, tiers: { free: 500, pro: 5000, business: 100000 }, onFail: "open" }),
  P({ id: "ws.conn.ip", description: "Concurrent sockets per IP (WS_MAX_CONNECTIONS_PER_IP; 0 = off)", keyBy: "ip", algo: "concurrency", limit: 1000, windowSec: 60, ttlMs: 300_000, onFail: "open" }),
  P({ id: "ws.event", description: "Socket events per socket, cost-weighted per event (see EVENT_LIMITS)", keyBy: "socket", algo: "gcra", limit: 10, windowSec: 1, burst: 30, onFail: "open" }),
  P({ id: "ws.actor", description: "Socket events per user/visitor across all their sockets and nodes", keyBy: "composite", algo: "gcra", limit: 40, windowSec: 1, burst: 120, onFail: "open" }),
];

export const POLICY_MAP: ReadonlyMap<string, Policy> = new Map(POLICIES.map((p) => [p.id, p]));

export function policyOf(id: string): Policy {
  const p = POLICY_MAP.get(id);
  if (!p) throw new Error(`unknown rate-limit policy "${id}"`);
  return p;
}
