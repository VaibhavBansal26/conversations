import { execFileSync } from "node:child_process";

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p90: percentile(s, 90), p99: percentile(s, 99), max: s.length ? s[s.length - 1] : null };
}

/** `ps` cputime is cumulative ("m:ss.ss" or "h:mm:ss"), so deltas give a true CPU% instead of the decayed lifetime average. */
function parseCpu(t) {
  const parts = t.trim().split(":").map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs;
}
export function psSample(pid) {
  try {
    const out = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const [rss, time] = out.split(/\s+/);
    return { rssMb: Number(rss) / 1024, cpuSecs: parseCpu(time) };
  } catch {
    return null;
  }
}

/** Samples RSS and CPU of a set of processes once a second; `report()` returns peak RSS and average/peak CPU% over the window. */
export class ResourceSampler {
  constructor(procs) {
    this.procs = procs; // [{name, pid}]
    this.data = new Map(procs.map((p) => [p.name, { rss: [], cpu: [], last: null, lastAt: 0 }]));
  }
  start(everyMs = 1000) {
    this.timer = setInterval(() => this.tick(), everyMs);
    this.tick();
  }
  tick() {
    const now = Date.now();
    for (const p of this.procs) {
      const s = psSample(p.pid);
      if (!s) continue;
      const d = this.data.get(p.name);
      d.rss.push(s.rssMb);
      if (d.last != null) d.cpu.push(((s.cpuSecs - d.last) / ((now - d.lastAt) / 1000)) * 100);
      d.last = s.cpuSecs;
      d.lastAt = now;
    }
  }
  stop() {
    clearInterval(this.timer);
  }
  reset() {
    for (const d of this.data.values()) {
      d.rss = [];
      d.cpu = [];
    }
  }
  report() {
    const out = {};
    for (const [name, d] of this.data) {
      const avg = d.cpu.length ? d.cpu.reduce((a, b) => a + b, 0) / d.cpu.length : 0;
      out[name] = { rss_peak_mb: Math.round(Math.max(0, ...d.rss)), cpu_avg_pct: Math.round(avg), cpu_peak_pct: Math.round(Math.max(0, ...d.cpu)) };
    }
    return out;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
