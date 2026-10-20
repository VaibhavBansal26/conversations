import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { publicWidgetConfig } from "../domain/settings.js";
import { badRequest, forbidden } from "../errors.js";
import { z } from "zod";
import { AppError } from "../errors.js";
import { recordCsat } from "../services/roomMetrics.js";
import { knownIp, parseBody, parseQuery } from "../http.js";
import { applyPrincipalLimits, enforce } from "../ratelimit/http.js";
import { ipKey } from "../util/clientIp.js";
import { MessageListQuery, OtpVerify, ReadBody, SessionBody, VisitorSend } from "../schemas.js";
import { listMemberRows } from "../services/members.js";
import { loadRefs, visitorMessageDto } from "../services/messageStore.js";
import { isOpen } from "../services/office.js";
import {
  getVisitorRoom,
  visitorListMessages,
  visitorMarkRead,
  visitorRoomDto,
  visitorRoomDtos,
  visitorRooms,
  visitorSend,
  visitorStartRoom,
} from "../services/visitorChat.js";
import { authenticateSession, authenticateToken, originMatches, sendOtp, sessionDto, verifyOtp, createSession, type SessionRow } from "../services/visitors.js";
import { getSettings, getWorkspace } from "../services/workspaces.js";
import { getContact } from "../services/contacts.js";

interface PEnv {
  Variables: { session: SessionRow };
}

const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const Csat = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() });

export function publicRoutes(ctx: AppContext) {
  const r = new Hono<PEnv>();

  const tokenAuth = (c: Context) => authenticateToken(ctx, c.req.header("x-api-key"), c.req.header("origin"));

  r.get("/widget/config", async (c) => {
    const token = await tokenAuth(c);
    const ws = await getWorkspace(ctx, token.workspace_id);
    const widget = (await getSettings(ctx, ws.id)).widget;
    const inboxes = await ctx.db.all<{ id: string; name: string; icon: string }>(
      "SELECT id, name, icon FROM inboxes WHERE workspace_id = ? AND live_routing_visibility = 1 ORDER BY name",
      ws.id,
    );
    const agents = (await listMemberRows(ctx, ws.id)).filter((m) => m.live_seat && m.availability === "active").map((m) => ({ id: m.id, name: m.name.split(" ")[0] }));
    // an edge cache may hold this for 30s; the key MUST include the api key and Origin (the domain allow-list is evaluated per origin)
    c.header("Cache-Control", "public, max-age=0, s-maxage=30");
    c.header("Vary", "Origin, X-API-Key");
    return c.json({
      workspace_id: ws.id,
      workspace_name: ws.name,
      widget: publicWidgetConfig(widget),
      office_open: isOpen(widget.office_hours, ctx.clock()),
      live_routing_inboxes: inboxes,
      agents_available: agents.length,
      agents: agents.slice(0, 3),
    });
  });

  r.post("/sessions", async (c) => {
    const token = await tokenAuth(c);
    const device = c.req.header("x-device-id") ?? "";
    if (!DEVICE_RE.test(device)) throw badRequest("DEVICE_ID_REQUIRED", "x-device-id header (8-64 chars of A-Z a-z 0-9 _ -) is required");
    const b = await parseBody(c, SessionBody);
    const res = await createSession(ctx, token, { device_id: device, ip: knownIp(ctx, c), ...b });
    return c.json({ ...sessionDto(res.session, res.contact, res.secret), requires_verification: res.requires_verification }, 201);
  });

  r.use("/*", async (c, next) => {
    if (c.req.path === "/public/sessions" || c.req.path === "/public/widget/config") return await next();
    const secret = c.req.header("x-support-session");
    const s = await authenticateSession(ctx, secret, { deviceId: c.req.header("x-device-id"), ip: knownIp(ctx, c) });
    // browsers always send Origin; if it is present it must still belong to the embed token that created the session
    const origin = c.req.header("origin");
    if (origin && s.token_id) {
      const t = await ctx.db.get<{ domain: string; status: string }>("SELECT domain, status FROM tokens WHERE id = ?", s.token_id);
      if (!t || t.status !== "active" || !originMatches(origin, t.domain)) throw forbidden("This origin is not allowed", "ORIGIN_NOT_ALLOWED");
    }
    c.set("session", s);
    await applyPrincipalLimits(ctx, c, { visitorId: s.id, workspaceId: s.workspace_id });
    await next();
  });

  r.get("/session", async (c) => {
    const s = c.get("session");
    return c.json(sessionDto(s, await getContact(ctx, s.workspace_id, s.contact_id)));
  });
  r.get("/rooms", async (c) => c.json({ data: await visitorRoomDtos(ctx, await visitorRooms(ctx, c.get("session"))) }));
  r.post("/rooms", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await visitorStartRoom(ctx, c.get("session"), { inbox_id: typeof body?.inbox_id === "string" ? body.inbox_id : undefined });
    return c.json({ room: await visitorRoomDto(ctx, res.room), created: res.created }, res.created ? 201 : 200);
  });
  r.get("/rooms/:id/messages", async (c) => c.json(await visitorListMessages(ctx, c.get("session"), c.req.param("id"), parseQuery(c, MessageListQuery))));
  r.post("/rooms/:id/messages", async (c) => {
    const s = c.get("session");
    const res = await visitorSend(ctx, s, c.req.param("id"), await parseBody(c, VisitorSend));
    const room = await getVisitorRoom(ctx, s, c.req.param("id"));
    return c.json(visitorMessageDto(ctx, res.message, room.visitor_read_seq, await loadRefs(ctx, [res.message])), res.created ? 201 : 200);
  });
  r.post("/rooms/:id/read", async (c) =>
    c.json(await visitorMarkRead(ctx, c.get("session"), c.req.param("id"), (await parseBody(c, ReadBody)).message_id)),
  );

  r.post("/otp/send", async (c) => {
    const s = c.get("session");
    // caps that stop SMS pumping: per contact per day and per IP per hour (the per-session cap already ran)
    await enforce(ctx, "public.otp.contact", { key: `${s.workspace_id}|${s.contact_id}` });
    await enforce(ctx, "public.otp.ip", { key: ipKey(knownIp(ctx, c) ?? "unknown") });
    return c.json(await sendOtp(ctx, s));
  });
  r.post("/rooms/:id/csat", async (c) => {
    const body = await parseBody(c, Csat);
    const room = await getVisitorRoom(ctx, c.get("session"), c.req.param("id"));
    if (!(await recordCsat(ctx, room, body.score, body.comment))) throw new AppError(409, "CSAT_NOT_AVAILABLE", "The conversation must be closed and not yet rated");
    return c.json({ ok: true });
  });
  r.post("/otp/verify", async (c) => c.json(await verifyOtp(ctx, c.get("session"), (await parseBody(c, OtpVerify)).code)));

  return r;
}
