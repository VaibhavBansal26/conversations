// Thin REST helper used by test setup to create realistic data (the UI under test is then driven with real clicks).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

export const DEMO = { email: "demo@example.test", password: "demo-password-123" };

/** Signs in as a team member and returns a small client for the REST API. */
export async function loginApi(base, creds = DEMO) {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds) });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  const call = async (method, path, init = {}) => {
    const qs = init.query ? `?${new URLSearchParams(Object.entries(init.query).map(([k, v]) => [k, String(v)]))}` : "";
    const r = await fetch(`${base}/api${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    base,
    token,
    get: (p, q) => call("GET", p, { query: q }),
    post: (p, b) => call("POST", p, { json: b ?? {} }),
    upload: (p, bytes, name, type) => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type }), name);
      return call("POST", p, { body: form });
    },
  };
}

/** A valid 120x80 PNG (gradient) built without dependencies, so image previews have something real to show. */
export function makePng(w = 160, h = 100, rgb = [79, 70, 229]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const k = 0.55 + 0.45 * (x / w);
      raw[o] = Math.round(rgb[0] * k + 40 * (y / h));
      raw[o + 1] = Math.round(rgb[1] * k + 60 * (y / h));
      raw[o + 2] = Math.round(rgb[2] * k);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** A short silent-ish WAV (sine blip) so the voice-note player has real audio with a real duration. */
export function makeWav(seconds = 3) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 330) * 1200 * Math.sin((i / n) * Math.PI)), 44 + i * 2);
  return new Uint8Array(buf);
}

/**
 * The embed token for this stack's own host. A domain can only have one active token, so it is created once, cached in a temp file
 * keyed by port and rotated only if the cache is gone.
 */
export async function embedToken(base) {
  const file = join(tmpdir(), `conv-e2e-embed-token-${new URL(base).port}`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const api = await loginApi(base);
  const host = new URL(base).host;
  let t;
  try {
    t = await api.post("/tokens", { domain: host });
  } catch {
    const existing = (await api.get("/tokens")).data.find((x) => x.domain === host);
    t = await api.post(`/tokens/${existing.id}/rotate`);
  }
  const secret = t.token ?? t.secret ?? t.value;
  writeFileSync(file, secret);
  return secret;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real website visitor: embed token -> session -> room -> messages, through the public API exactly as the widget does. */
export async function visitorConversation(base, tokenSecret, { name, email }, lines, { pauseMs = 0 } = {}) {
  const origin = new URL(base).origin;
  const h = { "content-type": "application/json", "x-api-key": tokenSecret, origin, "x-device-id": `dev-${Math.random().toString(36).slice(2, 14)}` };
  const s = await (await fetch(`${base}/public/sessions`, { method: "POST", headers: h, body: JSON.stringify({ name, email }) })).json();
  const sh = { ...h, "x-support-session": s.session_token };
  const roomRes = await fetch(`${base}/public/rooms`, { method: "POST", headers: sh, body: "{}" });
  const room = (await roomRes.json()).room;
  if (!room) throw new Error(`visitor room failed ${roomRes.status}; session=${JSON.stringify(s).slice(0, 200)}`);
  for (const content of lines) {
    const r = await fetch(`${base}/public/rooms/${room.id}/messages`, { method: "POST", headers: sh, body: JSON.stringify({ content, client_msg_id: crypto.randomUUID() }) });
    if (!r.ok) throw new Error(`visitor send failed ${r.status} ${await r.text()}`);
    if (pauseMs) await pause(pauseMs);
  }
  return room.id;
}

/** Extra demo content the browser tests and screenshots need (images, voice note, a long thread, fresh unread messages). Idempotent per stack. */
export async function enrich(base) {
  const api = await loginApi(base);
  const secret = await embedToken(base);
  const lines = [
    "Hi, I placed order #4821 on Monday and the tracking page has not updated.",
    "It still says label created. Can you check?",
  ];
  const grace = await visitorConversation(base, secret, { name: "Grace Hopper", email: "grace@example.test" }, lines);
  await api.post(`/rooms/${grace}/messages`, { kind: "text", source: "dm", content: "Thanks for flagging, Grace. Let me check with the carrier.", client_msg_id: crypto.randomUUID() });
  await visitorConversation(base, secret, { name: "Linus Torvalds", email: "linus@example.test" }, ["Quick question about the API rate limits.", "Do they apply per key or per workspace?"]);

  // Alice (seeded): an agent message with two images and a voice note
  const rooms = (await api.get("/rooms", { status: "open", limit: 50 })).data;
  const alice = rooms.find((r) => r.contact?.name === "Alice Johnson");
  if (alice) {
    const a = await api.upload("/attachments", makePng(480, 300, [79, 70, 229]), "quote-mockup.png", "image/png");
    const b = await api.upload("/attachments", makePng(480, 300, [14, 116, 144]), "seat-layout.png", "image/png");
    await api.post(`/rooms/${alice.id}/messages`, { kind: "image", source: "dm", content: "Here is the quote and the seat layout.", attachment_ids: [a.id, b.id], client_msg_id: crypto.randomUUID() });
    const v = await api.upload("/attachments", makeWav(4), "voice-note.wav", "audio/wav");
    await api.post(`/rooms/${alice.id}/messages`, { kind: "voice", source: "dm", content: "", attachment_ids: [v.id], client_msg_id: crypto.randomUUID() });
  }
  return { token: secret };
}
