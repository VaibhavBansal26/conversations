import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { importJWK, SignJWT } from "jose";

/**
 * The Web Push protocol, implemented on node:crypto and `jose` (both already dependencies, so no new package and no change to the image):
 *   - message encryption: RFC 8291 (ECDH P-256 + HKDF-SHA-256 + AES-128-GCM, "aes128gcm" content coding of RFC 8188, one record);
 *   - VAPID: RFC 8292 (an ES256 JWT for the push service's origin, sent as `Authorization: vapid t=<jwt>, k=<public key>`).
 * The encryption is checked against the worked example of RFC 8291 section 5 in tests/push.test.ts.
 */
export const b64u = {
  enc: (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url"),
  dec: (s: string) => Buffer.from(s, "base64url"),
};
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

export interface EncryptOptions {
  /** fixed values for the test vector; random in production */
  salt?: Buffer;
  serverPrivateKey?: Buffer;
  recordSize?: number;
}

/** Encrypts `plaintext` for one subscription (`p256dh` = the browser's public key, `auth` = its 16-byte secret). Returns the request body. */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string, o: EncryptOptions = {}): Buffer {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh must be an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");
  const ecdh = createECDH("prime256v1");
  if (o.serverPrivateKey) ecdh.setPrivateKey(o.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = o.salt ?? randomBytes(16);
  const rs = o.recordSize ?? 4096;
  const shared = ecdh.computeSecret(uaPublic);
  // RFC 8291 section 3.4
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  // one record: the plaintext, then the 0x02 delimiter of the last record, no padding
  if (plaintext.length + 1 + 16 > rs) throw new Error("payload too large for one record");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** A fresh VAPID key pair, base64url (what `npm run vapid --prefix server` prints). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { publicKey: b64u.enc(e.getPublicKey()), privateKey: b64u.enc(e.getPrivateKey()) };
}

/** Are these usable VAPID keys (a P-256 private scalar and the matching public point)? */
export function validVapid(k: Partial<VapidKeys>): k is VapidKeys {
  try {
    if (!k.publicKey || !k.privateKey || !k.subject || !/^(mailto:|https:\/\/)/.test(k.subject)) return false;
    const e = createECDH("prime256v1");
    e.setPrivateKey(b64u.dec(k.privateKey));
    return b64u.enc(e.getPublicKey()) === k.publicKey;
  } catch {
    return false;
  }
}

/** The VAPID Authorization header for one push service (the JWT audience is the endpoint's origin, valid for at most 12 hours). */
export async function vapidAuthorization(endpoint: string, k: VapidKeys, now: Date): Promise<string> {
  const pub = b64u.dec(k.publicKey);
  const jwk = { kty: "EC", crv: "P-256", d: k.privateKey, x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)) };
  const key = await importJWK(jwk, "ES256");
  const exp = Math.floor(now.getTime() / 1000) + 12 * 3600;
  const jwt = await new SignJWT({ sub: k.subject }).setProtectedHeader({ alg: "ES256", typ: "JWT" }).setAudience(new URL(endpoint).origin).setExpirationTime(exp).sign(key);
  return `vapid t=${jwt}, k=${k.publicKey}`;
}

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}
/** Everything a push service needs for one message. `topic` replaces an earlier undelivered message with the same topic. */
export async function buildPushRequest(sub: { endpoint: string; p256dh: string; auth: string }, payload: object, k: VapidKeys, now: Date, o: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string } = {}): Promise<PushRequest> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(sub.endpoint, k, now),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(o.ttl ?? 3600),
    urgency: o.urgency ?? "normal",
  };
  if (o.topic) headers.topic = o.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return { endpoint: sub.endpoint, headers, body };
}

/** Sends one request. Injected in tests (a fake push service); the default is `fetch`. */
export type PushTransport = (r: PushRequest) => Promise<{ status: number }>;
export const fetchTransport: PushTransport = async (r) => {
  const res = await fetch(r.endpoint, { method: "POST", headers: r.headers, body: new Uint8Array(r.body), redirect: "manual", signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status };
};
