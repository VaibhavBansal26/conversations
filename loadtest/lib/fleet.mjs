import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, summarize } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** A set of load-generator processes. Items are dealt out round-robin so every process gets a mix of nodes. */
export class Fleet {
  constructor(workers) {
    this.workers = [];
    this.seq = 0;
    this.pending = new Map();
    this.count = workers;
  }
  async start() {
    await Promise.all(
      Array.from({ length: this.count }, async () => {
        // the machine's file table is shared with everything else running on it; a spawn can fail transiently with ENFILE
        for (let attempt = 0; ; attempt++) {
          try {
            const proc = fork(join(here, "conn-worker.mjs"), [], { execArgv: ["--max-old-space-size=3072"] });
            await new Promise((res, rej) => {
              proc.once("error", rej);
              proc.once("message", (m) => m.ready && res());
            });
            this.workers.push(proc);
            proc.on("message", (m) => {
              if (m.id != null) this.pending.get(m.id)?.(m);
            });
            return;
          } catch (e) {
            if (attempt >= 8) throw e;
            await sleep(1500);
          }
        }
      }),
    );
  }
  pids() {
    return this.workers.map((w, i) => ({ name: `gen${i}`, pid: w.pid }));
  }
  call(i, msg, timeout = 600000) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`worker ${i} timed out on ${msg.cmd}`)), timeout);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        this.pending.delete(id);
        m.ok ? resolve(m) : reject(new Error(m.error));
      });
      this.workers[i].send({ ...msg, id });
    });
  }
  all(msg, timeout) {
    return Promise.all(this.workers.map((_, i) => this.call(i, msg, timeout)));
  }
  /** Connect items (already containing url/wsId/kind) at a total rate across workers. */
  async connect(items, ratePerSec) {
    const slices = this.workers.map(() => []);
    items.forEach((it, i) => slices[i % this.count].push(it));
    await Promise.all(slices.map((slice, i) => this.call(i, { cmd: "connect", items: slice, ratePerSec: ratePerSec / this.count })));
  }
  async stats(reset = false) {
    const all = (await this.all({ cmd: "stats", reset })).map((r) => r.stats);
    const sum = (k) => all.reduce((a, s) => a + (s[k] ?? 0), 0);
    const keys = ["connected", "connectErrors", "disconnects", "reconnects", "recv", "recvTeam", "recvVisitor", "dup", "gap", "gapMsgs", "recovered", "resyncRequests", "resyncFailed", "sendUnique", "resent", "failovers", "sendOk", "sendErr", "sendCreatedFalse", "acksTimeout", "drained", "slowKicked", "auditMissing", "open", "total"];
    const out = Object.fromEntries(keys.map((k) => [k, sum(k)]));
    out.connectErrorSamples = {};
    for (const s of all) for (const [k, v] of Object.entries(s.connectErrorSamples)) out.connectErrorSamples[k] = (out.connectErrorSamples[k] ?? 0) + v;
    const merge = (f) => {
      const parts = all.map((s) => s[f]).filter((x) => x.n);
      const n = parts.reduce((a, x) => a + x.n, 0);
      if (!n) return { n: 0 };
      // weighted by sample count; max is exact, percentiles are the sample-weighted mean of per-process percentiles (close enough for similar processes)
      const w = (k) => Math.round(parts.reduce((a, x) => a + x[k] * x.n, 0) / n);
      return { n, p50: w("p50"), p90: w("p90"), p99: w("p99"), max: Math.max(...parts.map((x) => x.max)) };
    };
    out.delivery = merge("delivery");
    out.ack = merge("ack");
    out.connect = merge("connect");
    return out;
  }
  async close() {
    await this.all({ cmd: "close" }).catch(() => {});
    await sleep(300);
    for (const w of this.workers) w.kill("SIGKILL");
  }
}

export async function scrape(url) {
  try {
    const t = await (await fetch(`${url}/metrics`)).text();
    const val = (name, label) => {
      const re = new RegExp(`^${name}${label ? `\\{[^}]*${label}[^}]*\\}` : "(?:\\{[^}]*\\})?"} ([0-9.e+-]+)$`, "m");
      const m = t.match(re);
      return m ? Number(m[1]) : null;
    };
    const sumAll = (name) => [...t.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.e+-]+)$`, "gm"))].reduce((a, m) => a + Number(m[1]), 0);
    return {
      wsVisitors: val("conv_ws_connections", 'kind="visitor"'),
      wsTeam: val("conv_ws_connections", 'kind="team"'),
      slowDisconnects: sumAll("conv_ws_slow_consumer_disconnects_total"),
      loopLagP99Ms: (val("conv_event_loop_lag_p99_seconds") ?? 0) * 1000,
      rateLimited: sumAll("conv_rate_limited_total"),
      writeBufMax: val("conv_ws_write_buffer_max"),
    };
  } catch {
    return null;
  }
}

export { summarize };
