import type { AppContext } from "../context.js";
import { nowIso } from "../context.js";
import type { Actor, Attachment } from "../domain/types.js";
import { AppError, unprocessable } from "../errors.js";
import { newId } from "../util/ids.js";

interface Sniffed {
  mime: string;
  exts: string[];
}

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString("latin1");

/** Identify a file by its leading bytes. Declared type / extension are never trusted. */
export function sniff(b: Buffer): Sniffed | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", exts: ["png"] };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", exts: ["jpg", "jpeg"] };
  if (ascii(b, 0, 4) === "GIF8") return { mime: "image/gif", exts: ["gif"] };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", exts: ["webp"] };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return { mime: "audio/wav", exts: ["wav"] };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", exts: ["pdf"] };
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return { mime: "audio/mpeg", exts: ["mp3"] };
  if (ascii(b, 0, 4) === "OggS") return { mime: "audio/ogg", exts: ["ogg", "oga", "opus"] };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "audio/webm", exts: ["webm"] };
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") return { mime: "audio/mp4", exts: ["m4a", "mp4"] };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    return { mime: "application/vnd.openxmlformats-officedocument", exts: ["docx", "xlsx", "pptx"] };
  }
  const head = b.subarray(0, 4096);
  if (b.length > 0 && !head.includes(0)) {
    try {
      // when the sample cut the file mid-way, drop up to 3 bytes so a split multi-byte character is not mistaken for binary
      new TextDecoder("utf-8", { fatal: true }).decode(b.length > 4096 ? head.subarray(0, head.length - 3) : head);
      return { mime: "text/plain", exts: ["txt", "csv", "log", "md"] };
    } catch {
      return null;
    }
  }
  return null;
}

const OFFICE_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"<>:|?*]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

const extOf = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");

export async function saveUpload(ctx: AppContext, actor: Actor, file: { name: string; type?: string; content: Buffer }): Promise<Attachment> {
  if (file.content.length === 0) throw unprocessable("EMPTY_FILE", "File is empty");
  if (file.content.length > ctx.config.UPLOAD_MAX_BYTES) throw new AppError(413, "FILE_TOO_LARGE", `Files are limited to ${ctx.config.UPLOAD_MAX_BYTES} bytes`);
  const fileName = sanitizeFileName(file.name);
  const ext = extOf(fileName);
  const sniffed = sniff(file.content);
  if (!sniffed) throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "This file type is not allowed");
  if (!sniffed.exts.includes(ext)) {
    throw new AppError(415, "FILE_TYPE_MISMATCH", "The file extension does not match its contents");
  }
  const contentType = sniffed.mime.startsWith("application/vnd.openxmlformats") ? OFFICE_MIME[ext]! : ext === "csv" ? "text/csv" : sniffed.mime;
  const stored = await ctx.storage.put(actor.workspaceId, { name: fileName, contentType, content: file.content });
  const id = newId("att");
  ctx.db.run(
    "INSERT INTO attachments(id, workspace_id, key, file_name, content_type, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
    id, actor.workspaceId, stored.key, fileName, contentType, stored.size, actor.memberId, nowIso(ctx),
  );
  return { id, key: stored.key, file_name: fileName, content_type: contentType, size: stored.size };
}

export function resolveAttachments(ctx: AppContext, workspaceId: string, ids: string[]): Attachment[] {
  const out: Attachment[] = [];
  for (const id of new Set(ids)) {
    const a = ctx.db.get<Attachment>("SELECT id, key, file_name, content_type, size FROM attachments WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!a) throw unprocessable("UNKNOWN_ATTACHMENT", `Attachment ${id} not found`);
    out.push(a);
  }
  return out;
}

export const attachmentByKey = (ctx: AppContext, key: string) =>
  ctx.db.get<Attachment & { workspace_id: string }>("SELECT id, key, file_name, content_type, size, workspace_id FROM attachments WHERE key = ?", key);
