import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { taskImpl, type TaskName, type Tasks } from "./tasks.js";

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Slot {
  worker: Worker;
  busy: Map<number, Pending>;
}

export interface PoolStats {
  size: number;
  queued: number;
  inFlight: number;
  completed: number;
  restarts: number;
}

/**
 * A small worker_threads pool for CPU-bound tasks that would otherwise stall the event loop (sanitising multi-hundred-KB email
 * bodies). Tasks go to the least-loaded worker; a crashed or timed-out worker is replaced and its tasks fail over to inline execution,
 * so the pool can only ever make things slower, never lose work. `size: 0` disables threads and runs everything inline.
 */
export class WorkerPool {
  private slots: Slot[] = [];
  private seq = 0;
  private completed = 0;
  private restarts = 0;
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly opts: { timeoutMs?: number; maxInFlightPerWorker?: number } = {},
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const js = fileURLToPath(new URL("./entry.js", import.meta.url));
    const compiled = existsSync(js);
    const worker = compiled
      ? new Worker(js)
      : new Worker(fileURLToPath(new URL("./entry.ts", import.meta.url)), { execArgv: ["--import", "tsx"] }); // running from source (dev, tests)
    const slot: Slot = { worker, busy: new Map() };
    worker.unref();
    worker.on("message", (m: { id: number; ok: boolean; out?: unknown; error?: string }) => {
      const p = slot.busy.get(m.id);
      if (!p) return;
      slot.busy.delete(m.id);
      clearTimeout(p.timer);
      this.completed++;
      if (m.ok) p.resolve(m.out);
      else p.reject(new Error(m.error));
    });
    const fail = (err: Error) => {
      for (const [, p] of slot.busy) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      slot.busy.clear();
      if (!this.closed) {
        this.restarts++;
        const i = this.slots.indexOf(slot);
        if (i >= 0) this.slots[i] = this.spawn();
      }
    };
    worker.on("error", fail);
    // any exit of a worker we still depend on (crash, OOM, our own terminate after a timeout) means: replace it
    worker.on("exit", (code) => {
      if (!this.closed && this.slots.includes(slot)) fail(new Error(`worker exited with ${code}`));
    });
    return slot;
  }

  stats(): PoolStats {
    return { size: this.size, queued: 0, inFlight: this.slots.reduce((n, s) => n + s.busy.size, 0), completed: this.completed, restarts: this.restarts };
  }

  /** Run a task on a worker; falls back to inline execution if the pool is off, saturated, or the worker fails. */
  async run<K extends TaskName>(task: K, input: Tasks[K]["in"]): Promise<Tasks[K]["out"]> {
    const inline = () => taskImpl[task](input);
    if (!this.size || this.closed) return inline();
    const slot = this.slots.reduce((a, b) => (a.busy.size <= b.busy.size ? a : b));
    if (slot.busy.size >= (this.opts.maxInFlightPerWorker ?? 8)) return inline(); // backpressure: never queue unbounded work behind a busy thread
    const id = ++this.seq;
    try {
      return (await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          slot.busy.delete(id);
          reject(new Error("worker task timed out"));
          void slot.worker.terminate(); // 'exit' handler replaces it
        }, this.opts.timeoutMs ?? 10_000);
        slot.busy.set(id, { resolve, reject, timer });
        slot.worker.postMessage({ id, task, input });
      })) as Tasks[K]["out"];
    } catch {
      return inline();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots = [];
  }
}
