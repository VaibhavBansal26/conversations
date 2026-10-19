import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Context } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".map": "application/json",
};

/** Serve a built SPA directory with index.html fallback for client-side routes. Returns null when nothing applies. */
export function serveSpa(root: string, c: Context): Response | null {
  const base = resolve(root);
  const url = new URL(c.req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel.includes("\0")) return null;
  let file = resolve(base, "." + rel);
  if (!file.startsWith(base + sep) && file !== base) return null;
  const isAsset = extname(rel) !== "";
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (isAsset) return null;
    rel = "/index.html";
    file = resolve(base, "index.html");
    if (!existsSync(file)) return null;
  }
  const headers: Record<string, string> = {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  };
  return compressed(c.req.header("accept-encoding"), c.req.header("if-none-match"), readFileSync(file), headers, file);
}

interface Packed {
  etag: string;
  raw: Buffer;
  gzip?: Buffer;
  br?: Buffer;
}
const packed = new Map<string, Packed>();
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;

/** Serve a static body with ETag, conditional GET and a cached gzip/brotli variant (compressed once per file content, not per request). */
export function compressed(acceptEncoding: string | undefined, ifNoneMatch: string | undefined, body: Buffer, headers: Record<string, string>, key: string): Response {
  const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
  let p = packed.get(key);
  if (!p || p.etag !== etag) {
    p = { etag, raw: body };
    if (COMPRESSIBLE.test(headers["Content-Type"] ?? "") && body.length > 1024) {
      p.gzip = gzipSync(body, { level: 9 });
      p.br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
    }
    packed.set(key, p);
  }
  const h: Record<string, string> = { ...headers, ETag: etag, Vary: "Accept-Encoding" };
  if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: h });
  const ae = acceptEncoding ?? "";
  let out = p.raw;
  if (p.br && /\bbr\b/.test(ae)) {
    out = p.br;
    h["Content-Encoding"] = "br";
  } else if (p.gzip && /\bgzip\b/.test(ae)) {
    out = p.gzip;
    h["Content-Encoding"] = "gzip";
  }
  return new Response(new Uint8Array(out), { headers: h });
}

export function readPublicFile(dir: string, name: string): Buffer | null {
  const p = resolve(dir, name);
  return existsSync(p) ? readFileSync(p) : null;
}
