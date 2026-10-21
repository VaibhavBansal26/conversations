import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltHex, keyHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");
export const hmacHex = (key: string, v: string): string => createHmac("sha256", key).update(v).digest("hex");
export const randomToken = (bytes = 24): string => randomBytes(bytes).toString("base64url");
export const randomDigits = (n: number): string => Array.from({ length: n }, () => randomInt(0, 10)).join("");

/**
 * Reversible encryption for secrets the server must read back (HMAC keys it verifies with). AES-256-GCM under a key derived from `secret`
 * (JWT_SECRET) and a purpose label; output `v1.<iv>.<tag>.<ciphertext>` (base64url). Rotating JWT_SECRET makes sealed values unreadable.
 */
const sealKey = (secret: string, purpose: string) => createHmac("sha256", secret).update(`seal|${purpose}`).digest();
export function sealSecret(secret: string, purpose: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(secret, purpose), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
export function openSecret(secret: string, purpose: string, sealed: string): string | null {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", sealKey(secret, purpose), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
