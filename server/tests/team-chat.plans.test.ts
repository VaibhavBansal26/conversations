import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/context.js";
import type { Param } from "../src/db/index.js";
import { listChannels, listPins, listTeamMessages, searchTeam, getThread } from "../src/services/teamChat.js";
import { addMemberRaw, fullApp } from "./helpers.js";

const CHANNELS = 60;
const PER = 300;

async function bigTeam() {
  const f = await fullApp();
  const { ctx, wsId, owner } = f;
  const agent = await addMemberRaw(ctx, wsId, { name: "Ann", role: "agent" });
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (n: number) => new Date(t0 + n * 1000).toISOString();
  const batch = async (table: string, cols: string, rows: Param[][]) => {
    for (let i = 0; i < rows.length; i += 250) {
      const chunk = rows.slice(i, i + 250);
      await ctx.db.run(`INSERT INTO ${table}(${cols}) VALUES ${chunk.map((r) => `(${r.map(() => "?").join(",")})`).join(",")}`, ...chunk.flat());
    }
  };
  const channels: Param[][] = [];
  const members: Param[][] = [];
  const messages: Param[][] = [];
  for (let c = 0; c < CHANNELS; c++) {
    const cid = `tch_${String(c).padStart(6, "0")}`;
    channels.push([cid, wsId, "channel", c % 5 === 0 ? "private" : "public", `c${c}`, `c${c}`, PER, iso(c + PER), PER, iso(c)]);
    members.push([cid, owner.memberId, wsId, "owner", c % 2 ? PER : 0, iso(c)]);
    if (c % 3 === 0) members.push([cid, agent.memberId, wsId, "member", 0, iso(c)]);
    for (let m = 1; m <= PER; m++) {
      messages.push([`tmsg_${String(c).padStart(6, "0")}_${String(m).padStart(4, "0")}`, wsId, cid, m, m % 10 === 0 ? `tmsg_${String(c).padStart(6, "0")}_0001` : null, owner.memberId, "Olivia", "text", `hello number ${m} in c${c}`, `hello number ${m} in c${c}`, iso(c + m)]);
    }
  }
  await batch("team_channels", "id, workspace_id, kind, visibility, name, slug, next_seq, last_message_at, last_message_seq, created_at", channels);
  await batch("team_channel_members", "channel_id, member_id, workspace_id, role, last_read_seq, joined_at", members);
  await batch("team_messages", "id, workspace_id, channel_id, seq, thread_root_id, sender_id, sender_name, kind, content, content_text, created_at", messages);
  await ctx.db.exec("ANALYZE");
  return { ...f, agent };
}

async function capture(ctx: AppContext, fn: () => Promise<unknown>) {
  const seen = new Map<string, Param[]>();
  ctx.db.trace = (sql, params) => void (/^\s*(SELECT|WITH)/i.test(sql) && !seen.has(sql) && seen.set(sql, params));
  try {
    await fn();
  } finally {
    ctx.db.trace = null;
  }
  // only the team chat statements: the member directory (a few rows per workspace) is not what is being measured here
  return [...seen.entries()].filter(([sql]) => /team_/.test(sql)).map(([sql, params]) => ({ sql, params }));
}

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
      if (opts.noSort?.test(sql)) expect(plan, `${label}: explicit sort in\n${sql}\n${plan}`).not.toMatch(/^\s*(->\s+)?(Incremental )?Sort\s+\(/m);
    }
  }
}

describe(`query plans of team chat (${CHANNELS} channels, ${CHANNELS * PER} messages)`, () => {
  it("message pages and threads come out of the (channel, seq) indexes already ordered", async () => {
    const w = await bigTeam();
    const MAIN = /FROM team_messages WHERE channel_id/;
    await expectIndexed(w.ctx, "latest page", await capture(w.ctx, () => listTeamMessages(w.ctx, w.owner, "tch_000001", { limit: 30 })), { noSort: MAIN });
    const page = await listTeamMessages(w.ctx, w.owner, "tch_000001", { limit: 30 });
    await expectIndexed(w.ctx, "older page", await capture(w.ctx, () => listTeamMessages(w.ctx, w.owner, "tch_000001", { limit: 30, before: page.pagination.before_cursor! })), { noSort: MAIN });
    await expectIndexed(w.ctx, "newer page", await capture(w.ctx, () => listTeamMessages(w.ctx, w.owner, "tch_000001", { limit: 30, after: page.pagination.before_cursor! })), { noSort: MAIN });
    await expectIndexed(w.ctx, "thread", await capture(w.ctx, () => getThread(w.ctx, w.owner, "tmsg_000001_0001")));
    await expectIndexed(w.ctx, "pins", await capture(w.ctx, () => listPins(w.ctx, w.owner, "tch_000001")));
  }, 60_000);

  it("the channel list with unread counts, and search, never scan whole tables", async () => {
    const w = await bigTeam();
    await expectIndexed(w.ctx, "channel list + unread", await capture(w.ctx, () => listChannels(w.ctx, w.owner)));
    await expectIndexed(w.ctx, "channel list for an agent", await capture(w.ctx, () => listChannels(w.ctx, w.agent)));
    await expectIndexed(w.ctx, "search", await capture(w.ctx, () => searchTeam(w.ctx, w.owner, { q: "number 77 in c3", limit: 20 })));
    await expectIndexed(w.ctx, "search in one channel", await capture(w.ctx, () => searchTeam(w.ctx, w.owner, { q: "number 77", channel_id: "tch_000003", limit: 20 })));
  }, 60_000);
});
