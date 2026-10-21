import { createHash } from "node:crypto";
import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor } from "../domain/types.js";
import { AppError, forbidden, notFound, unprocessable } from "../errors.js";
import { can } from "../authz/permissions.js";
import { recordAudit } from "../services/audit.js";
import { sniff } from "../services/attachments.js";
import { invalidateAgents, getAgent, type AgentRow } from "./config.js";

/**
 * An AI agent's portrait (docs/AI-AGENTS.md, ADR 0034). The repo has no image library, so the picture is not re-encoded: it is strictly validated
 * (PNG, JPEG or WebP by magic bytes, 1 MB, 64 to 4096 pixels a side, no animation) and every metadata block is removed (EXIF, XMP, ICC profiles, text
 * chunks, comments, thumbnails), so a photo's location or camera data is never published. The web app crops it to a square in the browser first.
 */
export const AVATAR_MAX_BYTES = 1_048_576;
export const AVATAR_MIN_PX = 64;
export const AVATAR_MAX_PX = 4096;
const bad = (m: string) => unprocessable("INVALID_AVATAR", m);

export interface CleanImage {
  mime: "image/png" | "image/jpeg" | "image/webp";
  content: Buffer;
  width: number;
  height: number;
}

function cleanPng(b: Buffer): CleanImage {
  const keep = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB"]);
  const out: Buffer[] = [b.subarray(0, 8)];
  let p = 8;
  let w = 0;
  let h = 0;
  let sawEnd = false;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString("latin1", p + 4, p + 8);
    if (len > b.length || p + 12 + len > b.length) throw bad("The image is damaged");
    if (type === "acTL") throw bad("Animated images are not allowed");
    if (type === "IHDR") {
      if (len !== 13) throw bad("The image is damaged");
      w = b.readUInt32BE(p + 8);
      h = b.readUInt32BE(p + 12);
    }
    if (keep.has(type)) out.push(b.subarray(p, p + 12 + len));
    p += 12 + len;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!w || !h || !sawEnd) throw bad("The image is damaged");
  return { mime: "image/png", content: Buffer.concat(out), width: w, height: h };
}

function cleanJpeg(b: Buffer): CleanImage {
  const out: Buffer[] = [b.subarray(0, 2)];
  let p = 2;
  let w = 0;
  let h = 0;
  let sawScan = false;
  while (p + 2 <= b.length) {
    if (b[p] !== 0xff) throw bad("The image is damaged");
    let marker = b[p + 1]!;
    while (marker === 0xff) marker = b[++p + 1]!; // fill bytes
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (p + 4 > b.length) throw bad("The image is damaged");
    const len = b.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > b.length) throw bad("The image is damaged");
    const seg = b.subarray(p, p + 2 + len);
    if (marker === 0xc2 || marker === 0xc6 || marker === 0xca) throw bad("Progressive images are not supported: save it as a baseline JPEG, PNG or WebP");
    if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
      h = b.readUInt16BE(p + 5);
      w = b.readUInt16BE(p + 7);
    }
    // APPn (EXIF, XMP, ICC, Photoshop) and comments are dropped; JFIF (APP0) stays
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(seg);
    p += 2 + len;
    if (marker === 0xda) {
      // entropy-coded data up to the next real marker is copied as it is
      sawScan = true;
      let q = p;
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0x00 && !(b[q + 1]! >= 0xd0 && b[q + 1]! <= 0xd7))) q++;
      out.push(b.subarray(p, q));
      p = q;
    }
  }
  if (!w || !h || !sawScan) throw bad("The image is damaged");
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) out.push(Buffer.from([0xff, 0xd9]));
  return { mime: "image/jpeg", content: Buffer.concat(out), width: w, height: h };
}

function cleanWebp(b: Buffer): CleanImage {
  if (b.length < 20) throw bad("The image is damaged");
  const chunks: { id: string; data: Buffer }[] = [];
  let p = 12;
  let w = 0;
  let h = 0;
  while (p + 8 <= b.length) {
    const id = b.toString("latin1", p, p + 4);
    const len = b.readUInt32LE(p + 4);
    if (p + 8 + len > b.length) throw bad("The image is damaged");
    const data = b.subarray(p + 8, p + 8 + len);
    if (id === "ANIM" || id === "ANMF") throw bad("Animated images are not allowed");
    if (id === "VP8X") {
      w = 1 + (data[4]! | (data[5]! << 8) | (data[6]! << 16));
      h = 1 + (data[7]! | (data[8]! << 8) | (data[9]! << 16));
      const flags = Buffer.from(data);
      if (flags[0]! & 0x02) throw bad("Animated images are not allowed");
      flags[0] = flags[0]! & ~(0x20 | 0x08 | 0x04); // no ICC profile, EXIF or XMP
      chunks.push({ id, data: flags });
    } else if (id === "VP8 ") {
      if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw bad("The image is damaged");
      w ||= data.readUInt16LE(6) & 0x3fff;
      h ||= data.readUInt16LE(8) & 0x3fff;
      chunks.push({ id, data });
    } else if (id === "VP8L") {
      if (data[0] !== 0x2f) throw bad("The image is damaged");
      const bits = data.readUInt32LE(1);
      w ||= (bits & 0x3fff) + 1;
      h ||= ((bits >> 14) & 0x3fff) + 1;
      chunks.push({ id, data });
    } else if (id === "ALPH") chunks.push({ id, data });
    p += 8 + len + (len & 1);
  }
  if (!w || !h || !chunks.some((c) => c.id === "VP8 " || c.id === "VP8L")) throw bad("The image is damaged");
  const body = Buffer.concat(chunks.map((c) => {
    const head = Buffer.alloc(8);
    head.write(c.id, 0, "latin1");
    head.writeUInt32LE(c.data.length, 4);
    return Buffer.concat([head, c.data, c.data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  }));
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WEBP", 8, "latin1");
  return { mime: "image/webp", content: Buffer.concat([riff, body]), width: w, height: h };
}

/** Validate a candidate portrait and return it without metadata. Throws `INVALID_AVATAR` (422), `FILE_TOO_LARGE` (413) or `UNSUPPORTED_FILE_TYPE` (415). */
export function cleanAvatar(input: Buffer): CleanImage {
  if (input.length === 0) throw bad("The file is empty");
  if (input.length > AVATAR_MAX_BYTES) throw new AppError(413, "FILE_TOO_LARGE", "A portrait is limited to 1 MB");
  const s = sniff(input);
  if (!s || !["image/png", "image/jpeg", "image/webp"].includes(s.mime)) throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "Use a PNG, JPEG or WebP picture");
  const img = s.mime === "image/png" ? cleanPng(input) : s.mime === "image/jpeg" ? cleanJpeg(input) : cleanWebp(input);
  if (img.width < AVATAR_MIN_PX || img.height < AVATAR_MIN_PX) throw bad(`The picture is too small: at least ${AVATAR_MIN_PX} by ${AVATAR_MIN_PX} pixels`);
  if (img.width > AVATAR_MAX_PX || img.height > AVATAR_MAX_PX || img.width * img.height > 16_000_000) throw bad(`The picture is too large: at most ${AVATAR_MAX_PX} pixels a side`);
  return img;
}

const requireManage = (actor: Actor) => {
  if (!can(actor, "agents:manage")) throw forbidden("You need the AI agents permission", "PERMISSION_DENIED");
};
export const avatarUrl = (ctx: AppContext, agentId: string, version: string) => `${ctx.config.PUBLIC_URL.replace(/\/$/, "")}/avatars/agent/${agentId}?v=${version}`;

export async function setAgentAvatar(ctx: AppContext, actor: Actor, agentId: string, file: { content: Buffer; alt?: string }): Promise<AgentRow> {
  requireManage(actor);
  const cur = await getAgent(ctx, actor.workspaceId, agentId);
  const img = cleanAvatar(file.content);
  const alt = (file.alt ?? cur.avatar_alt ?? "").trim().slice(0, 200);
  const stored = await ctx.storage.put(actor.workspaceId, { name: `agent-avatar.${img.mime.split("/")[1]}`, contentType: img.mime, content: img.content });
  const version = createHash("sha256").update(img.content).digest("hex").slice(0, 10);
  await ctx.db.run("UPDATE ai_agents SET avatar_key = ?, avatar_alt = ?, avatar_url = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", stored.key, alt, avatarUrl(ctx, agentId, version), nowIso(ctx), agentId, actor.workspaceId);
  if (cur.avatar_key && cur.avatar_key !== stored.key) await ctx.storage.remove(cur.avatar_key).catch(() => {});
  await invalidateAgents(ctx, actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ai_agent.avatar_set", target: agentId, detail: { mime: img.mime, bytes: img.content.length, width: img.width, height: img.height } });
  return getAgent(ctx, actor.workspaceId, agentId);
}

export async function removeAgentAvatar(ctx: AppContext, actor: Actor, agentId: string): Promise<AgentRow> {
  requireManage(actor);
  const cur = await getAgent(ctx, actor.workspaceId, agentId);
  if (cur.avatar_key) await ctx.storage.remove(cur.avatar_key).catch(() => {});
  await ctx.db.run("UPDATE ai_agents SET avatar_key = NULL, avatar_alt = '', avatar_url = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?", nowIso(ctx), agentId, actor.workspaceId);
  await invalidateAgents(ctx, actor.workspaceId);
  await recordAudit(ctx, { workspaceId: actor.workspaceId, actor: { type: "member", id: actor.memberId }, action: "ai_agent.avatar_removed", target: agentId });
  return getAgent(ctx, actor.workspaceId, agentId);
}

/** The picture itself, for `<img>` tags on visitors' pages (no credentials): the agent's id is the address, nothing else about it is revealed. */
export async function readAgentAvatar(ctx: AppContext, agentId: string): Promise<{ content: Buffer; mime: string }> {
  const row = await ctx.db.get<{ avatar_key: string | null }>("SELECT avatar_key FROM ai_agents WHERE id = ?", agentId);
  if (!row?.avatar_key) throw notFound("Picture");
  const content = await ctx.storage.read(row.avatar_key);
  if (!content) throw notFound("Picture");
  const s = sniff(content);
  if (!s || !["image/png", "image/jpeg", "image/webp"].includes(s.mime)) throw notFound("Picture");
  return { content, mime: s.mime };
}
