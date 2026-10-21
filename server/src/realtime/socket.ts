import type { Server as HttpServer } from "node:http";
import type { Namespace, Socket } from "socket.io";
import { Server } from "socket.io";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { seesAll, type Actor } from "../domain/types.js";
import { AppError, unauthorized } from "../errors.js";
import { AssignBody, OtpVerify, ReadBody, RoomCreate, RoomPatch, SendMessageBody, TeamSocketReaction, TeamSocketRead, TeamSocketSend, TeamSocketTyping, TypingBody, id } from "../schemas.js";
import { accessChannel, markTeamRead, sendTeamMessage, toggleReaction } from "../services/teamChat.js";
import { actorFromToken } from "../services/auth.js";
import { audienceChannels } from "../services/audience.js";
import { listInboxes } from "../services/inboxes.js";
import { actorFromRow, findMember, memberScope, onlineMemberIds, visitorScope } from "../services/members.js";
import { sendAgentMessage, viewMessage } from "../services/messages.js";
import { visitorMessageDto } from "../services/messageStore.js";
import { canSeeRoom } from "../services/roomStore.js";
import type { RoomRow } from "../services/roomStore.js";
import { assignRoom, markRead, roomBaseDto, setPriority, setStatus, setSubject, snoozeRoom, startConversation, unsnoozeRoom } from "../services/rooms.js";
import { visitorMarkRead, visitorRoomDto, visitorRooms, visitorSend, visitorStartRoom } from "../services/visitorChat.js";
import { authenticateSession, sessionOriginAllowed, verifyOtp, type SessionRow } from "../services/visitors.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { gcra, type GcraState } from "../ratelimit/algorithms.js";
import { PermissionDenied } from "../authz/http.js";
import { workspaceSuspended } from "../admin/suspension.js";
import { can } from "../authz/permissions.js";
import { EVENT_ACCESS } from "../authz/routePerms.js";
import { EVENT_LIMITS } from "../ratelimit/routePolicies.js";
import { ipKey, resolveClientIp } from "../util/clientIp.js";
import { isWorkspaceId } from "../util/ids.js";
import type { RealtimeBus } from "./bus.js";

type TeamData = { kind: "team"; memberId: string; userId: string; workspaceId: string; exp: number; ip: string | null; imp?: string };
type VisitorData = { kind: "visitor"; sessionId: string; contactId: string; workspaceId: string; ip: string | null };
type SockData = TeamData | VisitorData;
/** the session row read during the handshake, so joining rooms does not read it again */
const handshakeSession = new WeakMap<object, SessionRow>();
type Ack = (r: unknown) => void;
interface Who {
  actor?: Actor;
  session?: SessionRow;
}

const nspName = (ws: string) => `/ws/${ws}`;
const PRESENCE_FLUSH_MS = 150;
const RECEIPT_FLUSH_MS = 100;
const TYPING_MIN_GAP_MS = 500;

/**
 * RealtimeBus backed by one Socket.IO namespace per workspace. Channels inside a namespace:
 *   room:<id> team members who may see the room    vroom:<id> visitor sockets of that room
 *   member:<id> one seat (all its tabs)            inbox:<id> members of an inbox
 *   managers owners+managers                       team everyone on the team
 * Access changes call refresh*Access, which re-evaluates scope for the affected local sockets and (with a clustered adapter) tells
 * peer nodes to do the same. Bursty, idempotent events (presence flips, read receipts) are coalesced: only the newest state in a
 * short window is sent.
 */
export class SocketBus implements RealtimeBus {
  io: Server | null = null;
  private ctx: AppContext | null = null;
  private clustered = false;
  get draining(): boolean {
    return this.ctx?.state.draining ?? false;
  }
  private presenceQueue = new Map<string, { ws: string; payload: unknown }>();
  private receiptQueue = new Map<string, { ws: string; roomId: string; payload: any; visitor?: unknown }>();
  private flushTimers: ReturnType<typeof setTimeout>[] = [];

  bind(ctx: AppContext, io: Server, clustered: boolean) {
    this.ctx = ctx;
    this.io = io;
    this.clustered = clustered;
  }

  private nsp(ws: string): Namespace | null {
    return this.io ? this.io.of(nspName(ws)) : null;
  }

  private timed<T>(event: string, fn: () => T): T {
    const m = this.ctx?.metrics;
    if (!m) return fn();
    const end = m.wsFanout.startTimer();
    m.wsEmits.inc({ event });
    try {
      return fn();
    } finally {
      end();
    }
  }

  /** Events for one room are emitted in call order even though resolving the audience is asynchronous (per-room promise chain). */
  private readonly chains = new Map<string, Promise<void>>();
  private ordered(key: string, fn: () => Promise<void> | void) {
    const prev = this.chains.get(key);
    const next: Promise<void> = (prev ? prev.then(fn) : Promise.resolve().then(fn))
      .catch((e) => this.ctx?.log.warn("room emit failed", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }
  /** Wait for in-flight emits (graceful shutdown, tests). */
  async settle() {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private async teamChannels(ws: string, roomId: string): Promise<string[]> {
    return this.ctx ? await audienceChannels(this.ctx, ws, roomId) : ["managers"];
  }

  toRoom(ws: string, roomId: string, event: string, payload: unknown, opts?: { visitor?: unknown }) {
    if (event === "message:receipt") return this.queueReceipt(ws, roomId, payload as { reader: { type: string; id?: string } }, opts?.visitor);
    this.ordered(roomId, async () => {
      const channels = await this.teamChannels(ws, roomId);
      this.timed(event, () => {
        const n = this.nsp(ws);
        if (!n) return;
        n.to(channels).emit(event, payload);
        if (opts?.visitor !== undefined) n.to(`vroom:${roomId}`).emit(event, opts.visitor);
      });
    });
  }
  toMember(ws: string, memberId: string, event: string, payload: unknown) {
    this.timed(event, () => this.nsp(ws)?.to(`member:${memberId}`).emit(event, payload));
  }
  toInbox(ws: string, inboxId: string, event: string, payload: unknown) {
    this.timed(event, () => this.nsp(ws)?.to(`inbox:${inboxId}`).emit(event, payload));
  }
  toManagers(ws: string, event: string, payload: unknown) {
    this.timed(event, () => this.nsp(ws)?.to("managers").emit(event, payload));
  }
  toWorkspace(ws: string, event: string, payload: unknown) {
    if (event === "presence:update") return this.queuePresence(ws, payload as { member_id: string });
    this.timed(event, () => this.nsp(ws)?.to("team").emit(event, payload));
  }

  /** Last state per seat wins inside the window, so a flapping tab produces one update instead of a storm. */
  private queuePresence(ws: string, payload: { member_id: string }) {
    const first = this.presenceQueue.size === 0;
    this.presenceQueue.set(`${ws}:${payload.member_id}`, { ws, payload });
    if (first) this.schedule(PRESENCE_FLUSH_MS, () => this.flushPresence());
  }
  private flushPresence() {
    const q = this.presenceQueue;
    this.presenceQueue = new Map();
    for (const { ws, payload } of q.values()) this.timed("presence:update", () => this.nsp(ws)?.to("team").emit("presence:update", payload));
  }

  /** A receipt only ever moves forward, so intermediate ones in the window are redundant. */
  private queueReceipt(ws: string, roomId: string, payload: { reader: { type: string; id?: string } }, visitor?: unknown) {
    const first = this.receiptQueue.size === 0;
    this.receiptQueue.set(`${roomId}:${payload.reader.type}:${payload.reader.id ?? ""}`, { ws, roomId, payload, visitor });
    if (first) this.schedule(RECEIPT_FLUSH_MS, () => this.flushReceipts());
  }
  private flushReceipts() {
    const q = this.receiptQueue;
    this.receiptQueue = new Map();
    for (const { ws, roomId, payload, visitor } of q.values()) {
      this.ordered(roomId, async () => {
        const channels = await this.teamChannels(ws, roomId);
        this.timed("message:receipt", () => {
          const n = this.nsp(ws);
          if (!n) return;
          n.to(channels).emit("message:receipt", payload);
          if (visitor !== undefined) n.to(`vroom:${roomId}`).emit("message:receipt", visitor);
        });
      });
    }
  }
  private schedule(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.flushTimers = this.flushTimers.filter((x) => x !== t);
      fn();
    }, ms);
    t.unref();
    this.flushTimers.push(t);
  }
  /** Send anything still queued (graceful shutdown). */
  flush() {
    for (const t of this.flushTimers) clearTimeout(t);
    this.flushTimers = [];
    this.flushPresence();
    this.flushReceipts();
  }

  async refreshRoomAccess(ws: string, roomId: string) {
    await this.ctx?.cache.invalidate(`aud:${roomId}`);
    await this.applyRoom(ws, roomId);
    this.peers(ws, { t: "room", id: roomId });
  }
  async refreshMemberAccess(ws: string, memberId: string) {
    await this.applyMember(ws, memberId);
    this.peers(ws, { t: "member", id: memberId });
  }
  async refreshVisitorAccess(ws: string, sessionId: string) {
    await this.applyVisitor(ws, sessionId);
    this.peers(ws, { t: "visitor", id: sessionId });
  }
  disconnectMember(ws: string, memberId: string) {
    for (const s of this.localSockets(ws)) if (s.data.kind === "team" && s.data.memberId === memberId) s.disconnect(true);
    this.peers(ws, { t: "disconnect", id: memberId });
  }

  private peers(ws: string, msg: { t: string; id: string }) {
    if (!this.clustered) return;
    try {
      this.nsp(ws)?.serverSideEmit("access:refresh", msg);
    } catch {
      /* no peers */
    }
  }

  /** Called by the namespace on `access:refresh` coming from another node. */
  async applyPeerMessage(ws: string, msg: { t: string; id: string }) {
    if (msg.t === "room") await this.applyRoom(ws, msg.id);
    else if (msg.t === "member") await this.applyMember(ws, msg.id);
    else if (msg.t === "visitor") await this.applyVisitor(ws, msg.id);
    else if (msg.t === "disconnect") for (const s of this.localSockets(ws)) if (s.data.kind === "team" && s.data.memberId === msg.id) s.disconnect(true);
  }

  localSockets(ws: string): Socket[] {
    const n = this.nsp(ws);
    return n ? [...n.sockets.values()] : [];
  }

  /** Every local socket across all workspace namespaces (connection sweeps, drain). */
  allSockets(parent: Namespace): Socket[] {
    const out: Socket[] = [];
    for (const n of (parent as unknown as { children: Set<Namespace> }).children) out.push(...n.sockets.values());
    return out;
  }

  private teamSocketsByMember(ws: string): Map<string, Socket[]> {
    const by = new Map<string, Socket[]>();
    for (const s of this.localSockets(ws)) {
      const d = s.data as SockData;
      if (d.kind !== "team") continue;
      by.set(d.memberId, [...(by.get(d.memberId) ?? []), s]);
    }
    return by;
  }

  /** Scope is evaluated once per seat, not once per tab. */
  private async applyRoom(ws: string, roomId: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    // team audiences are computed per event (services/audience.ts); only visitor channel membership is stored on sockets
    const visitors = this.localSockets(ws).filter((s) => (s.data as SockData).kind === "visitor");
    if (!visitors.length) return;
    const room = await ctx.db.get<{ contact_id: string; session_id: string | null; archived: number }>("SELECT contact_id, session_id, archived FROM rooms WHERE id = ? AND workspace_id = ?", roomId, ws);
    const sessions = new Map<string, SessionRow | undefined>();
    for (const s of visitors) {
      const sid = (s.data as VisitorData).sessionId;
      if (!sessions.has(sid)) sessions.set(sid, await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", sid));
      const sess = sessions.get(sid);
      const ok = room && !room.archived && sess && (sess.verified ? room.contact_id === sess.contact_id : room.session_id === sess.id);
      if (ok) s.join(`vroom:${roomId}`);
      else s.leave(`vroom:${roomId}`);
    }
  }

  private async applyMember(ws: string, memberId: string) {
    const ctx = this.ctx;
    const socks = this.teamSocketsByMember(ws).get(memberId);
    if (!ctx || !socks) return;
    const row = await findMember(ctx, ws, memberId);
    if (!row) {
      for (const s of socks) s.disconnect(true);
      return;
    }
    const a = actorFromRow(row);
    for (const s of socks) {
      for (const r of s.rooms) if (r.startsWith("inbox:") || r.startsWith("inboxv:") || r === "managers") s.leave(r);
      await joinTeamRooms(ctx, s, a);
    }
  }

  private async applyVisitor(ws: string, sessionId: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    const socks = this.localSockets(ws).filter((s) => (s.data as SockData).kind === "visitor" && (s.data as VisitorData).sessionId === sessionId);
    if (!socks.length) return;
    const sess = await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", sessionId);
    if (!sess) return;
    const rooms = await visitorRooms(ctx, sess);
    for (const s of socks) {
      for (const r of s.rooms) if (r.startsWith("vroom:")) s.leave(r);
      for (const room of rooms) s.join(`vroom:${room.id}`);
      s.emit("session:verified", { verified: !!sess.verified });
    }
  }
}

async function joinTeamRooms(ctx: AppContext, s: Socket, a: Actor) {
  // O(inboxes), independent of how many rooms exist: room events reach agents through computed audiences, not per-room channels
  s.join(["team", `member:${a.memberId}`]);
  if (seesAll(a)) s.join("managers");
  const inboxes = await listInboxes(ctx, a);
  for (const i of inboxes) s.join(`inbox:${i.id}`);
  if (!seesAll(a) && a.inboxVisibility === "assigned_inbox") for (const i of inboxes) s.join(`inboxv:${i.id}`);
}

function errorAck(e: unknown) {
  if (e instanceof AppError) {
    const retry = (e.details as { retry_after_ms?: number } | undefined)?.retry_after_ms;
    return { ok: false, error: { code: e.code, message: e.message, details: e.details, ...(retry !== undefined ? { retry_after_ms: retry } : {}) }, ...(retry !== undefined ? { retry_after_ms: retry } : {}) };
  }
  return { ok: false, error: { code: "INTERNAL", message: "Unexpected error" } };
}

export interface SocketServerHandle {
  io: Server;
  /** Stop accepting connections, tell clients to reconnect elsewhere (jittered), then drop them after `delayMs`. */
  drain(delayMs: number): Promise<void>;
  /** Live connection counts on this node. */
  stats(): { total: number; team: number; visitors: number; perIp: number };
  close(): Promise<void>;
}

const decodeExp = (token: string): number => {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ?? 0;
  } catch {
    return 0;
  }
};

async function useRedisAdapter(io: Server, ctx: AppContext): Promise<boolean> {
  if (!ctx.redis) return false;
  const { createAdapter } = await import("@socket.io/redis-adapter");
  io.adapter(createAdapter(ctx.redis.duplicate(), ctx.redis.duplicate(), { key: ctx.redis.k("socket.io") }) as never);
  ctx.log.info("socket.io redis adapter enabled", { node: ctx.nodeId });
  return true;
}

export async function attachSocketServer(httpServer: HttpServer, ctx: AppContext, bus: SocketBus): Promise<SocketServerHandle> {
  const cfg = ctx.config;
  const transports = cfg.WS_TRANSPORTS.split(",") as ("polling" | "websocket")[];
  const io = new Server(httpServer, {
    // visitors connect from customer websites; auth is a bearer token (no cookies) and visitor origins are checked against the embed token
    cors: { origin: true, credentials: false },
    maxHttpBufferSize: cfg.WS_MAX_BUFFER_BYTES,
    pingInterval: cfg.WS_PING_INTERVAL_MS,
    pingTimeout: cfg.WS_PING_TIMEOUT_MS,
    transports,
    // measured, not assumed: see docs/PERFORMANCE.md. Off by default; chat payloads are small and CPU is the scarcer resource
    perMessageDeflate: cfg.WS_PERMESSAGE_DEFLATE ? { threshold: 1024 } : false,
    serveClient: true,
  });
  const useRedis = cfg.SOCKET_ADAPTER !== "memory" && !!ctx.redis && (await useRedisAdapter(io, ctx));
  bus.bind(ctx, io, useRedis);

  const parent = io.of(/^\/ws\/ws_[0-9a-f]{24}$/);
  // Redis came back after an outage: cross-node events published meanwhile were lost, so every local client refetches over REST
  ctx.redis?.onRecovered(() => {
    ctx.log.warn("redis recovered: asking local clients to resync", { node: ctx.nodeId });
    for (const s of bus.allSockets(parent)) s.emit("server:resync", {});
  });
  const perIp = new Map<string, number>();
  let total = 0;
  // admission control inputs: event-loop lag over the last second and handshakes admitted but not yet authenticated
  const lagMon = monitorEventLoopDelay({ resolution: 20 });
  lagMon.enable();
  let lagMs = 0;
  const lagTimer = setInterval(() => {
    lagMs = lagMon.percentile(99) / 1e6;
    lagMon.reset();
  }, 1000);
  lagTimer.unref();
  let handshakes = 0;
  const inflight = new WeakSet<Socket>();
  const leases = new WeakMap<Socket, { policy: string; key: string }[]>();
  // connection leases (per seat / visitor / workspace / IP) live in the shared store with a TTL; every node renews the leases of its own live sockets
  const held = new Map<string, { policy: string; key: string; ids: Set<string> }>();
  const hold = (policy: string, key: string, id: string) => {
    const k = `${policy}|${key}`;
    let h = held.get(k);
    if (!h) held.set(k, (h = { policy, key, ids: new Set() }));
    h.ids.add(id);
  };
  const unhold = (policy: string, key: string, id: string) => {
    const k = `${policy}|${key}`;
    const h = held.get(k);
    if (!h) return;
    h.ids.delete(id);
    if (!h.ids.size) held.delete(k);
  };
  const renewTimer = setInterval(() => {
    for (const h of held.values()) void ctx.ratelimit.renew(h.policy, h.key, [...h.ids]);
  }, 100_000);
  renewTimer.unref();
  const shed = (next: (e?: Error) => void, reason: string, extra: Record<string, unknown> = {}) => {
    ctx.metrics.wsShed.inc({ reason });
    ctx.metrics.wsConnects.inc({ kind: "unknown", result: reason });
    reject(next, "OVERLOADED", "Server is busy, retry shortly", { retry_after_ms: 1500 + Math.floor(Math.random() * 6000), ...extra });
  };
  const ipOf = (s: Socket) => resolveClientIp({ trustProxy: cfg.TRUST_PROXY, edgeSecret: cfg.CF_SHARED_SECRET, proxyHops: cfg.TRUSTED_PROXY_HOPS }, s.handshake.headers, s.handshake.address);

  const reject = (next: (e?: Error) => void, code: string, message: string, extra: Record<string, unknown> = {}) => {
    const err = new Error(message) as Error & { data?: unknown };
    err.data = { code, ...extra };
    next(err);
  };

  // 1) cheap admission control before any database work: drain state, global/per-IP caps and a per-IP connection rate (reconnect storms)
  parent.use(async (socket, next) => {
    const ip = ipOf(socket) ?? "unknown";
    if (bus.draining) {
      ctx.metrics.wsConnects.inc({ kind: "unknown", result: "draining" });
      return reject(next, "DRAINING", "Server is restarting", { retry_after_ms: 1000 + Math.floor(Math.random() * 4000) });
    }
    // load shedding: refuse new handshakes (cheap) before doing database work for them, with a jittered hint so the herd spreads out
    if (cfg.SHED_LOOP_LAG_MS && lagMs > cfg.SHED_LOOP_LAG_MS) return shed(next, "loop_lag");
    if (handshakes >= cfg.WS_MAX_HANDSHAKES) return shed(next, "handshakes");
    if (cfg.WS_MAX_CONNECTIONS && total >= cfg.WS_MAX_CONNECTIONS) {
      ctx.metrics.wsConnects.inc({ kind: "unknown", result: "busy" });
      return reject(next, "BUSY", "Server is at capacity", { retry_after_ms: 2000 + Math.floor(Math.random() * 8000) });
    }
    if (cfg.WS_MAX_CONNECTIONS_PER_IP && (perIp.get(ip) ?? 0) >= cfg.WS_MAX_CONNECTIONS_PER_IP) {
      ctx.metrics.wsConnects.inc({ kind: "unknown", result: "ip_cap" });
      return reject(next, "TOO_MANY_CONNECTIONS", "Too many connections from your address", { retry_after_ms: 5000 });
    }
    const d = await ctx.ratelimit.check("ws.connect.ip", { key: ipKey(ip) }, { entities: [`ip:${ipKey(ip)}`] });
    if (!d.allowed) {
      ctx.metrics.wsConnects.inc({ kind: "unknown", result: "rate_limited" });
      return reject(next, d.outcome === "denylisted" ? "BLOCKED" : "RATE_LIMITED", "Reconnecting too fast", { retry_after_ms: d.retryAfterMs + Math.floor(Math.random() * 2000) });
    }
    handshakes++;
    inflight.add(socket);
    next();
  });

  // 2) authentication: team JWT or visitor session, both verified against THIS namespace's workspace
  parent.use(async (socket, next) => {
    try {
      const ws = socket.nsp.name.slice(4);
      const known = await ctx.cache.wrap(`ws-exists:${ws}`, async () => !!(await ctx.db.get("SELECT 1 FROM workspaces WHERE id = ?", ws)));
      if (!isWorkspaceId(ws) || !known) throw unauthorized("Unknown workspace", "UNKNOWN_WORKSPACE");
      const ip = ipOf(socket);
      const auth = (socket.handshake.auth ?? {}) as { token?: string; session?: string; deviceId?: string };
      if (typeof auth.token === "string") {
        const actor = await actorFromToken(ctx, auth.token, ws);
        socket.data = { kind: "team", memberId: actor.memberId, userId: actor.userId, workspaceId: ws, exp: decodeExp(auth.token), ip, imp: actor.impersonatedBy } satisfies TeamData;
      } else if (typeof auth.session === "string") {
        const session = await authenticateSession(ctx, auth.session, { deviceId: auth.deviceId, ip }, ws);
        const token = session.token_id ? await ctx.db.get<{ domain: string; status: "active" | "revoked" }>("SELECT domain, status FROM tokens WHERE id = ?", session.token_id) : undefined;
        const origin = socket.handshake.headers.origin;
        if (token && (token.status !== "active" || (origin !== undefined && !sessionOriginAllowed(ctx, session, token, origin)))) throw unauthorized("Origin not allowed", "ORIGIN_NOT_ALLOWED");
        handshakeSession.set(socket, session);
        socket.data = { kind: "visitor", sessionId: session.id, contactId: session.contact_id, workspaceId: ws, ip } satisfies VisitorData;
      } else throw unauthorized("Missing credentials", "UNAUTHORIZED");

      // concurrent-connection caps (shared across nodes): per seat or visitor session, per workspace (plan tier), per IP
      const d = socket.data as SockData;
      const wanted: { policy: string; key: string; max?: number }[] =
        d.kind === "team" ? [{ policy: "ws.conn.user", key: d.memberId }] : [{ policy: "ws.conn.visitor", key: d.sessionId }];
      if (cfg.WS_MAX_CONNECTIONS_PER_WORKSPACE > 0) wanted.push({ policy: "ws.conn.workspace", key: ws, max: cfg.WS_MAX_CONNECTIONS_PER_WORKSPACE });
      else if (cfg.PLAN_ENFORCEMENT) wanted.push({ policy: "ws.conn.workspace", key: ws });
      if (cfg.WS_MAX_CONNECTIONS_PER_IP > 0 && ip) wanted.push({ policy: "ws.conn.ip", key: ipKey(ip), max: cfg.WS_MAX_CONNECTIONS_PER_IP });
      const got: { policy: string; key: string }[] = [];
      for (const w of wanted) {
        const r = await ctx.ratelimit.acquire(w.policy, w.key, socket.id, ws, w.max);
        if (!r.ok) {
          for (const g of got) await ctx.ratelimit.release(g.policy, g.key, socket.id);
          ctx.metrics.wsConnects.inc({ kind: d.kind, result: "conn_cap" });
          return reject(next, "TOO_MANY_CONNECTIONS", "Too many open connections for this account", { retry_after_ms: 3000 + Math.floor(Math.random() * 4000), policy: w.policy });
        }
        got.push({ policy: w.policy, key: w.key });
        hold(w.policy, w.key, socket.id);
      }
      leases.set(socket, got);
      next();
    } catch (e) {
      ctx.metrics.wsConnects.inc({ kind: "unknown", result: "auth_failed" });
      reject(next, e instanceof AppError ? e.code : "UNAUTHORIZED", e instanceof AppError ? e.message : "unauthorized");
    } finally {
      if (inflight.delete(socket)) handshakes--;
    }
  });

  const wired = new Set<string>();
  parent.on("connection", (socket) => {
    const ws = socket.nsp.name.slice(4);
    if (!wired.has(ws)) {
      wired.add(ws);
      socket.nsp.on("access:refresh", (msg: { t: string; id: string }) => void bus.applyPeerMessage(ws, msg).catch(() => {}));
    }
    const data = socket.data as SockData;
    const ip = data.ip ?? "unknown";
    total++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    ctx.metrics.wsConnections.inc({ kind: data.kind });
    ctx.metrics.wsConnects.inc({ kind: data.kind, result: "ok" });

    // handlers are registered synchronously (a fast client may emit right after `connect`); they wait for the joins to finish
    const ready = (async () => {
      if (data.kind === "team") {
        const row = await findMember(ctx, ws, data.memberId);
        if (!row) throw new Error("seat gone");
        await joinTeamRooms(ctx, socket, actorFromRow(row));
        await ctx.presence.connect(memberScope(ws), data.memberId, socket.id);
      } else {
        const sess = handshakeSession.get(socket) ?? (await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", data.sessionId));
        if (!sess) throw new Error("session gone");
        socket.join([`session:${sess.id}`, ...(await visitorRooms(ctx, sess, { reload: false })).map((r) => `vroom:${r.id}`)]);
        await ctx.presence.connect(visitorScope(ws), data.contactId, socket.id);
      }
    })();
    ready.catch(() => socket.disconnect(true));

    // a long-lived socket must not outlive its credential: tell the client, then drop it
    let expiry: ReturnType<typeof setTimeout> | undefined;
    if (data.kind === "team" && data.exp) {
      const ms = Math.min(2 ** 31 - 1, Math.max(0, data.exp * 1000 - ctx.clock().getTime()));
      expiry = setTimeout(() => {
        socket.emit("auth:expired", {});
        socket.disconnect(true);
      }, ms);
      expiry.unref();
    }

    socket.on("disconnect", () => {
      clearTimeout(expiry);
      for (const l of leases.get(socket) ?? []) {
        unhold(l.policy, l.key, socket.id);
        void ctx.ratelimit.release(l.policy, l.key, socket.id);
      }
      total--;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
      ctx.metrics.wsConnections.dec({ kind: data.kind });
      ready
        .then(() => (data.kind === "team" ? ctx.presence.disconnect(memberScope(ws), data.memberId, socket.id) : ctx.presence.disconnect(visitorScope(ws), data.contactId, socket.id)))
        .catch(() => {});
    });
    registerHandlers(ctx, socket, ready);
  });

  // slow consumers: a socket whose outbound queue keeps growing would pin memory for everyone, so it is dropped (clients reconnect and re-sync over REST)
  const sweep = setInterval(() => {
    let max = 0;
    for (const s of bus.allSockets(parent)) {
      const q = (s.conn as unknown as { writeBuffer?: unknown[] }).writeBuffer?.length ?? 0;
      max = Math.max(max, q);
      if (q > cfg.WS_MAX_WRITE_BUFFER) {
        ctx.metrics.slowConsumers.inc();
        ctx.log.warn("dropping slow consumer", { socket: s.id, queued: q });
        s.emit("server:overflow", {});
        s.disconnect(true);
      }
    }
    ctx.metrics.wsWriteBufferMax.set(max);
  }, 2000);
  sweep.unref();

  return {
    io,
    stats: () => {
      const all = bus.allSockets(parent);
      const team = all.filter((s) => (s.data as SockData).kind === "team").length;
      return { total, team, visitors: all.length - team, perIp: perIp.size };
    },
    async drain(delayMs: number) {
      ctx.state.draining = true;
      bus.flush();
      for (const s of bus.allSockets(parent)) s.emit("server:draining", { reconnect_in_ms: Math.floor(Math.random() * Math.max(1, delayMs)) });
      await new Promise((r) => setTimeout(r, delayMs));
      for (const s of bus.allSockets(parent)) s.disconnect(true);
    },
    close: async () => {
      clearInterval(sweep);
      clearInterval(lagTimer);
      clearInterval(renewTimer);
      lagMon.disable();
      bus.flush();
      await new Promise<void>((resolve) => void io.close(() => resolve()));
    },
  };
}

function registerHandlers(ctx: AppContext, socket: Socket, ready: Promise<void>) {
  const data = socket.data as SockData;
  const ws = data.workspaceId;
  const lastTyping = new Map<string, number>();
  // per-socket event bucket (exact, node-local: a socket lives on one node) with cost weights per event, plus strikes: drops first, disconnect after repeated violations
  const cfg = ctx.config;
  let bucket: GcraState | undefined;
  let strikes = 0;
  let lastStrikeAt = 0;
  const limited = (retryAfterMs: number, scope: string): never => {
    const nowMs = Date.now();
    if (nowMs - lastStrikeAt > 60_000) strikes = 0;
    lastStrikeAt = nowMs;
    strikes++;
    ctx.metrics.wsStrikes.inc({ result: "dropped" });
    if (strikes >= cfg.WS_STRIKE_LIMIT) {
      ctx.metrics.wsStrikes.inc({ result: "disconnected" });
      socket.emit("rate:limited", { reason: "too_many_violations", retry_after_ms: 5000 + Math.floor(Math.random() * 10_000) });
      socket.disconnect(true);
    }
    throw new AppError(429, "RATE_LIMITED", "Too many events, slow down", { retry_after_ms: Math.ceil(retryAfterMs), scope, strikes });
  };

  const visitorSession = async (): Promise<SessionRow> => {
    const d = data as VisitorData;
    const s = await ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", d.sessionId);
    if (!s || s.expired || s.expires_at <= ctx.clock().toISOString() || s.workspace_id !== ws) {
      socket.disconnect(true);
      throw new AppError(401, "SESSION_EXPIRED", "Session expired");
    }
    return s;
  };

  /**
   * Wraps every client event: rate limits (per socket, then per seat across tabs and nodes) -> audience check -> fresh scope lookup ->
   * zod -> handler. Scope is re-read on every event, so a demotion or removal takes effect immediately.
   * Failures become `{ ok: false, error: { code, message } }` acks; success is `{ ok: true, ...result }`.
   */
  function on<S extends z.ZodType>(event: string, schema: S | null, only: "team" | "visitor" | undefined, handler: (payload: z.infer<S>, who: Who) => unknown | Promise<unknown>) {
    // the declaration in ratelimit/routePolicies.ts must know every event (a test enumerates both sides)
    if (!EVENT_LIMITS[event]) throw new Error(`socket event "${event}" has no entry in EVENT_LIMITS`);
    if (!EVENT_ACCESS[event]) throw new Error(`socket event "${event}" has no entry in EVENT_ACCESS`);
    socket.on(event, async (raw: unknown, ack?: Ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const end = ctx.metrics.wsAck.startTimer({ event });
      let result = "ok";
      try {
        await ready;
        const w = EVENT_LIMITS[event]!;
        {
          const r = gcra(bucket, Date.now(), { emissionMs: 1000 / cfg.SOCKET_RATE_PER_SEC, burst: cfg.SOCKET_RATE_BURST, cost: w.cost });
          if (!r.verdict.allowed) limited(r.verdict.retryAfterMs, "socket");
          bucket = r.next;
        }
        if (only && data.kind !== only) throw new AppError(403, "FORBIDDEN", "Not available for this connection");
        const who: Who = {};
        if (await workspaceSuspended(ctx, ws)) {
          setTimeout(() => socket.disconnect(true), 100); // after the ack below has gone out
          throw new AppError(403, "WORKSPACE_SUSPENDED", "This workspace has been suspended. Contact support.");
        }
        // a support (impersonation) connection is a read-only window: it receives live updates but may not emit anything that changes state
        if (data.kind === "team" && data.imp) throw new AppError(403, "IMPERSONATION_READ_ONLY", "Support access is read-only");
        if (data.kind === "team") {
          if (data.exp && data.exp * 1000 < ctx.clock().getTime()) {
            socket.disconnect(true);
            throw new AppError(401, "TOKEN_EXPIRED", "Session expired");
          }
          const row = await findMember(ctx, ws, data.memberId);
          if (!row) {
            socket.disconnect(true);
            throw new AppError(401, "UNAUTHORIZED", "Seat no longer exists");
          }
          who.actor = actorFromRow(row);
          // the same permission check as REST (authz/routePerms.ts)
          const need = EVENT_ACCESS[event]!;
          if (need !== "authed" && need !== "visitor-only" && !can(who.actor, need)) throw new PermissionDenied(need);
        } else who.session = await visitorSession();
        {
          const d = await ctx.ratelimit.check("ws.actor", { key: `${ws}:${data.kind === "team" ? data.memberId : data.contactId}` }, { cost: w.cost });
          if (!d.allowed) limited(d.retryAfterMs, "actor");
        }
        const parsed = schema ? schema.safeParse(raw ?? {}) : { success: true as const, data: undefined };
        if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        const out = await handler(parsed.data as z.infer<S>, who);
        reply({ ok: true, ...(out && typeof out === "object" ? out : {}) });
      } catch (e) {
        result = e instanceof AppError ? (e.code === "RATE_LIMITED" ? "rate_limited" : "rejected") : "error";
        if (result === "rate_limited") ctx.metrics.rateLimited.inc({ scope: "socket" });
        if (!(e instanceof AppError)) {
          ctx.log.error("socket handler error", { event, socket: socket.id, node: ctx.nodeId, error: e instanceof Error ? e.message : String(e) });
          ctx.monitor.capture(e, { area: "socket", event, socket_id: socket.id, workspace_id: (socket.data as TeamData | VisitorData).workspaceId });
        }
        reply(errorAck(e));
      } finally {
        end();
        ctx.metrics.wsEvents.inc({ event, result });
      }
    });
  }

  on("message:send", SendMessageBody.extend({ room_id: id }), undefined, async (p, who) => {
    if (who.session) {
      if (p.kind !== "text" || p.source !== "dm") throw new AppError(403, "FORBIDDEN", "Visitors can only send text chat messages");
      const r = await visitorSend(ctx, who.session, p.room_id, { content: p.content ?? "", client_msg_id: p.client_msg_id });
      return { message: visitorMessageDto(ctx, r.message, r.room.visitor_read_seq), created: r.created };
    }
    const { room_id, ...input } = p;
    const r = await sendAgentMessage(ctx, who.actor!, room_id, input);
    return { message: await viewMessage(ctx, r.message), created: r.created };
  });

  on("message:read", ReadBody.extend({ room_id: id }), undefined, async (p, who) =>
    who.session ? await visitorMarkRead(ctx, who.session, p.room_id, p.message_id) : await markRead(ctx, who.actor!, p.room_id, p.message_id),
  );

  on("room:create", RoomCreate.omit({ message: true }), undefined, async (p, who) => {
    if (who.session) {
      const r = await visitorStartRoom(ctx, who.session, { inbox_id: p.inbox_id });
      return { room: await visitorRoomDto(ctx, r.room), created: r.created };
    }
    const r = await startConversation(ctx, who.actor!, p);
    return { room: await roomBaseDto(ctx, r.room), created: r.created };
  });

  on("room:update", RoomPatch.extend({ room_id: id }), "team", async (p, { actor }) => {
    let room: RoomRow | undefined;
    if (p.status) room = await setStatus(ctx, actor!, p.room_id, p.status);
    if (p.priority !== undefined) room = await setPriority(ctx, actor!, p.room_id, p.priority);
    if (p.subject !== undefined) room = await setSubject(ctx, actor!, p.room_id, p.subject);
    if (p.snooze_until !== undefined) room = p.snooze_until === null ? await unsnoozeRoom(ctx, actor!, p.room_id) : await snoozeRoom(ctx, actor!, p.room_id, p.snooze_until);
    if (!room) throw new AppError(400, "NOTHING_TO_UPDATE", "No changes supplied");
    return { room: await roomBaseDto(ctx, room) };
  });

  on("room:assign", AssignBody.extend({ room_id: id }), "team", async (p, { actor }) => ({ room: await roomBaseDto(ctx, await assignRoom(ctx, actor!, p.room_id, p)) }));

  on("typing", TypingBody, undefined, async (p, who) => {
    // typing is purely cosmetic: identical updates inside a short gap are dropped before any lookup
    const key = `${p.room_id}:${p.typing}:${!!p.internal}`;
    const now = Date.now();
    if (now - (lastTyping.get(key) ?? 0) < TYPING_MIN_GAP_MS) return {};
    lastTyping.set(key, now);
    if (lastTyping.size > 200) lastTyping.clear();
    if (who.actor) {
      if (!(await canSeeRoom(ctx, who.actor, p.room_id))) throw new AppError(404, "NOT_FOUND", "Room not found");
      const payload = { room_id: p.room_id, typing: p.typing, who: { type: "agent", id: who.actor.memberId, name: who.actor.name } };
      socket.to(await audienceChannels(ctx, ws, p.room_id)).volatile.emit("typing", payload);
      if (!p.internal) socket.to(`vroom:${p.room_id}`).volatile.emit("typing", { ...payload, who: { type: "agent", name: who.actor.name } });
    } else {
      if (!(await visitorRooms(ctx, who.session!)).some((r) => r.id === p.room_id)) throw new AppError(404, "NOT_FOUND", "Room not found");
      socket.to(await audienceChannels(ctx, ws, p.room_id)).volatile.emit("typing", { room_id: p.room_id, typing: p.typing, who: { type: "contact", id: (data as VisitorData).contactId } });
    }
    return {};
  });

  /* ---- team chat: same services as REST, so the same membership checks apply to every event ---- */
  on("team:message:send", TeamSocketSend, "team", async (p, { actor }) => {
    const { channel_id, ...input } = p;
    const r = await sendTeamMessage(ctx, actor!, channel_id, input);
    return { message: r.message, created: r.created };
  });
  on("team:typing", TeamSocketTyping, "team", async (p, { actor }) => {
    const key = `team:${p.channel_id}:${p.typing}`;
    const now = Date.now();
    if (now - (lastTyping.get(key) ?? 0) < TYPING_MIN_GAP_MS) return {};
    lastTyping.set(key, now);
    if (lastTyping.size > 200) lastTyping.clear();
    const { channel } = await accessChannel(ctx, actor!, p.channel_id, { write: true });
    const ids = (await ctx.db.all<{ member_id: string }>("SELECT member_id FROM team_channel_members WHERE channel_id = ?", channel.id)).map((r) => r.member_id).filter((m) => m !== actor!.memberId);
    if (ids.length) socket.to(ids.map((m) => `member:${m}`)).volatile.emit("team:typing", { channel_id: channel.id, thread_root_id: p.thread_root_id ?? null, typing: p.typing, member_id: actor!.memberId, name: actor!.name });
    return {};
  });
  on("team:read", TeamSocketRead, "team", async (p, { actor }) => await markTeamRead(ctx, actor!, p.channel_id, p.message_id));
  on("team:reaction", TeamSocketReaction, "team", async (p, { actor }) => await toggleReaction(ctx, actor!, p.message_id, p.emoji));

  on("otp:verify", OtpVerify, "visitor", (p, { session }) => verifyOtp(ctx, session!, p.code));

  on("presence:list", null, "team", async () => ({ online: await onlineMemberIds(ctx, ws) }));
}
