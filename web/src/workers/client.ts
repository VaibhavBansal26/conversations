import { ops } from "./ops";
import type { OpName, Ops, WorkerRequest, WorkerResponse } from "./protocol";

export interface RunOptions {
  signal?: AbortSignal;
  /** below this payload size the round trip costs more than the work: run inline */
  inlineBelow?: number;
  size?: number;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export type WorkerFactory = () => Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

/**
 * Typed client for the background worker. Falls back to running the same operations inline when Workers are unavailable,
 * fail to start, or crash (the UI then simply does the work on the main thread, as it would without this module).
 */
export class WorkerClient {
  private worker: ReturnType<WorkerFactory> | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private broken = false;

  constructor(private readonly factory: WorkerFactory | null) {}

  get usingWorker(): boolean {
    return !!this.worker && !this.broken;
  }

  private ensure(): ReturnType<WorkerFactory> | null {
    if (this.broken || !this.factory) return null;
    if (this.worker) return this.worker;
    try {
      const w = this.factory();
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const r = e.data;
        const p = this.pending.get(r.id);
        if (!p) return;
        this.pending.delete(r.id);
        if (r.ok) p.resolve(r.result);
        else p.reject(r.cancelled ? new CancelledError() : new Error(r.error));
      };
      w.onerror = () => this.fail();
      this.worker = w;
      return w;
    } catch {
      this.broken = true;
      return null;
    }
  }

  /** The worker died: give up on it for good and let every waiting caller retry inline. */
  private fail() {
    this.broken = true;
    this.worker?.terminate();
    this.worker = null;
    for (const [, p] of this.pending) p.reject(new Error("worker failed"));
    this.pending.clear();
  }

  async run<K extends OpName>(op: K, input: Ops[K]["in"], opts: RunOptions = {}): Promise<Ops[K]["out"]> {
    if (opts.signal?.aborted) throw new CancelledError();
    const inline = () => {
      if (opts.signal?.aborted) throw new CancelledError();
      return ops[op](input as never, () => !!opts.signal?.aborted) as Ops[K]["out"];
    };
    const worker = (opts.size ?? Infinity) < (opts.inlineBelow ?? 0) ? null : this.ensure();
    if (!worker) return inline();
    const id = ++this.seq;
    try {
      return await new Promise<Ops[K]["out"]>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        const onAbort = () => {
          worker.postMessage({ id, op: "cancel" } satisfies WorkerRequest);
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        worker.postMessage({ id, op, payload: input } satisfies WorkerRequest);
      });
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (opts.signal?.aborted) throw new CancelledError();
      return inline(); // worker failure: same answer, computed here
    } finally {
      this.pending.delete(id);
    }
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
  }
}

let shared: WorkerClient | null = null;

/** App-wide client. The worker file is a separate Vite chunk, created on first use. */
export function getWorkerClient(): WorkerClient {
  if (!shared) {
    const canUse = typeof Worker !== "undefined";
    shared = new WorkerClient(canUse ? () => new Worker(new URL("./app.worker.ts", import.meta.url), { type: "module" }) : null);
  }
  return shared;
}

export function setWorkerClientForTests(c: WorkerClient | null) {
  shared = c;
}
