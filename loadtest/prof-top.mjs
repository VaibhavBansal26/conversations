// node prof-top.mjs file.cpuprofile [n] : self-time by function (top n)
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const self = new Map();
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = p.timeDeltas;
p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
const agg = new Map();
for (const [id, t] of self) {
  const n = byId.get(id).callFrame;
  const key = `${n.functionName || "(anon)"} ${n.url.replace(/^.*\/(server\/)?/, "").replace(/.*node_modules\//, "nm/")}:${n.lineNumber + 1}`;
  agg.set(key, (agg.get(key) ?? 0) + t);
}
const total = [...agg.values()].reduce((a, b) => a + b, 0);
for (const [k, t] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[3] ?? 25))) console.log(`${((t / total) * 100).toFixed(1).padStart(5)}%  ${(t / 1000).toFixed(0).padStart(6)}ms  ${k}`);
