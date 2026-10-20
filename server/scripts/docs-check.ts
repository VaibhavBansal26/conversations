// Documentation drift checks. `npm run docs:check` (and tests/docs.test.ts, so `npm test` and CI run it too).
//  1. every relative markdown link resolves to a file, and every #anchor to a heading
//  2. every file under docs/ is listed in docs/README.md (ADRs in docs/adr/README.md)
//  3. every environment variable of the config schema is in docs/CONFIGURATION.md and vice versa; the file equals a fresh generation
//  4. docs/openapi.json, docs/API.md, docs/RATE-LIMITING.md tables, docs/analytics-api/*, docs/REALTIME.md events are not stale
//  5. every Mermaid block parses
//  6. every route has an API entry and every socket event (client and server direction) is documented; every permission is in docs/RBAC.md
//  7. CHANGELOG.md has an Unreleased section
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, "..");
const root = resolve(server, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "dist" || f.startsWith(".git") && f !== ".github") continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const stripCode = (md: string) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
export const slug = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

function anchorsOf(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const m of stripCode(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]!.replace(/[*_`[\]]/g, "").replace(/\(([^)]*)\)/g, "($1)"));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of md.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) out.add(m[1]!);
  return out;
}

export function checkLinks(problems: string[]): void {
  const files = [
    ...["README.md", "CONTRIBUTING.md", "CHANGELOG.md", ".github/PULL_REQUEST_TEMPLATE.md"].map((f) => join(root, f)).filter(existsSync),
    ...walk(join(root, "docs")).filter((f) => f.endsWith(".md")),
    ...["loadtest", "deploy", "edge"].flatMap((d) => (existsSync(join(root, d)) ? walk(join(root, d)).filter((f) => f.endsWith(".md")) : [])),
  ];
  const cache = new Map<string, Set<string>>();
  const anchors = (f: string) => cache.get(f) ?? cache.set(f, anchorsOf(readFileSync(f, "utf8"))).get(f)!;
  for (const f of files) {
    const text = stripCode(readFileSync(f, "utf8"));
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      if (/^(https?:|mailto:|tel:|data:)/.test(target)) continue;
      const [pathPart, hash] = target.split("#") as [string, string | undefined];
      const dest = pathPart ? resolve(dirname(f), pathPart) : f;
      const rel = relative(root, f);
      if (!existsSync(dest)) {
        problems.push(`${rel}: broken link ${target}`);
        continue;
      }
      if (hash && dest.endsWith(".md") && !anchors(dest).has(hash.toLowerCase())) problems.push(`${rel}: missing anchor ${target}`);
    }
  }
}

export function checkIndex(problems: string[]): void {
  const docs = join(root, "docs");
  const index = readFileSync(join(docs, "README.md"), "utf8");
  const adrIndex = readFileSync(join(docs, "adr", "README.md"), "utf8");
  for (const f of readdirSync(docs)) {
    const p = join(docs, f);
    if (f === "README.md") continue;
    if (statSync(p).isDirectory()) {
      if (!index.includes(`${f}/`)) problems.push(`docs/README.md does not mention the directory docs/${f}/`);
    } else if (!index.includes(`(${f})`) && !index.includes(`(${f}#`)) problems.push(`docs/README.md does not link docs/${f}`);
  }
  for (const f of readdirSync(join(docs, "adr"))) if (f !== "README.md" && f.endsWith(".md") && !adrIndex.includes(f)) problems.push(`docs/adr/README.md does not link ${f}`);
}

export function checkChangelog(problems: string[]): void {
  const p = join(root, "CHANGELOG.md");
  if (!existsSync(p)) return void problems.push("CHANGELOG.md is missing");
  if (!/^## \[?Unreleased\]?/im.test(readFileSync(p, "utf8"))) problems.push("CHANGELOG.md has no Unreleased section");
}

export async function checkMermaid(problems: string[]): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  const mermaid = (await import("mermaid")).default;
  const files = [join(root, "README.md"), ...walk(join(root, "docs")).filter((f) => f.endsWith(".md"))];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    let i = 0;
    for (const m of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
      i++;
      try {
        await mermaid.parse(m[1]!);
      } catch (e) {
        problems.push(`${relative(root, f)}: mermaid block ${i} does not parse: ${String((e as Error).message).split("\n")[0]}`);
      }
    }
  }
}

function runScript(script: string, args: string[], problems: string[], label: string) {
  try {
    execFileSync(process.execPath, ["--import", "tsx", join(server, "scripts", script), ...args], { cwd: server, stdio: "pipe", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    problems.push(`${label} is stale or failed: ${(err.stderr?.toString() || err.stdout?.toString() || "").trim().split("\n").slice(-3).join(" | ")}`);
  }
}

export async function checkConfig(problems: string[]): Promise<void> {
  const { configSchema } = await import("../src/config.js");
  const { renderConfigDoc } = await import("./gen-config-doc.js");
  const doc = readFileSync(join(root, "docs", "CONFIGURATION.md"), "utf8");
  const inDoc = new Set([...doc.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]!));
  const inSchema = new Set(Object.keys(configSchema.shape));
  for (const v of inSchema) if (!inDoc.has(v)) problems.push(`docs/CONFIGURATION.md lacks ${v}`);
  for (const v of inDoc) if (!inSchema.has(v)) problems.push(`docs/CONFIGURATION.md documents ${v}, which is not in the config schema`);
  const example = readFileSync(join(root, ".env.example"), "utf8");
  for (const m of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) if (!inSchema.has(m[1]!) && !m[1]!.startsWith("OTEL_")) problems.push(`.env.example sets ${m[1]}, which is not in the config schema`);
  try {
    if (renderConfigDoc() !== doc) problems.push("docs/CONFIGURATION.md is stale (run `npm run docs:config`)");
  } catch (e) {
    problems.push((e as Error).message);
  }
}

export async function checkApi(problems: string[]): Promise<void> {
  const { buildOpenApi, renderApiDoc } = await import("./gen-api-doc.js");
  const { API_META } = await import("../src/apidoc/meta.js");
  const { ROUTE_ACCESS } = await import("../src/authz/routePerms.js");
  const { createContext, closeContext } = await import("../src/app-context.js");
  const { createApp } = await import("../src/app.js");
  const { loadConfig } = await import("../src/config.js");
  const { silentLogger } = await import("../src/logger.js");
  const ctx = await createContext(loadConfig({ NODE_ENV: "test", JWT_SECRET: "docs-check-docs-check-docs-check", DATABASE_PATH: ":memory:", DATA_DIR: join(root, "server", "data-docs-check"), WEB_DIST: join(root, "server", "data-docs-check", "no-web"), LOG_LEVEL: "silent", MESSAGE_HASH_PARTITIONS: "2" }, () => {}), { log: silentLogger });
  try {
    const registered = new Set(createApp(ctx).routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
    const exempt = new Set(["GET /healthz", "GET /readyz", "GET /metrics"]);
    for (const r of registered) if (!exempt.has(r) && !API_META.has(r)) problems.push(`route without an API doc entry (server/src/apidoc/meta.ts): ${r}`);
    for (const k of API_META.keys()) {
      if (!registered.has(k)) problems.push(`API doc entry for a route that does not exist: ${k}`);
      if (!ROUTE_ACCESS.has(k)) problems.push(`API doc entry without an authorisation rule: ${k}`);
    }
  } finally {
    await closeContext(ctx);
  }
  const apiDoc = readFileSync(join(root, "docs", "API.md"), "utf8");
  const intro = readFileSync(join(server, "src", "apidoc", "intro.md"), "utf8");
  if (renderApiDoc(intro) !== apiDoc) problems.push("docs/API.md is stale (run `npm run docs:api`)");
  if (JSON.stringify(buildOpenApi(), null, 2) + "\n" !== readFileSync(join(root, "docs", "openapi.json"), "utf8")) problems.push("docs/openapi.json is stale (run `npm run docs:api`)");
}

export async function checkRealtime(problems: string[]): Promise<void> {
  const { applyTable } = await import("./gen-realtime-doc.js");
  const doc = readFileSync(join(root, "docs", "REALTIME.md"), "utf8");
  if (applyTable(doc) !== doc) problems.push("docs/REALTIME.md client events table is stale (run `npm run docs:realtime`)");
  // every event the server emits must have a row in the server-to-client table
  const emitted = new Set<string>();
  for (const f of walk(join(server, "src")).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:\.emit|toRoom|toWorkspace|toMember|toVisitor)\([^;]*?"([a-z]+(?::[a-z_]+)?)"/g)) emitted.add(m[1]!);
    for (const m of src.matchAll(/event: "([a-z]+:[a-z_]+)"(?: \| "([a-z]+:[a-z_]+)")?/g)) (emitted.add(m[1]!), m[2] && emitted.add(m[2]));
  }
  for (const e of emitted) if (/^[a-z]+:[a-z_]+$|^typing$/.test(e) && !doc.includes(`\`${e}\``)) problems.push(`docs/REALTIME.md does not document the server event ${e}`);
}

export async function checkPermissions(problems: string[]): Promise<void> {
  const { ALL_PERMISSIONS } = await import("../src/authz/permissions.js");
  const rbac = readFileSync(join(root, "docs", "RBAC.md"), "utf8");
  for (const p of ALL_PERMISSIONS) if (!rbac.includes(`\`${p}\``)) problems.push(`docs/RBAC.md does not document the permission ${p}`);
}

export async function runDocsChecks(opts: { slow?: boolean } = {}): Promise<string[]> {
  const problems: string[] = [];
  checkLinks(problems);
  checkIndex(problems);
  checkChangelog(problems);
  await checkConfig(problems);
  await checkApi(problems);
  await checkRealtime(problems);
  await checkPermissions(problems);
  await checkMermaid(problems);
  if (opts.slow !== false) {
    runScript("gen-analytics-schemas.ts", ["--check"], problems, "docs/analytics-api");
    runScript("gen-ratelimit-doc.ts", ["--check"], problems, "docs/RATE-LIMITING.md policy table");
  }
  return problems;
}

if (process.argv[1]?.endsWith("docs-check.ts")) {
  const problems = await runDocsChecks();
  if (problems.length) {
    console.error(`docs:check found ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("docs:check ok");
  process.exit(0);
}
