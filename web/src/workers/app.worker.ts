/// <reference lib="webworker" />
import { ops } from "./ops";
import type { OpName, WorkerRequest, WorkerResponse } from "./protocol";

const cancelledIds = new Set<number>();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.op === "cancel") {
    cancelledIds.add(m.id);
    return;
  }
  const respond = (r: WorkerResponse) => scope.postMessage(r);
  try {
    // cooperative cancellation: operations poll this between chunks of work
    const result = (ops[m.op as OpName] as (i: unknown, c: () => boolean) => unknown)(m.payload, () => cancelledIds.has(m.id));
    respond({ id: m.id, ok: true, result });
  } catch (err) {
    respond({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err), cancelled: cancelledIds.has(m.id) });
  } finally {
    cancelledIds.delete(m.id);
  }
};
