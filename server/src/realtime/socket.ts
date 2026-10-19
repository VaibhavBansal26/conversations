import type { Server as HttpServer } from "node:http";
import type { Namespace, Socket } from "socket.io";
import { Server } from "socket.io";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { seesAll, type Actor } from "../domain/types.js";
import { AppError, unauthorized } from "../errors.js";
import { actorFromToken } from "../services/auth.js";
import { findMember, listMemberRows, actorFromRow, memberScope, visitorScope } from "../services/members.js";
import { roomVisibility, canSeeRoom } from "../services/roomStore.js";
import type { RoomRow } from "../services/roomStore.js";
import { assignRoom, markRead, setPriority, setStatus, setSubject, snoozeRoom, startConversation, unsnoozeRoom, roomBaseDto } from "../services/rooms.js";
import { sendAgentMessage, viewMessage } from "../services/messages.js";
import { visitorMarkRead, visitorRooms, visitorSend, visitorStartRoom, visitorRoomDto } from "../services/visitorChat.js";
import { authenticateSession, verifyOtp, originMatches, type SessionRow } from "../services/visitors.js";
import { visitorMessageDto } from "../services/messageStore.js";
import { listInboxes } from "../services/inboxes.js";
import { RateLimiter } from "../util/ratelimit.js";
import { isWorkspaceId } from "../util/ids.js";
import { AssignBody, OtpVerify, ReadBody, RoomCreate, RoomPatch, SendMessageBody, TypingBody, id } from "../schemas.js";
import type { RealtimeBus } from "./bus.js";

type TeamData = { kind: "team"; memberId: string; userId: string; workspaceId: string; exp: number };
type VisitorData = { kind: "visitor"; sessionId: string; contactId: string; workspaceId: string };
type SockData = TeamData | VisitorData;
type Ack = (r: unknown) => void;

const nspName = (ws: string) => `/ws/${ws}`;

/**
 * RealtimeBus backed by one Socket.IO namespace per workspace. Channels inside a namespace:
 *   room:<id> team members who may see the room    vroom:<id> visitor sockets of that room
 *   member:<id> one seat (all its tabs)            inbox:<id> members of an inbox
 *   managers owners+managers                       team everyone on the team
 * Access changes call refresh*Access, which re-evaluates scope for the affected local sockets synchronously and tells peer nodes to do the same.
 */
export class SocketBus implements RealtimeBus {
  io: Server | null = null;
  private ctx: AppContext | null = null;

  bind(ctx: AppContext, io: Server) {
    this.ctx = ctx;
    this.io = io;
  }

  private nsp(ws: string): Namespace | null {
    return this.io ? this.io.of(nspName(ws)) : null;
  }

  toRoom(ws: string, roomId: string, event: string, payload: unknown, opts?: { visitor?: unknown }) {
    const n = this.nsp(ws);
    if (!n) return;
    n.to(`room:${roomId}`).emit(event, payload);
    if (opts?.visitor !== undefined) n.to(`vroom:${roomId}`).emit(event, opts.visitor);
  }
  toMember(ws: string, memberId: string, event: string, payload: unknown) {
    this.nsp(ws)?.to(`member:${memberId}`).emit(event, payload);
  }
  toInbox(ws: string, inboxId: string, event: string, payload: unknown) {
    this.nsp(ws)?.to(`inbox:${inboxId}`).emit(event, payload);
  }
  toManagers(ws: string, event: string, payload: unknown) {
    this.nsp(ws)?.to("managers").emit(event, payload);
  }
  toWorkspace(ws: string, event: string, payload: unknown) {
    this.nsp(ws)?.to("team").emit(event, payload);
  }

  refreshRoomAccess(ws: string, roomId: string) {
    this.applyRoom(ws, roomId);
    this.peers(ws, { t: "room", id: roomId });
  }
  refreshMemberAccess(ws: string, memberId: string) {
    this.applyMember(ws, memberId);
    this.peers(ws, { t: "member", id: memberId });
  }
  refreshVisitorAccess(ws: string, sessionId: string) {
    this.applyVisitor(ws, sessionId);
    this.peers(ws, { t: "visitor", id: sessionId });
  }
  disconnectMember(ws: string, memberId: string) {
    for (const s of this.localSockets(ws)) if (s.data.kind === "team" && s.data.memberId === memberId) s.disconnect(true);
  }

  private peers(ws: string, msg: { t: string; id: string }) {
    try {
      this.nsp(ws)?.serverSideEmit("access:refresh", msg);
    } catch {
      /* single-node adapters have no peers */
    }
  }

  /** Called by the namespace on `access:refresh` coming from another node. */
  applyPeerMessage(ws: string, msg: { t: string; id: string }) {
    if (msg.t === "room") this.applyRoom(ws, msg.id);
    else if (msg.t === "member") this.applyMember(ws, msg.id);
    else if (msg.t === "visitor") this.applyVisitor(ws, msg.id);
  }

  private localSockets(ws: string): Socket[] {
    const n = this.nsp(ws);
    return n ? [...n.sockets.values()] : [];
  }

  private actorOf(ws: string, s: Socket): Actor | null {
    const d = s.data as SockData;
    if (d.kind !== "team" || !this.ctx) return null;
    const row = findMember(this.ctx, ws, d.memberId);
    return row ? actorFromRow(row) : null;
  }

  private applyRoom(ws: string, roomId: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const s of this.localSockets(ws)) {
      const a = this.actorOf(ws, s);
      if (!a) continue;
      if (canSeeRoom(ctx, a, roomId)) s.join(`room:${roomId}`);
      else s.leave(`room:${roomId}`);
    }
    const room = ctx.db.get<{ contact_id: string; session_id: string | null; archived: number }>("SELECT contact_id, session_id, archived FROM rooms WHERE id = ? AND workspace_id = ?", roomId, ws);
    for (const s of this.localSockets(ws)) {
      const d = s.data as SockData;
      if (d.kind !== "visitor") continue;
      const sess = ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", d.sessionId);
      const ok = room && !room.archived && sess && (sess.verified ? room.contact_id === sess.contact_id : room.session_id === sess.id);
      if (ok) s.join(`vroom:${roomId}`);
      else s.leave(`vroom:${roomId}`);
    }
  }

  private applyMember(ws: string, memberId: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const s of this.localSockets(ws)) {
      if ((s.data as SockData).kind !== "team" || (s.data as TeamData).memberId !== memberId) continue;
      const a = this.actorOf(ws, s);
      if (!a) {
        s.disconnect(true);
        continue;
      }
      for (const r of s.rooms) if (r.startsWith("room:") || r.startsWith("inbox:") || r === "managers") s.leave(r);
      joinTeamRooms(ctx, s, a);
    }
  }

  private applyVisitor(ws: string, sessionId: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const s of this.localSockets(ws)) {
      if ((s.data as SockData).kind !== "visitor" || (s.data as VisitorData).sessionId !== sessionId) continue;
      const sess = ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", sessionId);
      if (!sess) continue;
      for (const r of s.rooms) if (r.startsWith("vroom:")) s.leave(r);
      for (const room of visitorRooms(ctx, sess)) s.join(`vroom:${room.id}`);
      s.emit("session:verified", { verified: !!sess.verified });
    }
  }
}

function joinTeamRooms(ctx: AppContext, s: Socket, a: Actor) {
  s.join(["team", `member:${a.memberId}`]);
  if (seesAll(a)) s.join("managers");
  for (const i of listInboxes(ctx, a)) s.join(`inbox:${i.id}`);
  const v = roomVisibility(a);
  const rows = ctx.db.all<{ id: string }>(`SELECT r.id FROM rooms r WHERE r.workspace_id = ? AND r.archived = 0 AND ${v.sql}`, a.workspaceId, ...v.params);
  s.join(rows.map((r) => `room:${r.id}`));
}

function errorAck(e: unknown) {
  if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  return { ok: false, error: { code: "INTERNAL", message: "Unexpected error" } };
}

export interface SocketServerHandle {
  io: Server;
  close(): Promise<void>;
}

export async function attachSocketServer(httpServer: HttpServer, ctx: AppContext, bus: SocketBus): Promise<SocketServerHandle> {
  const io = new Server(httpServer, {
    // visitors connect from customer websites; auth is a bearer token (no cookies) and visitor origins are checked against the embed token
    cors: { origin: true, credentials: false },
    maxHttpBufferSize: 256 * 1024,
    serveClient: true,
  });
  if (ctx.config.SOCKET_ADAPTER === "redis") await useRedisAdapter(io, ctx);
  bus.bind(ctx, io);

  const parent = io.of(/^\/ws\/ws_[0-9a-f]{24}$/);
  parent.use(async (socket, next) => {
    try {
      const ws = socket.nsp.name.slice(4);
      if (!isWorkspaceId(ws) || !ctx.db.get("SELECT 1 FROM workspaces WHERE id = ?", ws)) throw unauthorized("Unknown workspace", "UNKNOWN_WORKSPACE");
      const auth = (socket.handshake.auth ?? {}) as { token?: string; session?: string; deviceId?: string };
      if (typeof auth.token === "string") {
        const actor = await actorFromToken(ctx, auth.token, ws);
        socket.data = { kind: "team", memberId: actor.memberId, userId: actor.userId, workspaceId: ws, exp: decodeExp(auth.token) } satisfies TeamData;
      } else if (typeof auth.session === "string") {
        const ip = socket.handshake.address;
        const session = authenticateSession(ctx, auth.session, { deviceId: auth.deviceId, ip }, ws);
        const token = session.token_id ? ctx.db.get<{ domain: string; status: string }>("SELECT domain, status FROM tokens WHERE id = ?", session.token_id) : undefined;
        const origin = socket.handshake.headers.origin;
        if (token && (token.status !== "active" || (origin !== undefined && !originMatches(origin, token.domain)))) throw unauthorized("Origin not allowed", "ORIGIN_NOT_ALLOWED");
        socket.data = { kind: "visitor", sessionId: session.id, contactId: session.contact_id, workspaceId: ws } satisfies VisitorData;
      } else throw unauthorized("Missing credentials", "UNAUTHORIZED");
      next();
    } catch (e) {
      const err = new Error(e instanceof AppError ? e.message : "unauthorized") as Error & { data?: unknown };
      err.data = { code: e instanceof AppError ? e.code : "UNAUTHORIZED" };
      next(err);
    }
  });

  const limiter = new RateLimiter(ctx.config.SOCKET_RATE_BURST, ctx.config.SOCKET_RATE_PER_SEC, () => ctx.clock().getTime());

  const wired = new Set<string>();
  parent.on("connection", (socket) => {
    const ws = socket.nsp.name.slice(4);
    if (!wired.has(ws)) {
      wired.add(ws);
      socket.nsp.on("access:refresh", (msg: { t: string; id: string }) => bus.applyPeerMessage(ws, msg));
    }
    const data = socket.data as SockData;
    if (data.kind === "team") {
      const row = findMember(ctx, ws, data.memberId);
      if (!row) return socket.disconnect(true);
      joinTeamRooms(ctx, socket, actorFromRow(row));
      ctx.presence.connect(memberScope(ws), data.memberId, socket.id);
    } else {
      const sess = ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", data.sessionId);
      if (!sess) return socket.disconnect(true);
      socket.join([`session:${sess.id}`, ...visitorRooms(ctx, sess).map((r) => `vroom:${r.id}`)]);
      ctx.presence.connect(visitorScope(ws), data.contactId, socket.id);
    }
    socket.on("disconnect", () => {
      if (data.kind === "team") ctx.presence.disconnect(memberScope(ws), data.memberId, socket.id);
      else ctx.presence.disconnect(visitorScope(ws), data.contactId, socket.id);
    });
    registerHandlers(ctx, socket, limiter);
  });

  return {
    io,
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => resolve());
      }),
  };
}

function decodeExp(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ?? 0;
  } catch {
    return 0;
  }
}

async function useRedisAdapter(io: Server, ctx: AppContext) {
  // Optional dependencies, resolved only when SOCKET_ADAPTER=redis. Variable specifiers keep tsc and bundlers from requiring them.
  const adapterPkg = "@socket.io/redis-adapter";
  const redisPkg = "redis";
  try {
    const { createAdapter } = (await import(adapterPkg)) as { createAdapter: (a: unknown, b: unknown) => unknown };
    const { createClient } = (await import(redisPkg)) as { createClient: (o: { url: string }) => { connect(): Promise<void>; duplicate(): { connect(): Promise<void> } } };
    const pub = createClient({ url: ctx.config.REDIS_URL! });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub) as never);
    ctx.log.info("socket.io redis adapter enabled");
  } catch (e) {
    throw new Error(`SOCKET_ADAPTER=redis but the optional packages could not be loaded (npm i @socket.io/redis-adapter redis): ${e instanceof Error ? e.message : e}`);
  }
}

function registerHandlers(ctx: AppContext, socket: Socket, limiter: RateLimiter) {
  const data = socket.data as SockData;
  const ws = data.workspaceId;

  const visitorSession = (): SessionRow => {
    const d = data as VisitorData;
    const s = ctx.db.get<SessionRow>("SELECT * FROM visitor_sessions WHERE id = ?", d.sessionId);
    if (!s || s.expired || s.expires_at <= ctx.clock().toISOString() || s.workspace_id !== ws) {
      socket.disconnect(true);
      throw new AppError(401, "SESSION_EXPIRED", "Session expired");
    }
    return s;
  };

  /**
   * Wraps every client event: rate limit -> audience check -> fresh scope lookup -> zod -> handler.
   * Scope is re-read on every event, so a demotion or removal takes effect immediately.
   * Failures become `{ ok: false, error: { code, message } }` acks; success is `{ ok: true, ...result }`.
   */
  function on<S extends z.ZodType>(event: string, schema: S | null, only: "team" | "visitor" | undefined, handler: (payload: z.infer<S>, who: Who) => unknown | Promise<unknown>) {
    socket.on(event, async (raw: unknown, ack?: Ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (!limiter.take(socket.id)) throw new AppError(429, "RATE_LIMITED", "Too many events, slow down");
        if (only && data.kind !== only) throw new AppError(403, "FORBIDDEN", "Not available for this connection");
        const who: Who = {};
        if (data.kind === "team") {
          if (data.exp && data.exp * 1000 < ctx.clock().getTime()) {
            socket.disconnect(true);
            throw new AppError(401, "TOKEN_EXPIRED", "Session expired");
          }
          const row = findMember(ctx, ws, data.memberId);
          if (!row) {
            socket.disconnect(true);
            throw new AppError(401, "UNAUTHORIZED", "Seat no longer exists");
          }
          who.actor = actorFromRow(row);
        } else who.session = visitorSession();
        const parsed = schema ? schema.safeParse(raw ?? {}) : { success: true as const, data: undefined };
        if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        const out = await handler(parsed.data as z.infer<S>, who);
        reply({ ok: true, ...(out && typeof out === "object" ? out : {}) });
      } catch (e) {
        if (!(e instanceof AppError)) ctx.log.error("socket handler error", { event, error: e instanceof Error ? e.message : String(e) });
        reply(errorAck(e));
      }
    });
  }

  on("message:send", SendMessageBody.extend({ room_id: id }), undefined, async (p, who) => {
    if (who.session) {
      if (p.kind !== "text" || p.source !== "dm") throw new AppError(403, "FORBIDDEN", "Visitors can only send text chat messages");
      const r = visitorSend(ctx, who.session, p.room_id, { content: p.content ?? "", client_msg_id: p.client_msg_id });
      const room = ctx.db.get<{ visitor_read_seq: number }>("SELECT visitor_read_seq FROM rooms WHERE id = ?", r.message.room_id)!;
      return { message: visitorMessageDto(ctx, r.message, room.visitor_read_seq), created: r.created };
    }
    const { room_id, ...input } = p;
    const r = await sendAgentMessage(ctx, who.actor!, room_id, input);
    return { message: viewMessage(ctx, r.message), created: r.created };
  });

  on("message:read", ReadBody.extend({ room_id: id }), undefined, (p, who) =>
    who.session ? visitorMarkRead(ctx, who.session, p.room_id, p.message_id) : markRead(ctx, who.actor!, p.room_id, p.message_id),
  );

  on("room:create", RoomCreate.omit({ message: true }), undefined, (p, who) => {
    if (who.session) {
      const r = visitorStartRoom(ctx, who.session, { inbox_id: p.inbox_id });
      return { room: visitorRoomDto(ctx, r.room), created: r.created };
    }
    const r = startConversation(ctx, who.actor!, p);
    return { room: roomBaseDto(ctx, r.room), created: r.created };
  });

  on("room:update", RoomPatch.extend({ room_id: id }), "team", (p, { actor }) => {
    let room: RoomRow | undefined;
    if (p.status) room = setStatus(ctx, actor!, p.room_id, p.status);
    if (p.priority !== undefined) room = setPriority(ctx, actor!, p.room_id, p.priority);
    if (p.subject !== undefined) room = setSubject(ctx, actor!, p.room_id, p.subject);
    if (p.snooze_until !== undefined) room = p.snooze_until === null ? unsnoozeRoom(ctx, actor!, p.room_id) : snoozeRoom(ctx, actor!, p.room_id, p.snooze_until);
    if (!room) throw new AppError(400, "NOTHING_TO_UPDATE", "No changes supplied");
    return { room: roomBaseDto(ctx, room) };
  });

  on("room:assign", AssignBody.extend({ room_id: id }), "team", (p, { actor }) => ({ room: roomBaseDto(ctx, assignRoom(ctx, actor!, p.room_id, p)) }));

  on("typing", TypingBody, undefined, (p, who) => {
    if (who.actor) {
      if (!canSeeRoom(ctx, who.actor, p.room_id)) throw new AppError(404, "NOT_FOUND", "Room not found");
      const payload = { room_id: p.room_id, typing: p.typing, who: { type: "agent", id: who.actor.memberId, name: who.actor.name } };
      socket.to(`room:${p.room_id}`).volatile.emit("typing", payload);
      if (!p.internal) socket.to(`vroom:${p.room_id}`).volatile.emit("typing", { ...payload, who: { type: "agent", name: who.actor.name } });
    } else {
      if (!visitorRooms(ctx, who.session!).some((r) => r.id === p.room_id)) throw new AppError(404, "NOT_FOUND", "Room not found");
      socket.to(`room:${p.room_id}`).volatile.emit("typing", { room_id: p.room_id, typing: p.typing, who: { type: "contact", id: (data as VisitorData).contactId } });
    }
    return {};
  });

  on("otp:verify", OtpVerify, "visitor", (p, { session }) => verifyOtp(ctx, session!, p.code));

  on("presence:list", null, "team", () => ({
    online: listMemberRows(ctx, ws).filter((m) => ctx.presence.isOnline(memberScope(ws), m.id)).map((m) => m.id),
  }));
}

interface Who {
  actor?: Actor;
  session?: SessionRow;
}
