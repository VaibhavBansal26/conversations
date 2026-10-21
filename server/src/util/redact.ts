/**
 * Provider error text is shown to workspace members and stored in `channel_health` / `messages.failure_reason`. Credentials never appear in
 * those texts by design, but a provider may echo part of a request; this is the belt to that pair of braces.
 */
const PATTERNS: RegExp[] = [
  /SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // SendGrid API keys
  /\bSK[0-9a-f]{32}\b/gi, // Twilio API key SIDs
  /\b[0-9a-f]{32}\b/gi, // Twilio auth tokens and API secrets are 32 hex characters
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /Basic\s+[A-Za-z0-9+/=]{12,}/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}

/** `ACxxxxxxxx...1234` -> `AC...1234`: enough for a human to recognise the account, never enough to use it. */
export function maskTail(value: string, keep = 4): string {
  const v = value.trim();
  return v.length <= keep ? "*".repeat(v.length) : `…${v.slice(-keep)}`;
}
