import { serve } from "@hono/node-server";
import { io as connectIo, type Socket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { closeContext, createContext } from "../src/app-context.js";
import { HeuristicProvider } from "../src/ai/heuristic.js";
import { silentLogger } from "../src/logger.js";
import { FakeEmailProvider, FakeSmsProvider } from "../src/providers/fake.js";
import { SocketBus, attachSocketServer } from "../src/realtime/socket.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { createToken, createSession } from "../src/services/visitors.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock, testConfig, isolatedDbEnv, dropSchema, type TestCtx, seedWorkspace, tokenFor, addMemberRaw } from "./helpers.js";

export async function startServer(env: Record<string, string> = {}) {
  const clockCtl = new TestClock(Date.now());
  const bus = new SocketBus();
  const iso = await isolatedDbEnv({ PRESENCE_GRACE_MS: "150", WS_CONNECT_RATE_PER_IP: "1000", ...env });
  const ctx = (await createContext(testConfig(iso.env), {
    log: silentLogger,
    bus,
    sms: new FakeSmsProvider(),
    email: new FakeEmailProvider(),
    ai: new HeuristicProvider(),
  })) as TestCtx;
  ctx.clock = clockCtl.now;
  ctx.clockCtl = clockCtl;
  const app = createApp(ctx);
  const port = await new Promise<number>(async (resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    await attachSocketServer(s as never, ctx, bus).then((h) => ((ctx as any).__handle = { s, h }));
  });
  await new Promise((r) => setTimeout(r, 30));
  const sockets: Socket[] = [];
  const url = `http://127.0.0.1:${port}`;
  const connect = (ws: string, auth: Record<string, unknown>, headers: Record<string, string> = {}) =>
    new Promise<Socket>((resolve, reject) => {
      const s = connectIo(`${url}/ws/${ws}`, { auth, transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: headers });
      sockets.push(s);
      s.once("connect", () => resolve(s));
      s.once("connect_error", (e: Error & { data?: { code?: string } }) => reject(Object.assign(e, { code: e.data?.code })));
    });
  const team = async (ws: string, actor: Actor) => connect(ws, { token: await tokenFor(ctx, actor) });
  async function visitor(wsId: string, domain = "chat.example.com", device = "device-rt-0001", info: Record<string, string> = {}) {
    const owner = (await ctx.db.get<{ id: string }>("SELECT id FROM members WHERE workspace_id = ? LIMIT 1", wsId))!;
    const existing = await ctx.db.get<{ token: string; id: string }>("SELECT * FROM tokens WHERE workspace_id = ? AND domain = ? AND status = 'active'", wsId, domain);
    const token = existing ?? (await createToken(ctx, actorFromRow(await getMember(ctx, wsId, owner.id)), domain));
    const s = await createSession(ctx, token as never, { device_id: device, ip: null, ...info });
    return { ...s, auth: { session: s.secret, deviceId: device }, domain, tokenRow: token };
  }
  async function close() {
    for (const s of sockets) s.close();
    const { s, h } = (ctx as any).__handle;
    await h.close();
    s.close();
    await closeContext(ctx);
    await dropSchema(iso.schema);
  }
  return { ctx, url, connect, team, visitor, close, clockCtl, seedWorkspace, addMemberRaw, sockets };
}

export const ack = <T = any>(s: Socket, event: string, payload?: unknown, timeoutMs = 2000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), timeoutMs);
    s.emit(event, payload, (r: T) => {
      clearTimeout(t);
      resolve(r);
    });
  });

/** Collects events so tests can assert on them after the fact, and waits for specific ones. */
export function recorder(s: Socket, events: string[]) {
  const log: { event: string; payload: any }[] = [];
  for (const e of events) s.on(e, (payload: unknown) => log.push({ event: e, payload }));
  const waitFor = (event: string, pred: (p: any) => boolean = () => true, ms = 2000) =>
    new Promise<any>((resolve, reject) => {
      const found = log.find((l) => l.event === event && pred(l.payload));
      if (found) return resolve(found.payload);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
      const h = (p: unknown) => {
        if (pred(p)) {
          clearTimeout(t);
          s.off(event, h);
          resolve(p);
        }
      };
      s.on(event, h);
    });
  return { log, waitFor, of: (event: string) => log.filter((l) => l.event === event).map((l) => l.payload) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ALL_EVENTS = [
  "message:new",
  "message:updated",
  "message:deleted",
  "message:receipt",
  "room:new",
  "room:updated",
  "room:deleted",
  "room:unread",
  "inbox:new",
  "inbox:updated",
  "presence:update",
  "typing",
  "visitor:presence",
  "notification:new",
  "notification:read",
  "member:updated",
  "member:removed",
  "session:verified",
  "contact:updated",
];
