/** Typed message protocol between the UI thread and the shared worker. Every request carries an id; `cancel` targets an earlier id. */

export interface SearchItem {
  id: string;
  text: string;
  sender: string;
  at: string;
}
export interface SearchHit {
  id: string;
  sender: string;
  at: string;
  snippet: string;
  /** [start, end) offsets of every match inside `snippet` */
  ranges: [number, number][];
}

export interface CsvPreview {
  headers: string[];
  total: number;
  valid: number;
  /** first rows for the preview table */
  preview: string[][];
  errors: { row: number; error: string }[];
  recognised: { name: boolean; email: boolean; phone: boolean; tags: boolean };
}

export interface EmailParts {
  main: string;
  quoted: string;
}

export interface RoomSig {
  id: string;
  sig: string;
}
export interface RoomDiff {
  added: string[];
  removed: string[];
  changed: string[];
  moved: string[];
}

export interface Ops {
  search: { in: { items: SearchItem[]; query: string; limit: number }; out: SearchHit[] };
  csv: { in: { text: string; maxRows: number }; out: CsvPreview };
  email: { in: { text: string }; out: EmailParts };
  diff: { in: { prev: RoomSig[]; next: RoomSig[] }; out: RoomDiff };
}
export type OpName = keyof Ops;

export type WorkerRequest = { id: number; op: OpName; payload: unknown } | { id: number; op: "cancel" };
export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; cancelled?: boolean };
