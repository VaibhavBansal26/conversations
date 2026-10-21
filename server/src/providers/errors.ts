import { ProviderError, type ProviderErrorCode } from "./types.js";

/** Default per-request budget for provider calls. A hung provider must not hold a send, a verify or a request open. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export async function timedFetch(f: typeof fetch, url: string, init: RequestInit, provider: string, timeoutMs: number): Promise<Response> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError(`${provider} did not answer within ${Math.round(timeoutMs / 1000)} seconds`, true, undefined, "timeout", `${provider} is slow or unreachable. Try again in a minute.`);
    }
    throw new ProviderError(`${provider} unreachable: ${e instanceof Error ? e.message : "network error"}`, true, undefined, "unreachable", `Could not reach ${provider}. Check your connection and try again.`);
  }
}

interface Mapped {
  code: ProviderErrorCode;
  hint: string;
  retryable: boolean;
}

/**
 * Twilio error codes: https://www.twilio.com/docs/api/errors (checked against the published list; see docs/CHANNELS.md for what was and was not verified).
 * 20003 authentication failed, 21211 invalid To, 21212 invalid From, 21408 region permission, 21608 unverified number on a trial account,
 * 21610 recipient replied STOP, 21614 To is not a mobile number, 21606/21612 From not usable, 30007 carrier filtered, 20429 too many requests.
 */
export function mapTwilioError(status: number, code: number | undefined, message: string): Mapped {
  const m = message.toLowerCase();
  if (status === 401 || code === 20003) return { code: "auth_failed", retryable: false, hint: "Twilio rejected the Account SID / Auth Token. Paste them again from the Twilio Console (Account Info)." };
  if (status === 403 && code === 20005) return { code: "account_suspended", retryable: false, hint: "Your Twilio account is not active. Reactivate it in the Twilio Console." };
  if (code === 21608) return { code: "trial_restriction", retryable: false, hint: "This is a Twilio trial account: it can only text numbers you have verified in the Twilio Console (Phone Numbers > Verified Caller IDs), or upgrade the account." };
  if (code === 21408) return { code: "permission_denied", retryable: false, hint: "Your Twilio account is not allowed to text this country. Enable it under Messaging > Settings > Geo permissions." };
  if (code === 21211 || code === 21614 || code === 21217) return { code: "invalid_recipient", retryable: false, hint: "Twilio says the destination number is not valid or cannot receive texts." };
  if (code === 21212 || code === 21606 || code === 21612 || code === 21660) return { code: "invalid_sender", retryable: false, hint: "The From number is not a number on this Twilio account or cannot send SMS. Import your numbers again." };
  if (code === 21610) return { code: "recipient_opted_out", retryable: false, hint: "This recipient replied STOP to your number. They must reply START before you can text them." };
  if (status === 402 || /insufficient|balance|funds|exceeded.*limit/.test(m)) return { code: "insufficient_funds", retryable: false, hint: "Your Twilio balance is too low. Add funds in the Twilio Console (Billing)." };
  if (status === 429 || code === 20429) return { code: "rate_limited", retryable: true, hint: "Twilio is rate limiting this account. Sends are retried automatically." };
  if (status >= 500) return { code: "provider_error", retryable: true, hint: "Twilio had a problem. Sends are retried automatically." };
  return { code: "provider_error", retryable: false, hint: "Twilio refused the request. See the message for details." };
}

/** SendGrid errors carry `errors[].message` (and sometimes `field`). */
export function mapSendGridError(status: number, message: string): Mapped {
  const m = message.toLowerCase();
  if (status === 401) return { code: "auth_failed", retryable: false, hint: "SendGrid rejected the API key. Create a key with Mail Send permission and paste it again." };
  if (status === 403 && /sender identity|verified sender|from address/.test(m)) {
    return { code: "unverified_sender", retryable: false, hint: "The From address is not a verified sender in SendGrid. Verify it under Settings > Sender Authentication, or authenticate your domain." };
  }
  if (status === 403 && /credits|exceeded|limit/.test(m)) return { code: "insufficient_funds", retryable: false, hint: "Your SendGrid plan has no sending credits left. Upgrade it or wait for the quota to reset." };
  if (status === 403) return { code: "permission_denied", retryable: false, hint: "The API key lacks a permission this action needs (Mail Send, and Sender Authentication read for imports)." };
  if (status === 429) return { code: "rate_limited", retryable: true, hint: "SendGrid is rate limiting this account. Sends are retried automatically." };
  if (status >= 500) return { code: "provider_error", retryable: true, hint: "SendGrid had a problem. Sends are retried automatically." };
  if (status === 400 && /email|address/.test(m)) return { code: "invalid_recipient", retryable: false, hint: "SendGrid says an email address is not valid." };
  return { code: "provider_error", retryable: false, hint: "SendGrid refused the request. See the message for details." };
}
