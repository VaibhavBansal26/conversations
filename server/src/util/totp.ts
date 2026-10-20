import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP (HMAC-SHA1, 6 digits). */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

export const TOTP_STEP_SECONDS = 30;
export const totpStep = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/** RFC 6238 TOTP. Returns the matching time step (so the caller can refuse a replay) or null. Accepts one step either side for clock drift. */
export function verifyTotp(secretB32: string, code: string, nowMs: number, afterStep = 0): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = totpStep(nowMs);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= afterStep) continue;
    if (hotp(secret, s) === code) return s;
  }
  return null;
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const otpauthUrl = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const key = (jwtSecret: string) => Buffer.from(hkdfSync("sha256", jwtSecret, "conversations", "totp-secret-encryption", 32));

/** AES-256-GCM with a key derived from JWT_SECRET: a database dump alone does not reveal the second factor. */
export function encryptSecret(jwtSecret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(jwtSecret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function decryptSecret(jwtSecret: string, blob: string): string {
  const b = Buffer.from(blob, "base64url");
  const d = createDecipheriv("aes-256-gcm", key(jwtSecret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
