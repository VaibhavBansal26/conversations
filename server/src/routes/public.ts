import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { publicWidgetConfig } from "../domain/settings.js";
import { badRequest, forbidden } from "../errors.js";
import { knownIp, parseBody, parseQuery, rateLimit } from "../http.js";
import { MessageListQuery, OtpVerify, ReadBody, SessionBody, VisitorSend } from "../schemas.js";
import { listMemberRows } from "../services/members.js";
import { visitorMessageDto } from "../services/messageStore.js";
import { isOpen } from "../services/office.js";
import {
  getVisitorRoom, visitorListMessages, visitorMarkRead, visitorRoomDto, visitorRooms, visitorSend, visitorStartRoom,
} from "../services/visitorChat.js";
import { authenticateSession, authenticateToken, originMatches, sendOtp, sessionDto, verifyOtp, createSession, type SessionRow } from "../services/visitors.js";
import { getSettings, getWorkspace } from "../services/workspaces.js";
import { getContact } from "../services/contacts.js";

interface PEnv {
  Variables: { session: SessionRow };
}

const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function publicRoutes(ctx: AppContext) {
  const r = new Hono<PEnv>();

  const tokenAuth = (c: Context) => authenticateToken(ctx, c.req.header("x-api-key"), c.req.header("origin"));

  r.get("/widget/config", rateLimit(ctx, "public-config", 60, 1), (c) => {
    const token = tokenAuth(c);
    const ws = getWorkspace(ctx, token.workspace_id);
    const widget = getSettings(ctx, ws.id).widget;
    const inboxes = ctx.db.all<{ id: string; name: string; icon: string }>("SELECT id, name, icon FROM inboxes WHERE workspace_id = ? AND live_routing_visibility = 1 ORDER BY name", ws.id);
    const agents = listMemberRows(ctx, ws.id).filter((m) => m.live_seat && m.availability === "active").map((m) => ({ id: m.id, name: m.name.split(" ")[0] }));
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

  r.post("/sessions", rateLimit(ctx, "public-session", 20, 20 / 60), async (c) => {
    const token = tokenAuth(c);
    const device = c.req.header("x-device-id") ?? "";
    if (!DEVICE_RE.test(device)) throw badRequest("DEVICE_ID_REQUIRED", "x-device-id header (8-64 chars of A-Z a-z 0-9 _ -) is required");
    const b = await parseBody(c, SessionBody);
    const res = createSession(ctx, token, { device_id: device, ip: knownIp(ctx, c), ...b });
    return c.json({ ...sessionDto(res.session, res.contact, res.secret), requires_verification: res.requires_verification }, 201);
  });

  r.use("/*", async (c, next) => {
    if (c.req.path === "/public/sessions" || c.req.path === "/public/widget/config") return next();
    const secret = c.req.header("x-support-session");
    const s = authenticateSession(ctx, secret, { deviceId: c.req.header("x-device-id"), ip: knownIp(ctx, c) });
    // browsers always send Origin; if it is present it must still belong to the embed token that created the session
    const origin = c.req.header("origin");
    if (origin && s.token_id) {
      const t = ctx.db.get<{ domain: string; status: string }>("SELECT domain, status FROM tokens WHERE id = ?", s.token_id);
      if (!t || t.status !== "active" || !originMatches(origin, t.domain)) throw forbidden("This origin is not allowed", "ORIGIN_NOT_ALLOWED");
    }
    c.set("session", s);
    await next();
  });
  const perSession = (name: string, cap: number, perSec: number) => rateLimit(ctx, name, cap, perSec, (c) => (c.get("session" as never) as SessionRow).id);

  r.get("/session", (c) => {
    const s = c.get("session");
    return c.json(sessionDto(s, getContact(ctx, s.workspace_id, s.contact_id)));
  });
  r.get("/rooms", (c) => c.json({ data: visitorRooms(ctx, c.get("session")).map((room) => visitorRoomDto(ctx, room)) }));
  r.post("/rooms", perSession("public-room", 10, 0.2), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = visitorStartRoom(ctx, c.get("session"), { inbox_id: typeof body?.inbox_id === "string" ? body.inbox_id : undefined });
    return c.json({ room: visitorRoomDto(ctx, res.room), created: res.created }, res.created ? 201 : 200);
  });
  r.get("/rooms/:id/messages", (c) => c.json(visitorListMessages(ctx, c.get("session"), c.req.param("id"), parseQuery(c, MessageListQuery))));
  r.post("/rooms/:id/messages", perSession("public-send", 30, 1), async (c) => {
    const s = c.get("session");
    const res = visitorSend(ctx, s, c.req.param("id"), await parseBody(c, VisitorSend));
    const room = getVisitorRoom(ctx, s, c.req.param("id"));
    return c.json(visitorMessageDto(ctx, res.message, room.visitor_read_seq), res.created ? 201 : 200);
  });
  r.post("/rooms/:id/read", perSession("public-read", 60, 2), async (c) => c.json(visitorMarkRead(ctx, c.get("session"), c.req.param("id"), (await parseBody(c, ReadBody)).message_id)));

  r.post("/otp/send", perSession("public-otp", 5, 5 / 600), async (c) => c.json(await sendOtp(ctx, c.get("session"))));
  r.post("/otp/verify", perSession("public-otp-verify", 10, 10 / 300), async (c) => c.json(verifyOtp(ctx, c.get("session"), (await parseBody(c, OtpVerify)).code)));

  return r;
}
