import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/** Normalise to E.164. Returns null when the number is not a valid phone number. */
export function normalizePhone(input: string | null | undefined, defaultRegion = "US"): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const p = parsePhoneNumberFromString(trimmed, defaultRegion as CountryCode);
    return p && p.isValid() ? p.number : null;
  } catch {
    return null;
  }
}

export const normalizeEmail = (e: string | null | undefined): string | null => {
  const v = e?.trim().toLowerCase();
  return v ? v : null;
};
