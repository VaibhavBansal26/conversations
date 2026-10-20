// Writes the analytics API JSON Schemas to docs/analytics-api/ (the contract artefacts consumers test against).
//   npx tsx scripts/gen-analytics-schemas.ts           write
//   npx tsx scripts/gen-analytics-schemas.ts --check   exit 1 when the committed files differ from the code
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { SCHEMAS, SCHEMA_VERSION } from "../src/analytics/schemas.js";

const dir = new URL("../../docs/analytics-api/", import.meta.url);
const files: Record<string, string> = {};
for (const [name, schema] of Object.entries(SCHEMAS)) files[`${name}.schema.json`] = JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }, null, 2) + "\n";
files["schema-version.json"] = JSON.stringify({ schema_version: SCHEMA_VERSION }, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let bad = 0;
  for (const [f, body] of Object.entries(files)) {
    const p = new URL(f, dir);
    if (!existsSync(p) || readFileSync(p, "utf8") !== body) {
      console.error(`stale: docs/analytics-api/${f}`);
      bad++;
    }
  }
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".json") && !(f in files)) { console.error(`unexpected: docs/analytics-api/${f}`); bad++; }
  process.exit(bad ? 1 : 0);
}
mkdirSync(dir, { recursive: true });
for (const [f, body] of Object.entries(files)) writeFileSync(new URL(f, dir), body);
console.log(`wrote ${Object.keys(files).length} files to docs/analytics-api/`);
