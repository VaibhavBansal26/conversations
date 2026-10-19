import { randomBytes } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;

export const WORKSPACE_ID_RE = /^ws_[0-9a-f]{24}$/;
export const isWorkspaceId = (v: unknown): v is string => typeof v === "string" && WORKSPACE_ID_RE.test(v);
