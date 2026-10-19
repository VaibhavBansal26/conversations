import { htmlToText, sanitizeHtml } from "../util/html.js";

/** Pure, CPU-bound functions that may run on a worker thread. Keep arguments and results structured-clone friendly. */
export interface Tasks {
  sanitizeEmail: { in: { html: string }; out: { html: string; text: string } };
}

export type TaskName = keyof Tasks;

export const taskImpl: { [K in TaskName]: (input: Tasks[K]["in"]) => Tasks[K]["out"] } = {
  sanitizeEmail: ({ html }) => {
    const clean = sanitizeHtml(html).trim();
    return { html: clean, text: htmlToText(clean) };
  },
};
