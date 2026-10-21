// Keeps the client-to-server event table of docs/REALTIME.md in step with the event registry (EVENT_ACCESS / EVENT_LIMITS) and the zod payload schemas.
//   npx tsx scripts/gen-realtime-doc.ts          rewrite the table between the markers
//   npx tsx scripts/gen-realtime-doc.ts --check  exit 1 when it is stale
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { EVENT_ACCESS } from "../src/authz/routePerms.js";
import { EVENT_LIMITS } from "../src/ratelimit/routePolicies.js";
import * as S from "../src/schemas.js";

export const PAYLOADS: Record<string, z.ZodType | null> = {
  "message:send": S.SendMessageBody.extend({ room_id: S.id }),
  "message:read": S.ReadBody.extend({ room_id: S.id }),
  "room:create": S.RoomCreate.omit({ message: true }),
  "room:update": S.RoomPatch.extend({ room_id: S.id }),
  "room:assign": S.AssignBody.extend({ room_id: S.id }),
  typing: S.TypingBody,
  "otp:verify": S.OtpVerify,
  "presence:list": null,
  "team:message:send": S.TeamSocketSend,
  "team:typing": S.TeamSocketTyping,
  "team:read": S.TeamSocketRead,
  "team:reaction": S.TeamSocketReaction,
};
const WHO: Record<string, string> = { "message:send": "team, visitor", "message:read": "team, visitor", "room:create": "team, visitor", "room:update": "team", "room:assign": "team", typing: "team, visitor", "otp:verify": "visitor", "presence:list": "team", "team:message:send": "team", "team:typing": "team", "team:read": "team", "team:reaction": "team" };

const fields = (s: z.ZodType | null) => {
  if (!s) return "none";
  const j = z.toJSONSchema(s, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as { properties?: Record<string, { type?: string }>; required?: string[] };
  const req = new Set(j.required ?? []);
  return Object.keys(j.properties ?? {}).map((k) => `\`${k}${req.has(k) ? "*" : ""}\``).join(", ");
};

export function renderEventTable(): string {
  const names = Object.keys(EVENT_ACCESS);
  for (const n of names) if (!(n in PAYLOADS) || !EVENT_LIMITS[n] || !WHO[n]) throw new Error(`event ${n} is missing from gen-realtime-doc.ts or EVENT_LIMITS`);
  const rows = names.map((n) => {
    const a = EVENT_ACCESS[n]!;
    return `| \`${n}\` | ${WHO[n]} | ${a === "visitor-only" ? "visitor session" : `\`${a}\``} | ${EVENT_LIMITS[n]!.cost} | ${fields(PAYLOADS[n]!)} |`;
  });
  return `| Event | Who | Needs | Cost | Payload (\`*\` = required) |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}`;
}

const BEGIN = "<!-- BEGIN:client-events -->";
const END = "<!-- END:client-events -->";
export function applyTable(doc: string): string {
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < 0) throw new Error("docs/REALTIME.md lacks the client-events markers");
  return `${doc.slice(0, a + BEGIN.length)}\n${renderEventTable()}\n${doc.slice(b)}`;
}

if (process.argv[1]?.endsWith("gen-realtime-doc.ts")) {
  const p = new URL("../../docs/REALTIME.md", import.meta.url);
  const cur = readFileSync(p, "utf8");
  const next = applyTable(cur);
  if (process.argv.includes("--check")) {
    if (cur !== next) (console.error("stale: docs/REALTIME.md client events table (run `npm run docs:realtime`)"), process.exit(1));
  } else writeFileSync(p, next);
}
