import { randomBytes } from "node:crypto";

let lastMs = 0;
let counter = 0;

/**
 * `<prefix>_<24 hex>`: 12 hex of the millisecond clock, 4 of a per-millisecond counter, 8 random. Ids created by one process sort in
 * creation order, which gives `ORDER BY created_at, id` a stable tiebreak on every database without a rowid.
 */
export const newId = (prefix: string): string => {
  const now = Date.now();
  if (now === lastMs) counter = (counter + 1) & 0xffff;
  else {
    lastMs = now;
    counter = 0;
  }
  return `${prefix}_${now.toString(16).padStart(12, "0")}${counter.toString(16).padStart(4, "0")}${randomBytes(4).toString("hex")}`;
};

export const WORKSPACE_ID_RE = /^ws_[0-9a-f]{24}$/;
export const isWorkspaceId = (v: unknown): v is string => typeof v === "string" && WORKSPACE_ID_RE.test(v);
