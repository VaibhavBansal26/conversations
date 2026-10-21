// `npm run eval:agent` prints the golden-case table and the metrics (skipped in a normal run). The harness takes any AiProvider (runEval(world, {provider}));
// the table here is for the offline rules agent: a real model has NOT been evaluated with it.
import { it } from "vitest";
import { evalWorld, failures, runEval } from "./evals/runEval.js";

it.skipIf(!process.env.EVAL_REPORT)("prints the agent evaluation", async () => {
  const w = await evalWorld();
  const { outcomes, metrics } = await runEval(w);
  const lines = outcomes.map((o) => `${o.pass ? "ok  " : "FAIL"} ${o.case.id.padEnd(12)} ${o.case.say.slice(0, 54).padEnd(56)} ${o.detail}`);
  process.stdout.write(`\n${lines.join("\n")}\n\n${JSON.stringify(metrics, null, 2)}\n${failures(metrics).length ? `Below the thresholds:\n- ${failures(metrics).join("\n- ")}` : "All thresholds met."}\n`);
  if (failures(metrics).length) throw new Error("below the thresholds");
});
