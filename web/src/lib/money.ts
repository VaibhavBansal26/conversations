/** Minor units (cents) to text: 2500 + "usd" -> "$25.00". Zero-decimal currencies (JPY) use Intl's own digit count. */
export function formatMoney(minor: number, currency: string): string {
  try {
    const f = new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(minor / 10 ** digits);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** "25", "25.5" or "25.50" -> 2500 (cents); null when it is not a positive amount with at most two decimals. */
export function parseMajorToMinor(text: string): number | null {
  const m = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return minor > 0 ? minor : null;
}
