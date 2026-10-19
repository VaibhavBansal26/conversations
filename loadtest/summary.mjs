// node summary.mjs results/x.json : the numbers that matter, one screen
import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
console.log(d.scenario, d.config && JSON.stringify(d.config));
if (d.error) console.log("ERROR", d.error.split("\n")[0]);
for (const k of ["delivery_check", "idempotency", "storm", "slow", "drain", "note", "rest", "resources", "server"]) if (d[k]) console.log(k, JSON.stringify(d[k]));
if (d.final) console.log("final", JSON.stringify(pick(d.final, ["open", "target", "delivery", "ack", "connect", "connectErrors", "error_kinds", "sendErr", "acksTimeout", "reconnects"])));
if (d.steps) console.log("steps", JSON.stringify(d.steps));
