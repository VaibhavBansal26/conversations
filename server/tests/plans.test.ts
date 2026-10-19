import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/context.js";
import type { Param } from "../src/db/index.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { listContacts } from "../src/services/contacts.js";
import { pageMessages, searchMessages } from "../src/services/messages.js";
import { listNotifications } from "../src/services/notifications.js";
import { listRooms, roomCounts, unreadCount } from "../src/services/rooms.js";
import { collectDigests } from "../src/services/digest.js";
import { listMessagesForAgent } from "../src/services/messages.js";
import { addMemberRaw, fullApp, mkInbox } from "./helpers.js";

const ROOMS = 2000;
const PER_ROOM = 12;

/** Bulk-load a realistically sized workspace with multi-row inserts (service calls would take minutes). */
async function bigWorkspace() {
  const f = await fullApp();
  const { ctx, wsId, owner } = f;
  const agents = [];
  for (let i = 0; i < 3; i++) agents.push(await addMemberRaw(ctx, wsId, { name: `Agent${i}` }));
  const inboxA = await mkInbox(ctx, owner, { name: "A", member_ids: [agents[0]!.memberId, agents[1]!.memberId] });
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (n: number) => new Date(t0 + n * 60_000).toISOString();
  const batch = async (table: string, cols: string, rows: Param[][]) => {
    for (let i = 0; i < rows.length; i += 250) {
      const chunk = rows.slice(i, i + 250);
      await ctx.db.run(`INSERT INTO ${table}(${cols}) VALUES ${chunk.map((r) => `(${r.map(() => "?").join(",")})`).join(",")}`, ...chunk.flat());
    }
  };
  const contacts: Param[][] = [];
  const rooms: Param[][] = [];
  const assignees: Param[][] = [];
  const messages: Param[][] = [];
  for (let r = 0; r < ROOMS; r++) {
    const cid = `con_${String(r).padStart(6, "0")}`;
    const rid = `room_${String(r).padStart(6, "0")}`;
    contacts.push([cid, wsId, `Person ${r}`, `p${r}@example.test`, `+1415${String(5550000 + r)}`, "{}", "[]", iso(r), iso(r)]);
    rooms.push([rid, wsId, cid, r % 3 === 0 ? inboxA.id : null, r % 7 === 0 ? "closed" : "open", iso(r + 10), iso(r + 10), PER_ROOM, PER_ROOM, iso(r), iso(r)]);
    if (r % 2 === 0) assignees.push([rid, agents[r % 3]!.memberId, iso(r)]);
    for (let m = 1; m <= PER_ROOM; m++) {
      messages.push([`msg_${String(r).padStart(6, "0")}_${String(m).padStart(2, "0")}`, wsId, rid, m, m % 3 ? "contact" : "agent", m % 3 ? "Contact" : "Agent", "text", "dm", `hello number ${m} from room ${r}`, `hello number ${m} from room ${r}`, iso(r + m)]);
    }
  }
  await batch("contacts", "id, workspace_id, name, email, phone, attrs, tags, created_at, updated_at", contacts);
  await batch("rooms", "id, workspace_id, contact_id, inbox_id, status, last_message_at, last_contact_message_at, next_seq, last_message_seq, created_at, updated_at", rooms);
  await batch("room_assignees", "room_id, member_id, added_at", assignees);
  await batch("messages", "id, workspace_id, room_id, seq, sender_type, sender_name, kind, source, content, content_text, created_at", messages);
  await ctx.db.run("UPDATE rooms SET last_message_id = 'msg_' || substr(id, 6) || '_12'");
  if (ctx.db.dialect === "sqlite") await ctx.db.exec("ANALYZE");
  else await ctx.db.exec("ANALYZE");
  return { ...f, agents, inboxA };
}

/** Execute fn while recording every statement it issues. */
async function capture(ctx: AppContext, fn: () => Promise<unknown>) {
  const seen = new Map<string, Param[]>();
  ctx.db.trace = (sql, params) => void (/^\s*(SELECT|WITH)/i.test(sql) && !seen.has(sql) && seen.set(sql, params));
  try {
    await fn();
  } finally {
    ctx.db.trace = null;
  }
  return [...seen.entries()].map(([sql, params]) => ({ sql, params }));
}

/** Every table access must use an index; the main list statements (matched by `noSort`) must also come out of the index already ordered. */
const MAIN = { rooms: /FROM rooms r JOIN contacts c/, messages: /FROM messages WHERE room_id/, notifications: /FROM notifications WHERE member_id/, contacts: /SELECT c\.\* FROM contacts c/ };
async function expectIndexed(ctx: AppContext, label: string, statements: { sql: string; params: Param[] }[], opts: { noSort?: RegExp } = {}) {
  expect(statements.length, `${label}: captured no SQL`).toBeGreaterThan(0);
  for (const { sql, params } of statements) {
    const plan = await ctx.db.explain(sql, ...params);
    if (ctx.db.dialect === "sqlite") {
      const fullScans = plan.split("\n").filter((l) => /^\s*(\|--|`--)?\s*SCAN (?!CONSTANT)/.test(l) && !/USING (COVERING )?INDEX/.test(l));
      expect(fullScans, `${label}: full table scan in\n${sql}\n${plan}`).toEqual([]);
      if (opts.noSort?.test(sql)) expect(plan, `${label}: temp b-tree sort in\n${sql}\n${plan}`).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    } else {
      expect(plan, `${label}: sequential scan in\n${sql}\n${plan}`).not.toMatch(/Seq Scan/);
      if (opts.noSort?.test(sql)) expect(plan, `${label}: explicit sort in\n${sql}\n${plan}`).not.toMatch(/\bSort\b/);
    }
  }
}

describe("query plans of the hot paths (2,000 rooms, 24,000 messages)", () => {
  it("room list for an owner (newest, open) uses the list index and needs no sort", async () => {
    const w = await bigWorkspace();
    const stmts = await capture(w.ctx, () => listRooms(w.ctx, w.owner, { status: "open", sort: "newest", page: 1, limit: 30 }));
    await expectIndexed(w.ctx, "owner room list", stmts, { noSort: MAIN.rooms });
  }, 60_000);

  it("room list variants (agent scope, filters, other sorts) never scan whole tables", async () => {
    const w = await bigWorkspace();
    const agent = actorFromRow((await getMember(w.ctx, w.wsId, w.agents[0]!.memberId))!);
    for (const [label, actor, filters] of [
      ["agent scope", agent, { status: "open" as const, sort: "newest" as const }],
      ["assigned to me", agent, { status: "open" as const, assigned_to_me: true }],
      ["unassigned", w.owner, { status: "open" as const, unassigned: true }],
      ["closed", w.owner, { status: "closed" as const }],
      ["inbox filter", w.owner, { status: "open" as const, inbox_id: w.inboxA.id }],
      ["priority first", w.owner, { status: "open" as const, sort: "priority_first" as const }],
      ["waiting longest", w.owner, { status: "open" as const, sort: "waiting_longest" as const }],
    ] as const) {
      const stmts = await capture(w.ctx, () => listRooms(w.ctx, actor, { page: 1, limit: 30, ...filters }));
      await expectIndexed(w.ctx, label, stmts, { noSort: label === "waiting longest" || label === "unassigned" ? undefined : MAIN.rooms });
    }
  }, 120_000);

  it("unread count, message pages, message search scope, counts, notifications and digest candidates are index-driven", async () => {
    const w = await bigWorkspace();
    await expectIndexed(w.ctx, "unread", await capture(w.ctx, () => unreadCount(w.ctx, "room_000010", w.owner.memberId)));
    const page = await pageMessages(w.ctx, "room_000010", { limit: 30 });
    await expectIndexed(w.ctx, "messages newest", await capture(w.ctx, () => pageMessages(w.ctx, "room_000010", { limit: 30 })), { noSort: MAIN.messages });
    await expectIndexed(w.ctx, "messages before", await capture(w.ctx, () => pageMessages(w.ctx, "room_000010", { limit: 5, before: page.data[8]!.id })), { noSort: MAIN.messages });
    await expectIndexed(w.ctx, "messages after", await capture(w.ctx, () => pageMessages(w.ctx, "room_000010", { limit: 5, after: page.data[2]!.id })), { noSort: MAIN.messages });
    await expectIndexed(w.ctx, "agent message list", await capture(w.ctx, () => listMessagesForAgent(w.ctx, w.owner, "room_000010", { limit: 30 })));
    await expectIndexed(w.ctx, "counts", await capture(w.ctx, () => roomCounts(w.ctx, w.owner)), undefined);
    await expectIndexed(w.ctx, "notifications", await capture(w.ctx, () => listNotifications(w.ctx, w.owner, { limit: 30 })), { noSort: MAIN.notifications });
    await expectIndexed(w.ctx, "contacts list", await capture(w.ctx, () => listContacts(w.ctx, w.wsId, { limit: 25 })), { noSort: MAIN.contacts });
    await expectIndexed(w.ctx, "digest candidates", await capture(w.ctx, () => collectDigests(w.ctx)));
    // a room-scoped search is index-driven; the unscoped substring search is inherently a scan and deliberately not asserted
    await expectIndexed(w.ctx, "room search", await capture(w.ctx, () => searchMessages(w.ctx, w.owner, { q: "number 7", room_id: "room_000010", limit: 20 })));
  }, 120_000);

  it("inbound routing and delivery lookups hit unique/secondary indexes", async () => {
    const w = await bigWorkspace();
    const lookups: [string, string, Param[]][] = [
      ["contact by phone", "SELECT * FROM contacts WHERE workspace_id = ? AND phone = ? AND deleted_at IS NULL", [w.wsId, "+14155550010"]],
      ["contact by email", "SELECT * FROM contacts WHERE workspace_id = ? AND email IS NOT NULL AND lower(email) = ? AND deleted_at IS NULL", [w.wsId, "p10@example.test"]],
      ["sms lock route", "SELECT room_id FROM message_locks WHERE workspace_id = ? AND type = 'sms' AND from_addr = ? AND to_addr = ?", [w.wsId, "+1", "+2"]],
      ["message by rfc id", "SELECT room_id FROM messages WHERE workspace_id = ? AND rfc_message_id = ? LIMIT 1", [w.wsId, "<x@y>"]],
      ["message by provider id", "SELECT * FROM messages WHERE provider_message_id = ? AND source = 'sms'", ["SM1"]],
      ["due jobs", "SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?", ["2030-01-01", 50]],
      ["due snoozes", "SELECT * FROM rooms WHERE snooze_until IS NOT NULL AND snooze_until <= ? AND archived = 0 ORDER BY snooze_until LIMIT 200", ["2030-01-01"]],
      ["room by contact", "SELECT * FROM rooms WHERE workspace_id = ? AND contact_id = ? AND archived = 0", [w.wsId, "con_000010"]],
      ["unread notifications", "SELECT COUNT(*) FROM notifications WHERE member_id = ? AND read_at IS NULL", [w.owner.memberId]],
    ];
    for (const [label, sql, params] of lookups) await expectIndexed(w.ctx, label, [{ sql, params }]);
  }, 60_000);
});
