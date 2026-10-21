// Generates docs/openapi.json and docs/API.md from the route declarations (apidoc/meta.ts), the authorisation table, the rate-limit table and the zod
// schemas of the request bodies and queries.
//   npx tsx scripts/gen-api-doc.ts          write
//   npx tsx scripts/gen-api-doc.ts --check  exit 1 when the committed files are stale
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { API_META } from "../src/apidoc/meta.js";
import { ROUTE_ACCESS } from "../src/authz/routePerms.js";
import { ROUTE_LIMITS } from "../src/ratelimit/routePolicies.js";

type Json = Record<string, any>;
const toSchema = (s: z.ZodType): Json => {
  const j = z.toJSONSchema(s, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Json;
  delete j.$schema;
  return j;
};
const oasPath = (p: string) => p.replace(/:([A-Za-z]+)/g, "{$1}").replace(/\/\*$/, "/{path}");
const params = (p: string) => [...p.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
const securityOf = (a: string) => (a === "public" ? [] : a === "apikey" ? [{ apiKey: [] }] : a === "platform" ? [{ adminToken: [] }] : [{ bearer: [] }]);

export function buildOpenApi(): Json {
  const paths: Json = {};
  for (const [key, meta] of API_META) {
    const [method, path] = key.split(" ") as [string, string];
    const access = ROUTE_ACCESS.get(key)!;
    const limits = ROUTE_LIMITS.get(key);
    const op: Json = {
      tags: [meta.tag],
      summary: meta.summary,
      operationId: `${method.toLowerCase()}_${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      security: securityOf(access),
      "x-access": access,
      "x-rate-limit": limits ? { pre: limits.pre ?? [], post: limits.post ?? [], in_handler: limits.inHandler ?? [] } : null,
      parameters: [
        ...params(path).map((n) => ({ name: n, in: "path", required: true, schema: { type: "string" } })),
        ...(meta.query
          ? Object.entries((toSchema(meta.query).properties ?? {}) as Json).map(([name, schema]) => ({ name, in: "query", required: ((toSchema(meta.query!).required as string[]) ?? []).includes(name), schema }))
          : []),
      ],
      responses: {
        [String(meta.status ?? 200)]: { description: meta.returns ?? (meta.status === 204 ? "No content" : "Success"), ...(meta.status === 204 ? {} : { content: { [meta.media ?? "application/json"]: { schema: meta.media ? { type: "string" } : { type: "object" } } } }) },
        ...(access === "public" ? {} : { "401": { $ref: "#/components/responses/Error" }, ...(access === "apikey" ? {} : { "403": { $ref: "#/components/responses/Error" } }) }),
        ...(meta.body || meta.query ? { "400": { $ref: "#/components/responses/Error" } } : {}),
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    };
    if (!op.parameters.length) delete op.parameters;
    if (meta.body) op.requestBody = { required: true, content: { "application/json": { schema: toSchema(meta.body) } } };
    (paths[oasPath(path)] ??= {})[method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Conversations API", version: "1.0.0", description: "Generated from the route declarations. See docs/API.md for conventions, examples and the Socket.IO protocol (docs/REALTIME.md)." },
    servers: [{ url: "http://localhost:3000" }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Access token from /api/auth/login (15 minutes, renew with /api/auth/refresh)" },
        apiKey: { type: "http", scheme: "bearer", description: "Workspace API key `ca_live_...` (analytics API)" },
        adminToken: { type: "http", scheme: "bearer", description: "Platform admin token from /admin/api/mfa/verify (30 minutes)" },
      },
      responses: {
        Error: { description: "Error", content: { "application/json": { schema: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } } } } } },
        RateLimited: { description: "Rate limited. `Retry-After` (seconds) and `RateLimit` and `X-RateLimit-*` headers say when to retry.", headers: { "Retry-After": { schema: { type: "integer" } } }, content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { const: "RATE_LIMITED" }, policy: { type: "string" }, retry_after_s: { type: "integer" } } } } } } } },
      },
    },
  };
}

/**
 * The public subset for native apps and other direct clients: the visitor routes under /public, with the headers they need.
 * docs/openapi-public.json, described in docs/MOBILE-API.md.
 */
export function buildPublicOpenApi(): Json {
  const full = buildOpenApi();
  const paths: Json = {};
  const sessionHeaders = [
    { name: "x-support-session", in: "header", required: true, schema: { type: "string" }, description: "The `session_token` returned by POST /public/sessions" },
    { name: "x-device-id", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" }, description: "Stable per-install id (8-64 characters of A-Z a-z 0-9 _ -)" },
  ];
  for (const [key] of API_META) {
    const [method, path] = key.split(" ") as [string, string];
    if (!path.startsWith("/public/") || ROUTE_ACCESS.get(key) !== "public") continue;
    const op = structuredClone(full.paths[oasPath(path)][method.toLowerCase()]) as Json;
    delete op.security;
    delete op["x-access"];
    const hasSession = path !== "/public/widget/config" && path !== "/public/sessions";
    op.security = [{ embedToken: [] }];
    op.parameters = [
      { name: "x-api-key", in: "header", required: true, schema: { type: "string", pattern: "^cvt_" }, description: "The embed token (public by design; it is in every website's HTML)" },
      { name: "x-hosted-chat", in: "header", required: false, schema: { const: "1" }, description: "Native apps and same-origin pages send `1` (and no Origin) with a token that has the hosted chat enabled" },
      ...(path === "/public/widget/config" ? [] : [{ name: "x-device-id", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" } }]),
      ...(hasSession ? [sessionHeaders[0]] : []),
      ...(op.parameters ?? []),
    ];
    if (path === "/public/attachments") {
      op.requestBody = { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary", description: "PNG, JPEG, GIF, WebP or PDF; the content is sniffed, the extension must match" } } } } } };
    }
    (paths[oasPath(path)] ??= {})[method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Conversations public (visitor) API",
      version: "1.0.0",
      description: "The REST subset a native app can call directly instead of using the hosted chat web view. Real time is Socket.IO (namespace `/ws/<workspace_id>`, see docs/REALTIME.md). Guide: docs/MOBILE-API.md. Generated; do not edit.",
    },
    servers: [{ url: "https://YOUR-APP.example.com" }],
    paths,
    components: {
      securitySchemes: { embedToken: { type: "apiKey", in: "header", name: "x-api-key", description: "Embed token `cvt_...`. Requests from a native app have no browser Origin; use the hosted chat's origin rules or a token created for the app (docs/MOBILE-API.md#tokens-and-origin)." } },
      responses: full.components.responses,
    },
  };
}

const fields = (s: z.ZodType | undefined): string => {
  if (!s) return "";
  const j = toSchema(s);
  const req = new Set((j.required as string[]) ?? []);
  return Object.entries((j.properties ?? {}) as Json)
    .map(([k, v]) => `\`${k}${req.has(k) ? "*" : ""}\`${v.enum ? ` (${v.enum.join("\\|")})` : v.type && v.type !== "string" ? ` (${Array.isArray(v.type) ? v.type.join("\\|") : v.type})` : ""}`)
    .join(", ");
};

export function renderApiDoc(intro: string): string {
  const tags = new Map<string, string[]>();
  for (const [key, meta] of API_META) {
    const access = ROUTE_ACCESS.get(key)!;
    const l = ROUTE_LIMITS.get(key);
    const pol = l ? [...(l.pre ?? []), ...(l.post ?? []), ...(l.inHandler ?? [])].filter((p) => p !== "api.workspace") : [];
    const [m, p] = key.split(" ");
    const input = [meta.body ? `body: ${fields(meta.body)}` : "", meta.query ? `query: ${fields(meta.query)}` : ""].filter(Boolean).join("<br>");
    const row = `| \`${m} ${p}\` | ${meta.summary} | ${access === "public" ? "public" : access === "apikey" ? "API key" : access === "platform" ? "operator" : access === "authed" ? "signed in" : `\`${access}\``} | ${input} | ${pol.map((x) => `\`${x}\``).join(" ")} |`;
    (tags.get(meta.tag) ?? tags.set(meta.tag, []).get(meta.tag)!).push(row);
  }
  const sections = [...tags.entries()].map(([t, rows]) => `### ${t}\n\n| Route | What it does | Access | Request (\`*\` = required) | Rate-limit policies |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`).join("\n");
  return `${intro.trimEnd()}\n\n## Reference\n\n<!-- Generated by \`npm run docs:api\` from server/src/apidoc/meta.ts, the authorisation table, the rate-limit table and the zod schemas. Do not edit below this line. -->\n\n${API_META.size} routes. The same content in machine-readable form: [openapi.json](openapi.json). Field types and limits are in the OpenAPI schemas; the policy ids are explained in [RATE-LIMITING.md](RATE-LIMITING.md).\n\n${sections}`;
}

if (process.argv[1]?.endsWith("gen-api-doc.ts")) {
  const dir = new URL("../../docs/", import.meta.url);
  const intro = readFileSync(new URL("../src/apidoc/intro.md", import.meta.url), "utf8");
  const files: Record<string, string> = { "openapi.json": JSON.stringify(buildOpenApi(), null, 2) + "\n", "API.md": renderApiDoc(intro), "openapi-public.json": JSON.stringify(buildPublicOpenApi(), null, 2) + "\n" };
  let bad = 0;
  for (const [f, body] of Object.entries(files)) {
    const p = new URL(f, dir);
    if (process.argv.includes("--check")) {
      if (!existsSync(p) || readFileSync(p, "utf8") !== body) (console.error(`stale: docs/${f} (run \`npm run docs:api\`)`), bad++);
    } else writeFileSync(p, body);
  }
  if (process.argv.includes("--check")) process.exit(bad ? 1 : 0);
  console.log(`wrote docs/openapi.json, docs/openapi-public.json and docs/API.md (${API_META.size} routes)`);
}
