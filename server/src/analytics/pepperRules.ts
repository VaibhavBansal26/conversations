import { createHash } from "node:crypto";
import { badRequest } from "../errors.js";

/**
 * Rules for an identity pepper that an administrator imports (so two apps of one customer can derive the same contact_key).
 * The pepper is used exactly as typed (HMAC key = its UTF-8 bytes), so nothing is trimmed or normalised: a value with
 * surrounding whitespace is rejected instead of silently changed, which would make the two apps disagree.
 *
 *   - 32 to 256 printable ASCII characters, no whitespace
 *   - a hex string must carry at least 32 bytes (64 hex characters); a base64 / base64url string at least 32 bytes (43 characters)
 *   - at least 12 distinct characters and a Shannon estimate of at least 128 bits and 3 bits per character
 *   - no repeated short pattern ("abcabc...") and no mostly sequential runs ("0123456789...")
 *   - must not look like one of our own stored forms (`enc2.`)
 */
export const PEPPER_MIN_CHARS = 32;
export const PEPPER_MAX_CHARS = 256;

/** First 8 hex characters of SHA-256 over the pepper: enough to compare two apps by eye, useless for recovering the pepper. */
export const pepperFingerprint = (pepper: string): string => createHash("sha256").update(pepper, "utf8").digest("hex").slice(0, 8);

const shannonBitsPerChar = (s: string): number => {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
};

const isRepeatedPattern = (s: string): boolean => {
  for (let p = 1; p <= Math.min(8, Math.floor(s.length / 2)); p++) if (s.split(s.slice(0, p)).join("") === "") return true;
  return false;
};

const mostlySequential = (s: string): boolean => {
  let steps = 0;
  for (let i = 1; i < s.length; i++) if (Math.abs(s.charCodeAt(i) - s.charCodeAt(i - 1)) <= 1) steps++;
  return steps / (s.length - 1) > 0.5;
};

/** Returns the pepper unchanged when acceptable; throws a 400 `INVALID_PEPPER` naming the first rule it breaks. */
export function validatePepper(value: unknown): string {
  const bad = (why: string) => badRequest("INVALID_PEPPER", `The pepper is not acceptable: ${why}`);
  if (typeof value !== "string") throw bad("it must be a string");
  if (value.length < PEPPER_MIN_CHARS) throw bad(`it must be at least ${PEPPER_MIN_CHARS} characters (use 64 hex characters or 43+ base64 characters, i.e. 32 random bytes)`);
  if (value.length > PEPPER_MAX_CHARS) throw bad(`it must be at most ${PEPPER_MAX_CHARS} characters`);
  if (!/^[\x21-\x7e]+$/.test(value)) throw bad("it may only contain printable ASCII characters without spaces (it is used exactly as given, so leading or trailing whitespace is refused)");
  if (value.startsWith("enc2.")) throw bad("it must not start with \"enc2.\"");
  if (/^[0-9a-fA-F]+$/.test(value) && value.length < 64) throw bad("a hex pepper must be at least 64 hex characters (32 bytes)");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && value.length < 43) throw bad("a base64 pepper must be at least 43 characters (32 bytes)");
  const h = shannonBitsPerChar(value);
  if (new Set(value).size < 12 || h < 3 || h * value.length < 128 || isRepeatedPattern(value) || mostlySequential(value)) {
    throw bad("it does not look random enough (too few distinct characters, a repeated pattern or a sequence); generate it with `openssl rand -hex 32`");
  }
  return value;
}
