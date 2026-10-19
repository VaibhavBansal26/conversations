import { badRequest } from "../errors.js";

/** Opaque keyset cursor: base64url(JSON array of the sort-key values of the last row). */
export const encodeCursor = (values: (string | number)[]): string => Buffer.from(JSON.stringify(values)).toString("base64url");

export function decodeCursor(raw: string | undefined, arity: number): (string | number)[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === arity && v.every((x) => typeof x === "string" || typeof x === "number")) return v;
  } catch {
    /* fall through */
  }
  throw badRequest("INVALID_CURSOR", "The cursor is not valid");
}
