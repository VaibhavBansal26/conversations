import { createHmac } from "node:crypto";
import type { AppContext } from "../context.js";
import { ProviderError } from "../providers/types.js";

/**
 * Where the ICE servers of a call come from (docs/CALLS.md). A browser needs STUN to learn its public address and, on many networks, a TURN relay
 * to connect at all. Credentials are minted per call and expire; a long-lived TURN secret never reaches a browser.
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
export interface IceConfig {
  provider: "none" | "static" | "twilio";
  iceServers: IceServer[];
  /** unix seconds when the TURN credentials stop working; null when there are none */
  expiresAt: number | null;
  /** a plain-words problem the team should see: no relay, a provider that failed */
  warning: string | null;
}

const split = (s: string | undefined): string[] => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const stun = (ctx: AppContext): IceServer[] => {
  const urls = split(ctx.config.STUN_URLS).filter((u) => /^stuns?:/i.test(u));
  return urls.length ? [{ urls }] : [];
};
const NO_RELAY = "No TURN relay is configured: calls will fail for visitors behind strict firewalls or mobile carrier networks. Choose a TURN provider in Settings > Calls.";

/** coturn REST credentials: username `<expiry>:<call id>`, password base64(HMAC-SHA1(secret, username)). */
export function coturnCredentials(secret: string, callId: string, nowSeconds: number, ttl: number): { username: string; credential: string; expiresAt: number } {
  const expiresAt = nowSeconds + ttl;
  const username = `${expiresAt}:${callId}`;
  return { username, credential: createHmac("sha1", secret).update(username).digest("base64"), expiresAt };
}

export async function iceConfig(ctx: AppContext, workspaceId: string, provider: IceConfig["provider"], callId: string): Promise<IceConfig> {
  const base = stun(ctx);
  const nowS = Math.floor(ctx.clock().getTime() / 1000);
  if (provider === "static") {
    const urls = split(ctx.config.TURN_URLS).filter((u) => /^turns?:/i.test(u));
    if (!urls.length || !ctx.config.TURN_SECRET) return { provider, iceServers: base, expiresAt: null, warning: "The static TURN provider is chosen but this server has no TURN_URLS and TURN_SECRET. " + NO_RELAY };
    const c = coturnCredentials(ctx.config.TURN_SECRET, callId, nowS, ctx.config.TURN_TTL_SECONDS);
    return { provider, iceServers: [...base, { urls, username: c.username, credential: c.credential }], expiresAt: c.expiresAt, warning: null };
  }
  if (provider === "twilio") {
    try {
      const row = await ctx.providers.connection(workspaceId, "sms");
      if (!row || row.provider !== "twilio" || row.status !== "verified") return { provider, iceServers: base, expiresAt: null, warning: "The Twilio TURN provider is chosen but the workspace has no verified Twilio connection. " + NO_RELAY };
      const t = await ctx.providers.twilioFor(row).networkTraversalToken(ctx.config.TURN_TTL_SECONDS);
      // Twilio's list carries its own STUN entries: keep them, and ours as a fallback
      return { provider, iceServers: [...t.iceServers, ...base.filter((b) => !t.iceServers.some((x) => x.urls.some((u) => b.urls.includes(u))))], expiresAt: nowS + t.ttl, warning: null };
    } catch (e) {
      ctx.log.warn("twilio turn credentials failed", { error: e instanceof Error ? e.message : String(e), workspace_id: workspaceId });
      const why = e instanceof ProviderError ? e.hint ?? e.message : "Twilio did not answer";
      return { provider, iceServers: base, expiresAt: null, warning: `Twilio could not provide a TURN relay (${why}). ${NO_RELAY}` };
    }
  }
  return { provider: "none", iceServers: base, expiresAt: null, warning: NO_RELAY };
}
