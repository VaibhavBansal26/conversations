import { isIP } from "node:net";

/** IPv4 or IPv6 address to a BigInt; IPv4-mapped IPv6 collapses to IPv4. Returns null for anything that is not an IP literal. */
function toBig(ip: string): { v: 4 | 6; n: bigint } | null {
  const mapped = ip.replace(/^::ffff:/i, "");
  if (isIP(mapped) === 4) return { v: 4, n: mapped.split(".").reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n) };
  if (isIP(ip) !== 6) return null;
  let s = ip.split("%")[0]!;
  if (s.includes(".")) {
    const m = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    s = `${m[1]}${((Number(m[2]) << 8) | Number(m[3])).toString(16)}:${((Number(m[4]) << 8) | Number(m[5])).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return { v: 6, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || "0", 16)), 0n) };
}

export function validCidr(c: string): boolean {
  const [addr, bits] = c.split("/");
  const a = addr ? toBig(addr) : null;
  if (!a) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d+$/.test(bits) && n >= 0 && n <= (a.v === 4 ? 32 : 128);
}

/** Is `ip` inside any of the CIDR blocks (a bare address means /32 or /128)? */
export function inAnyCidr(ip: string | null, blocks: string[]): boolean {
  if (!blocks.length) return true;
  const a = ip ? toBig(ip) : null;
  if (!a) return false;
  for (const b of blocks) {
    const [addr, bits] = b.split("/");
    const net = addr ? toBig(addr) : null;
    if (!net || net.v !== a.v) continue;
    const width = a.v === 4 ? 32 : 128;
    const len = bits === undefined ? width : Number(bits);
    const shift = BigInt(width - len);
    if (a.n >> shift === net.n >> shift) return true;
  }
  return false;
}
