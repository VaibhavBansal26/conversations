import { isIP } from "node:net";

export interface IpPolicy {
  /** believe X-Forwarded-For (only when a trusted proxy sets it) */
  trustProxy: boolean;
  /** shared secret a CDN adds as `x-edge-secret`; only then is CF-Connecting-IP believed */
  edgeSecret?: string;
  /** how many proxies of ours append to X-Forwarded-For; the client is the entry that many from the right (default 1) */
  proxyHops?: number;
}

const headerValue = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.join(",") : v)?.trim() || undefined;

/**
 * The caller's address.
 *  1. `CF-Connecting-IP` is client-controlled unless the request really came through Cloudflare, so it is honoured only when the request
 *     also carries the shared secret header that a Cloudflare Transform Rule (or the edge Worker) adds.
 *  2. X-Forwarded-For is honoured only behind trusted proxies (TRUST_PROXY). Everything left of our own proxies is client-supplied and
 *     spoofable, so the client is the entry `proxyHops` from the RIGHT, never the first one.
 *  3. Anything else falls back to the TCP peer.
 * Values that are not valid IP literals are ignored.
 */
export function resolveClientIp(policy: IpPolicy, headers: Record<string, string | string[] | undefined>, remote: string | undefined): string | null {
  if (policy.edgeSecret && headerValue(headers["x-edge-secret"]) === policy.edgeSecret) {
    const cf = headerValue(headers["cf-connecting-ip"]);
    if (cf && isIP(cf)) return cf;
  }
  if (policy.trustProxy) {
    const xff = headerValue(headers["x-forwarded-for"]);
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim());
      const hops = Math.max(1, policy.proxyHops ?? 1);
      const candidate = parts[parts.length - hops];
      if (candidate && isIP(candidate)) return candidate;
    }
  }
  return remote ? remote.replace(/^::ffff:/i, "") : null;
}

/** Expand an IPv6 literal to eight 16-bit groups. */
function expandV6(ip: string): number[] | null {
  let s = ip.split("%")[0]!;
  if (s.includes(".")) {
    const m = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const hi = ((Number(m[2]) << 8) | Number(m[3])).toString(16);
    const lo = ((Number(m[4]) << 8) | Number(m[5])).toString(16);
    s = `${m[1]}${hi}:${lo}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const missing = 8 - h.length - t.length;
  if ((tail === undefined && h.length !== 8) || missing < 0) return null;
  const groups = [...h, ...Array(tail !== undefined ? missing : 0).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

/**
 * The key an address is limited under. IPv4 is itself; IPv4-mapped IPv6 is the IPv4 address; other IPv6 is its /64 prefix, because one
 * subscriber typically owns a whole /64 and could otherwise mint 2^64 "different" clients.
 */
export function ipKey(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  if (isIP(ip) === 4) return ip;
  const g = expandV6(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
