import type { Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { visitorScope } from "../src/services/members.js";
import { visitorStartRoom } from "../src/services/visitorChat.js";
import { ack, sleep, startServer } from "./rt-helpers.js";

/**
 * ~500 concurrent sockets in one process: every message must reach every subscribed agent exactly once and in per-room order,
 * duplicate client ids sent concurrently must collapse to one message, and a mass abrupt disconnect must leave presence consistent.
 * (The 10k-connection, multi-process version lives in loadtest/.)
 */
const VISITORS = 500;
const AGENTS = 3;
const PER_VISITOR = 4;

type Server = Awaited<ReturnType<typeof startServer>>;
let srv: Server;
beforeAll(async () => {
  srv = await startServer({ SOCKET_RATE_BURST: "100", SOCKET_RATE_PER_SEC: "1000", WS_MAX_WRITE_BUFFER: "5000", SHED_LOOP_LAG_MS: "0" });
});
afterAll(async () => {
  await srv.close();
});

async function inBatches<T, R>(items: T[], size: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map((x, j) => fn(x, i + j)))));
  return out;
}

describe("500 concurrent sockets", () => {
  it("delivers every message exactly once and in order, collapses duplicates, and recovers presence after a mass disconnect", async () => {
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "Scale");
    const agents: Socket[] = [];
    const seen: Map<string, number[]>[] = [];

    // visitors and their rooms
    const make = async (i: number) => {
      const v = await srv.visitor(wsId, "chat.example.com", `device-scale-${String(i).padStart(5, "0")}`);
      const { room } = await visitorStartRoom(srv.ctx, v.session as never);
      return { v, roomId: room.id };
    };
    const first = await make(0); // creates the embed token; the helper is not safe to race on first use
    const people = [first, ...(await inBatches(Array.from({ length: VISITORS - 1 }, (_, i) => i + 1), 50, make))];

    // agents subscribe first, so they must see everything that follows
    for (let a = 0; a < AGENTS; a++) {
      const s = await srv.team(wsId, owner);
      const perRoom = new Map<string, number[]>();
      s.on("message:new", (p: { message: { room_id: string; seq: number } }) => {
        const l = perRoom.get(p.message.room_id) ?? [];
        l.push(p.message.seq);
        perRoom.set(p.message.room_id, l);
      });
      agents.push(s);
      seen.push(perRoom);
    }

    const visitorSockets: Socket[] = await inBatches(people, 50, (p) => srv.connect(wsId, p.v.auth));
    expect(visitorSockets.every((s) => s.connected)).toBe(true);
    expect((srv.ctx as any).__handle.h.stats().visitors).toBe(VISITORS);

    // each visitor sends PER_VISITOR messages; the first one is sent twice at once with the same client id
    const acks = await inBatches(people, 100, async (p, i) => {
      const s = visitorSockets[i]!;
      const send = (n: number) => ack(s, "message:send", { room_id: p.roomId, kind: "text", source: "dm", content: `hello ${n}`, client_msg_id: `scale-${i}-${n}-xxxx` }, 20_000);
      const first = await Promise.all([send(0), send(0)]);
      const rest = [];
      for (let n = 1; n < PER_VISITOR; n++) rest.push(await send(n));
      return [...first, ...rest];
    });
    const flat = acks.flat();
    expect(flat.every((a) => a.ok !== false)).toBe(true);
    expect(flat.filter((a) => a.created === false)).toHaveLength(VISITORS); // exactly one duplicate per visitor was collapsed

    await sleep(500);
    for (const perRoom of seen) {
      expect(perRoom.size).toBe(VISITORS);
      for (const seqs of perRoom.values()) {
        expect(seqs).toHaveLength(PER_VISITOR); // none lost, none doubled
        expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)).toBe(true); // in order, no gaps
      }
    }

    // an agent reply reaches exactly the one visitor in that room
    const target = people[7]!;
    const got: unknown[] = [];
    visitorSockets[7]!.on("message:new", (p: unknown) => got.push(p));
    const other: unknown[] = [];
    visitorSockets[8]!.on("message:new", (p: unknown) => other.push(p));
    await ack(agents[0]!, "message:send", { room_id: target.roomId, kind: "text", source: "dm", content: "reply", client_msg_id: "scale-agent-reply-1" });
    await sleep(200);
    // the reply (plus the auto-assignment system line) reaches that visitor only
    expect((got as { message: { content: string } }[]).filter((g) => g.message.content === "reply")).toHaveLength(1);
    expect(other).toHaveLength(0);

    // abrupt mass disconnect of half the visitors: server-side connection accounting and presence converge
    for (const s of visitorSockets.slice(0, VISITORS / 2)) s.close();
    await sleep(800);
    expect((srv.ctx as any).__handle.h.stats().visitors).toBe(VISITORS / 2);
    const online = await Promise.all(people.map((p) => srv.ctx.presence.isOnline(visitorScope(wsId), p.v.session.contact_id)));
    expect(online.filter(Boolean).length).toBeLessThanOrEqual(VISITORS / 2 + 5);
  }, 120_000);
});
