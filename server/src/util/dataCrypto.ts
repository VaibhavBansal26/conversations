import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";

/**
 * Encryption of long-lived secrets at rest (the analytics identity pepper) with a dedicated key, DATA_ENCRYPTION_KEY, instead of JWT_SECRET:
 * JWT_SECRET is meant to be rotated (it signs everyone out), and a pepper that became unreadable with it would break every analytics export.
 *
 * Stored form: `enc2.<keyId>.<base64url(iv | tag | ciphertext)>` where keyId is the first 8 hex characters of SHA-256 over the derived key, so
 * a reader knows which key to use and a rotation can keep the old key (DATA_ENCRYPTION_KEY_PREVIOUS) while rows are re-encrypted lazily on
 * their next read. AES-256-GCM; the additional authenticated data (`pepper:<workspaceId>`) ties a ciphertext to its row.
 *
 * Rows written before this existed have no prefix: they are base64url(iv | tag | ciphertext) under a key derived from JWT_SECRET (the "legacy" key).
 */

export interface DataKeyConfig {
  NODE_ENV: string;
  JWT_SECRET: string;
  DATA_ENCRYPTION_KEY?: string | undefined;
  DATA_ENCRYPTION_KEY_PREVIOUS?: string | undefined;
}

/** A 32-byte key given as 64 hex characters or as base64 / base64url (padding optional). Anything else is null. */
export function parseDataKey(s: string): Buffer | null {
  const t = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    const b = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return b;
  }
  return null;
}

interface Key {
  id: string;
  key: Buffer;
}
const derive = (material: Buffer | string, info: string): Key => {
  const key = Buffer.from(hkdfSync("sha256", material, "conversations", info, 32));
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
};

/** Active key, previous keys that may still decrypt, and the legacy JWT-derived key. `current` is null when no key may be used (production without DATA_ENCRYPTION_KEY). */
export function dataKeys(c: DataKeyConfig): { current: Key | null; previous: Key[]; legacy: Key; derived: boolean } {
  const legacy: Key = (() => {
    const key = Buffer.from(hkdfSync("sha256", c.JWT_SECRET, "conversations", "totp-secret-encryption", 32));
    return { id: "legacy", key };
  })();
  const previous = (c.DATA_ENCRYPTION_KEY_PREVIOUS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseDataKey(s))
    .filter((b): b is Buffer => !!b)
    .map((b) => derive(b, "data-encryption-v2"));
  if (c.DATA_ENCRYPTION_KEY) {
    const raw = parseDataKey(c.DATA_ENCRYPTION_KEY);
    return { current: raw ? derive(raw, "data-encryption-v2") : null, previous, legacy, derived: false };
  }
  // development and tests only: a key derived from JWT_SECRET so nothing has to be configured (it dies with the secret, which is why production refuses it)
  if (c.NODE_ENV !== "production") return { current: derive(c.JWT_SECRET, "data-encryption-v2-dev-derived"), previous, legacy, derived: true };
  return { current: null, previous, legacy, derived: false };
}

const seal = (k: Key, plain: string, aad: string): string => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc2.${k.id}.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
};

const open = (k: Key, blob: Buffer, aad: string | null): string => {
  const d = createDecipheriv("aes-256-gcm", k.key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  if (aad !== null) d.setAAD(Buffer.from(aad));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
};

export const keyRequired = () =>
  new AppError(503, "DATA_ENCRYPTION_KEY_REQUIRED", "DATA_ENCRYPTION_KEY is not configured. Set it (32 random bytes as 64 hex characters or base64) to use the analytics identity pepper in production.");
export const unreadable = (why: string) =>
  new AppError(409, "PEPPER_UNREADABLE", `The stored identity pepper cannot be decrypted with the configured keys (${why}). Restore the previous DATA_ENCRYPTION_KEY (or put it in DATA_ENCRYPTION_KEY_PREVIOUS), or set a new pepper with PUT /api/v1/analytics/identity-pepper; exports change when you do.`);

export function encryptWithDataKey(c: DataKeyConfig, plain: string, aad: string): string {
  const { current } = dataKeys(c);
  if (!current) throw keyRequired();
  return seal(current, plain, aad);
}

/** `needsRewrite` is true when the value was not under the current key (legacy, previous key): the caller should store `encryptWithDataKey` of it. */
export function decryptWithDataKey(c: DataKeyConfig, stored: string, aad: string): { plain: string; needsRewrite: boolean } {
  const { current, previous, legacy } = dataKeys(c);
  if (!current) throw keyRequired();
  try {
    if (stored.startsWith("enc2.")) {
      const [, kid, body] = stored.split(".");
      const k = [current, ...previous].find((x) => x.id === kid);
      if (!k) throw unreadable(`it was encrypted with key ${kid}, which is not configured`);
      return { plain: open(k, Buffer.from(body ?? "", "base64url"), aad), needsRewrite: k.id !== current.id };
    }
    return { plain: open(legacy, Buffer.from(stored, "base64url"), null), needsRewrite: true };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw unreadable(stored.startsWith("enc2.") ? "authentication failed" : "it was encrypted under a different JWT_SECRET");
  }
}
