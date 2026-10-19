import type { Ops, OpName } from "./protocol";
import { previewContactsCsv } from "./logic/csv";
import { diffRooms } from "./logic/diff";
import { splitQuoted } from "./logic/email";
import { searchItems } from "./logic/search";

/** One table of pure operations, used by the worker and by the inline fallback alike, so both paths cannot diverge. */
export const ops: { [K in OpName]: (input: Ops[K]["in"], cancelled: () => boolean) => Ops[K]["out"] } = {
  search: ({ items, query, limit }, cancelled) => searchItems(items, query, limit, cancelled),
  csv: ({ text, maxRows }, cancelled) => previewContactsCsv(text, maxRows, cancelled),
  email: ({ text }) => splitQuoted(text),
  diff: ({ prev, next }) => diffRooms(prev, next),
};
