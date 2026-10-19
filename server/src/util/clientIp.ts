export interface IpPolicy {
  /** believe X-Forwarded-For (only when a trusted proxy sets it) */
  trustProxy: boolean;
  /** shared secret a CDN adds as `x-edge-secret`; only then is CF-Connecting-IP believed */
  edgeSecret?: string;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || undefined;

/**
 * The caller's address. `CF-Connecting-IP` is client-controlled unless the request really came through Cloudflare, so it is only
 * honoured when the request also carries the shared secret header that a Cloudflare Transform Rule adds. X-Forwarded-For is only
 * honoured behind a trusted proxy (TRUST_PROXY). Anything else falls back to the TCP peer.
 */
export function resolveClientIp(policy: IpPolicy, headers: Record<string, string | string[] | undefined>, remote: string | undefined): string | null {
  const h = (n: string) => first(headers[n]);
  if (policy.edgeSecret && h("x-edge-secret") === policy.edgeSecret) {
    const cf = h("cf-connecting-ip");
    if (cf) return cf;
  }
  if (policy.trustProxy) {
    const xff = h("x-forwarded-for");
    if (xff) return xff;
  }
  return remote ?? null;
}
