import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
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
  return new Response(readFileSync(file), { headers });
}

export function readPublicFile(dir: string, name: string): Buffer | null {
  const p = resolve(dir, name);
  return existsSync(p) ? readFileSync(p) : null;
}
