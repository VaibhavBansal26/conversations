import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { newId } from "../util/ids.js";
import { hmacHex, safeEqual } from "../util/crypto.js";
import type { Storage, StoredFile } from "./types.js";

const KEY_RE = /^ws_[0-9a-f]{24}\/f_[0-9a-f]{24}$/;

/** Files live under <root>/<workspaceId>/<fileId>. The key never contains user input, so traversal is impossible by construction. */
export class LocalDiskStorage implements Storage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly publicUrl: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error("invalid storage key");
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error("invalid storage key");
    return p;
  }

  async put(workspaceId: string, file: { content: Buffer }): Promise<StoredFile> {
    const key = `${workspaceId}/${newId("f")}`;
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, file.content, { flag: "wx" });
    return { key, size: file.content.length };
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  signedUrl(key: string, opts: { ttlSeconds: number }): string {
    const exp = Math.floor(this.now() / 1000) + opts.ttlSeconds;
    return `${this.publicUrl.replace(/\/$/, "")}/files/${key}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  sign(key: string, exp: number): string {
    return hmacHex(this.secret, `file|${key}|${exp}`);
  }

  /** True only for an untampered, unexpired signature. */
  verify(key: string, exp: number, sig: string): boolean {
    if (!KEY_RE.test(key) || !Number.isFinite(exp) || exp * 1000 < this.now()) return false;
    return safeEqual(this.sign(key, exp), sig);
  }
}

/**
 * Plugging in S3: implement `Storage` with @aws-sdk/client-s3 (put -> PutObject under `<workspaceId>/<id>`,
 * read -> GetObject, signedUrl -> a SigV4 presigned GET with response-content-disposition) and select it
 * with STORAGE_DRIVER in `createContext`. Nothing else in the app touches the disk.
 */
