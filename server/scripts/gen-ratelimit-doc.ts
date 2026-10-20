// Renders the policy table of docs/RATE-LIMITING.md from src/ratelimit/policies.ts so the doc cannot drift from the code.
//   npx tsx scripts/gen-ratelimit-doc.ts           rewrite the generated block
//   npx tsx scripts/gen-ratelimit-doc.ts --check   exit 1 when the doc is stale (used by docs:check / CI)
import { readFileSync, writeFileSync } from "node:fs";
import { POLICIES } from "../src/ratelimit/policies.js";
import { EVENT_LIMITS, ROUTE_LIMITS } from "../src/ratelimit/routePolicies.js";

const START = "<!-- policies:start -->";
const END = "<!-- policies:end -->";
const file = new URL("../../docs/RATE-LIMITING.md", import.meta.url);

const per = (p: (typeof POLICIES)[number]) => {
  const unit = p.algo === "concurrency" ? "concurrent" : p.algo === "strike" ? `failures / ${fmt(p.windowSec)}` : `per ${fmt(p.windowSec)}`;
  const base = p.algo === "concurrency" ? `${p.limit} ${unit}` : p.algo === "strike" ? `${p.limit} ${unit}` : `${p.limit} ${unit}`;
  const burst = p.algo === "gcra" ? `, burst ${p.burst ?? p.limit}` : "";
  return base + burst;
};
const fmt = (s: number) => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

const usedBy = new Map<string, string[]>();
for (const [route, spec] of ROUTE_LIMITS) for (const id of [...(spec.pre ?? []), ...(spec.post ?? []), ...(spec.inHandler ?? [])]) usedBy.set(id, [...(usedBy.get(id) ?? []), route]);
for (const [ev, spec] of Object.entries(EVENT_LIMITS)) for (const id of spec.inHandler ?? []) usedBy.set(id, [...(usedBy.get(id) ?? []), `socket ${ev}`]);

const rows = POLICIES.map((p) => {
  const tiers = p.tiers ? Object.entries(p.tiers).map(([t, v]) => `${t} ${v}`).join(", ") : "-";
  const where = usedBy.get(p.id);
  const n = where ? (where.length > 3 ? `${where.length} entry points` : where.join(", ")) : "socket server / delivery";
  return `| \`${p.id}\` | ${p.keyBy} | ${p.algo} | ${per(p)} | ${tiers} | ${p.onFail === "closed" ? "fail-closed" : "fail-open"}${p.penalty ? " + penalty box" : ""}${p.lease ? " + lease" : ""} | ${p.description} (${n}) |`;
});
const events = Object.entries(EVENT_LIMITS).map(([e, s]) => `| \`${e}\` | ${s.cost} |`);
const block = `${START}
| Policy | Keyed by | Algorithm | Limit | Plan tiers | Failure mode | What it protects (where) |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

Socket event costs (per-socket bucket, \`ws.event\`):

| Event | Cost |
| --- | --- |
${events.join("\n")}
${END}`;

const cur = readFileSync(file, "utf8");
const a = cur.indexOf(START);
const b = cur.indexOf(END);
if (a < 0 || b < 0) throw new Error("markers missing in docs/RATE-LIMITING.md");
const next = cur.slice(0, a) + block + cur.slice(b + END.length);
if (process.argv.includes("--check")) {
  if (next !== cur) {
    console.error("docs/RATE-LIMITING.md policy table is stale: run `npx tsx scripts/gen-ratelimit-doc.ts` in server/");
    process.exit(1);
  }
} else writeFileSync(file, next);
