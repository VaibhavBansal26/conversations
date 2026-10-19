import { describe, expect, it } from "vitest";
import { createContact, findOrCreateContact } from "../src/services/contacts.js";
import { sendAgentMessage } from "../src/services/messages.js";
import { findOrCreateRoom, markRead, getRoomDto } from "../src/services/rooms.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { migrate } from "../src/db/index.js";
import { addMemberRaw, contactSays, isolatedDbEnv, makeCtx, mkInbox, mkContact, seedWorkspace, trackCtx, type TestCtx } from "./helpers.js";

const postgres = !!process.env.TEST_DATABASE_URL;

/**
 * "Nodes" are separate contexts (own connection pool, own caches) over ONE database, exactly like several app replicas.
 * With SQLite a second in-process connection cannot make progress while the first holds a write lock (single thread), so
 * the cluster is one context there and the same races run through that context's transaction mutex.
 */
async function cluster(n: number) {
  const first = await makeCtx();
  const nodes: TestCtx[] = [first];
  if (postgres) {
    const url = first.config.DATABASE_URL!;
    for (let i = 1; i < n; i++) {
      const c = await makeCtx({ DATABASE_URL: url, NODE_ID: `node-${i}` });
      nodes.push(c);
    }
  }
  const { wsId, owner } = await seedWorkspace(first);
  return { nodes, wsId, owner, node: (i: number) => nodes[i % nodes.length]! };
}

describe(`concurrency on ${postgres ? "PostgreSQL (3 nodes)" : "SQLite (1 node)"}`, () => {
  it("allocates per-room seq numbers uniquely and without gaps under concurrent sends from every node", async () => {
    const c = await cluster(3);
    const { room } = await findOrCreateRoom(c.node(0), c.wsId, { contactId: (await mkContact(c.node(0), c.wsId)).id });
    const N = 60;
    await Promise.all(
      Array.from({ length: N }, async (_, i) =>
        sendAgentMessage(c.node(i), actorFromRow(await getMember(c.node(i), c.wsId, c.owner.memberId)), room.id, { kind: "note", source: "dm", content: `m${i}`, client_msg_id: `race-${String(i).padStart(4, "0")}` }),
      ),
    );
    const rows = await c.node(0).db.all<{ seq: number }>("SELECT seq FROM messages WHERE room_id = ? ORDER BY seq", room.id);
    const seqs = rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(seqs.length).toBeGreaterThanOrEqual(N);
    expect((await c.node(0).db.get<{ next_seq: number }>("SELECT next_seq FROM rooms WHERE id = ?", room.id))!.next_seq).toBe(seqs.length);
  });

  it("stores a retried client_msg_id exactly once even when the duplicates hit different nodes at the same time", async () => {
    const c = await cluster(3);
    const { room } = await findOrCreateRoom(c.node(0), c.wsId, { contactId: (await mkContact(c.node(0), c.wsId)).id });
    for (let round = 0; round < 5; round++) {
      const qid = `dup-round-${round}-000000`;
      const results = await Promise.all(
        Array.from({ length: 9 }, async (_, i) => {
          const n = c.node(i);
          return sendAgentMessage(n, actorFromRow(await getMember(n, c.wsId, c.owner.memberId)), room.id, { kind: "note", source: "dm", content: "once", client_msg_id: qid });
        }),
      );
      expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect((await c.node(0).db.get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE room_id = ? AND client_msg_id = ?", room.id, qid))!.n).toBe(1);
    }
  });

  it("converges parallel room creation for one contact (any node) on a single room", async () => {
    const c = await cluster(3);
    const contact = await mkContact(c.node(0), c.wsId);
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => findOrCreateRoom(c.node(i), c.wsId, { contactId: contact.id })));
    expect(new Set(results.map((r) => r.room.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await c.node(0).db.get<{ n: number }>("SELECT COUNT(*) n FROM rooms WHERE contact_id = ?", contact.id))!.n).toBe(1);
  });

  it("find-or-create contact never duplicates an identity across nodes", async () => {
    const c = await cluster(3);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => findOrCreateContact(c.node(i), c.wsId, { email: "same@example.test", phone: i % 2 ? "415-555-2671" : undefined })));
    expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const dupes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => createContact(c.node(i), c.wsId, { name: "Dup", email: "dup@example.test" })));
    expect(dupes.filter((d) => d.status === "fulfilled")).toHaveLength(1);
    expect(dupes.filter((d) => d.status === "rejected").every((d) => (d as PromiseRejectedResult).reason.code === "CONTACT_EXISTS")).toBe(true);
  });

  it("hands out round-robin turns exactly once under concurrent room creation on every node", async () => {
    const c = await cluster(3);
    const members = [];
    for (let i = 0; i < 3; i++) members.push(await addMemberRaw(c.node(0), c.wsId, { name: `Agent${i}` }));
    const inbox = await mkInbox(c.node(0), c.owner, { name: "RR", algorithm: "round_robin", member_ids: members.map((m) => m.memberId) });
    const contacts = await Promise.all(Array.from({ length: 30 }, (_, i) => mkContact(c.node(i), c.wsId, { name: `C${i}` })));
    await Promise.all(contacts.map((ct, i) => findOrCreateRoom(c.node(i), c.wsId, { contactId: ct.id, inboxId: inbox.id })));
    const counts = await c.node(0).db.all<{ member_id: string; n: number }>(
      "SELECT ra.member_id, COUNT(*) n FROM room_assignees ra JOIN rooms r ON r.id = ra.room_id WHERE r.inbox_id = ? GROUP BY ra.member_id",
      inbox.id,
    );
    expect(counts.map((x) => x.n)).toEqual([10, 10, 10]);
    expect(counts).toHaveLength(3);
  });

  it("moves the read cursor monotonically to the highest message while reads and sends race", async () => {
    const c = await cluster(2);
    const { room } = await findOrCreateRoom(c.node(0), c.wsId, { contactId: (await mkContact(c.node(0), c.wsId)).id });
    const sent = [];
    for (let i = 0; i < 12; i++) sent.push(await contactSays(c.node(0), room, `hello ${i}`));
    const actor = async (i: number) => actorFromRow(await getMember(c.node(i), c.wsId, c.owner.memberId));
    await Promise.all([
      ...sent.map(async (m, i) => markRead(c.node(i), await actor(i), room.id, m.id)),
      ...Array.from({ length: 10 }, async (_, i) => sendAgentMessage(c.node(i), await actor(i), room.id, { kind: "note", source: "dm", content: `n${i}`, client_msg_id: `rw-${String(i).padStart(6, "0")}` })),
    ]);
    const cursor = (await c.node(0).db.get<{ last_read_seq: number }>("SELECT last_read_seq FROM room_reads WHERE room_id = ? AND member_id = ?", room.id, c.owner.memberId))!;
    expect(cursor.last_read_seq).toBe(Math.max(...sent.map((m) => m.seq)));
    expect((await getRoomDto(c.node(0), await actor(0), room.id)).unread_count).toBe(0); // only notes and system lines came after
  });

  it.skipIf(!postgres)("runs migrations from several nodes at once without conflict (advisory lock)", async () => {
    const iso = await isolatedDbEnv({});
    const nodes = await Promise.all([0, 1, 2, 3].map((i) => makeCtx({ ...iso.env, NODE_ID: `m${i}` })));
    for (const n of nodes) trackCtx(n, undefined);
    expect(await migrate(nodes[0]!.db)).toEqual([]);
    expect((await nodes[0]!.db.get<{ n: number }>("SELECT COUNT(*) n FROM _migrations"))!.n).toBe(3);
  });
});
