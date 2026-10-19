import { parentPort } from "node:worker_threads";
import { taskImpl, type TaskName } from "./tasks.js";

parentPort!.on("message", (m: { id: number; task: TaskName; input: never }) => {
  try {
    const out = (taskImpl[m.task] as (i: never) => unknown)(m.input);
    parentPort!.postMessage({ id: m.id, ok: true, out });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
