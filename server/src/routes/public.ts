import { aiCallAvailability } from "../calls/aiCall.js";
import { previewCallLink, redeemCallLink } from "../calls/links.js";
import { FormSubmission, skipContactForm, submitContactForm } from "../services/visitorInfo.js";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { publicWidgetConfig } from "../domain/settings.js";
import { badRequest, forbidden, unprocessable } from "../errors.js";
import { nowIso } from "../context.js";
import { parseJson } from "../util/json.js";
import { saveUpload, VISITOR_UPLOAD_MIME } from "../services/attachments.js";
import { z } from "zod";
import { AppError } from "../errors.js";
import { recordCsat } from "../services/roomMetrics.js";
import { clientIp, knownIp, parseBody, parseQuery, validate } from "../http.js";
import { applyPrincipalLimits, enforce, guardStrikes } from "../ratelimit/http.js";
import { ipKey } from "../util/clientIp.js";
import { CallLinkOpenBody, CallLinkRedeemBody, MessageListQuery, OtpVerify, PublicRoomBody, QuickReplyBody, ReadBody, SessionAttributes, SessionBody, TicketCsat, VisitorFeedback, VisitorSend } from "../schemas.js";
import { rateTicket, visitorTicketDto } from "../services/tickets.js";
import { visitorFeedback, visitorQuickReply, visitorRequestHuman } from "../agents/visitorActions.js";
import { selectAgent } from "../agents/config.js";
import { listMemberRows } from "../services/members.js";
import { loadRefs, visitorMessageDto } from "../services/messageStore.js";
import { isOpen } from "../services/office.js";
import { departmentStatus } from "../services/departments.js";
import type { InboxRow } from "../services/inboxes.js";
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
import { authenticateSession, authenticateToken, sendOtp, sessionOriginAllowed, sessionDto, verifyOtp, createSession, type SessionRow } from "../services/visitors.js";
import { getSettings, getWorkspace } from "../services/workspaces.js";
import { getContact } from "../services/contacts.js";

interface PEnv {
  Variables: { session: SessionRow };
}

const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const Csat = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() });

export function publicRoutes(ctx: AppContext) {
  const r = new Hono<PEnv>();

  const tokenAuth = (c: Context, seen = false) =>
    authenticateToken(ctx, c.req.header("x-api-key"), c.req.header("origin"), { seen, preview: c.req.header("x-preview"), hostedChat: c.req.header("x-hosted-chat") === "1" });

  r.get("/widget/config", async (c) => {
    const token = await tokenAuth(c, true);
    const ws = await getWorkspace(ctx, token.workspace_id);
    const settings = await getSettings(ctx, ws.id);
    const widget = settings.widget;
    const inboxes = await ctx.db.all<{ id: string; name: string; icon: string }>(
      "SELECT id, name, icon FROM inboxes WHERE workspace_id = ? AND live_routing_visibility = 1 ORDER BY name",
      ws.id,
    );
    // availability needs a few queries per department: shared by every visitor for the cache window
    const departments = await ctx.cache.wrap(`widget-depts:${ws.id}`, async () =>
      Promise.all(
        (await ctx.db.all<InboxRow>("SELECT * FROM inboxes WHERE workspace_id = ? AND live_routing_visibility = 1 ORDER BY name LIMIT 20", ws.id)).map(async (d) => {
          const st = await departmentStatus(ctx, d);
          return { id: d.id, name: d.name, description: d.description, icon: d.icon, open: st.open, available: st.available_agents > 0 };
        }),
      ),
    );
    // the visitor is told when they talk to an AI: the agent that would answer on the website (its name, avatar and disclosure label)
    const sel = await selectAgent(ctx, ws.id, { channel: "widget", departmentId: widget.default_inbox_id });
    const ai = sel ? { name: sel.agent.name, label: sel.agent.disclosure_label, avatar_url: sel.agent.avatar_url, avatar_alt: sel.agent.avatar_alt } : null;
    const agents = (await listMemberRows(ctx, ws.id)).filter((m) => m.live_seat && m.availability === "active").map((m) => ({ id: m.id, name: m.name.split(" ")[0] }));
    // an edge cache may hold this for 30s; the key MUST include the api key and Origin (the domain allow-list is evaluated per origin)
    c.header("Cache-Control", "public, max-age=0, s-maxage=30");
    c.header("Vary", "Origin, X-API-Key");
    return c.json({
      workspace_id: ws.id,
      workspace_name: ws.name,
      default_region: settings.default_region,
      widget: publicWidgetConfig(widget),
      office_open: isOpen(widget.office_hours, ctx.clock()),
      live_routing_inboxes: inboxes,
      ai,
      calls: { browser: { enabled: settings.calls.browser.enabled, voice: settings.calls.browser.voice, video: settings.calls.browser.video }, ai: await aiCallAvailability(ctx, ws.id, widget.default_inbox_id) },
      departments,
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

  // call links: opened by someone who has no session yet; the address is the credential (see calls/links.ts)
  r.post("/call-links/preview", async (c) => {
    const ip = ipKey(clientIp(ctx, c));
    await guardStrikes(ctx, [{ policy: "calls.link.fail.ip", key: ip }]);
    const b = await parseBody(c, CallLinkOpenBody);
    try {
      return c.json(await previewCallLink(ctx, b.token));
    } catch (e) {
      if (e instanceof AppError && e.code === "LINK_UNAVAILABLE") await ctx.ratelimit.strike("calls.link.fail.ip", ip);
      throw e;
    }
  });
  r.post("/call-links/redeem", async (c) => {
    const ip = ipKey(clientIp(ctx, c));
    await guardStrikes(ctx, [{ policy: "calls.link.fail.ip", key: ip }]);
    const b = await parseBody(c, CallLinkRedeemBody);
    if (!DEVICE_RE.test(b.device_id)) throw badRequest("DEVICE_ID_REQUIRED", "device_id (8-64 chars of A-Z a-z 0-9 _ -) is required");
    try {
      return c.json(await redeemCallLink(ctx, { token: b.token, device_id: b.device_id, ip: knownIp(ctx, c), name: b.name }), 201);
    } catch (e) {
      if (e instanceof AppError && e.code === "LINK_UNAVAILABLE") await ctx.ratelimit.strike("calls.link.fail.ip", ip);
      throw e;
    }
  });

  r.use("/*", async (c, next) => {
    if (c.req.path === "/public/sessions" || c.req.path === "/public/widget/config" || c.req.path === "/public/call-links/preview" || c.req.path === "/public/call-links/redeem") return await next();
    const secret = c.req.header("x-support-session");
    const s = await authenticateSession(ctx, secret, { deviceId: c.req.header("x-device-id"), ip: knownIp(ctx, c) });
    // a session a call link minted takes part in the call over the socket and reads nothing here
    if (s.call_link_id) throw forbidden("This link only allows taking part in the call", "LINK_SESSION");
    // browsers always send Origin; if it is present it must still belong to the embed token that created the session
    const origin = c.req.header("origin");
    if (origin && s.token_id) {
      const t = await ctx.db.get<{ domain: string; status: "active" | "revoked"; hosted_chat_enabled: number }>("SELECT domain, status, hosted_chat_enabled FROM tokens WHERE id = ?", s.token_id);
      if (!t || !sessionOriginAllowed(ctx, s, t, origin)) throw forbidden("This origin is not allowed", "ORIGIN_NOT_ALLOWED");
    }
    c.set("session", s);
    await applyPrincipalLimits(ctx, c, { visitorId: s.id, workspaceId: s.workspace_id });
    await next();
  });

  r.get("/session", async (c) => {
    const s = c.get("session");
    return c.json(sessionDto(s, await getContact(ctx, s.workspace_id, s.contact_id)));
  });
  // end this session (the host app's "log out"): the secret stops working at once; the next session starts anonymous or signed again
  r.delete("/session", async (c) => {
    await ctx.db.run("UPDATE visitor_sessions SET expired = 1 WHERE id = ?", c.get("session").id);
    return c.body(null, 204);
  });
  // free-form attributes the host app wants to show the team ("plan", "app_version"). Visitor-supplied, so stored apart from the contact's own fields
  r.post("/session/attributes", async (c) => {
    const s = c.get("session");
    const { attributes } = await parseBody(c, SessionAttributes);
    const contact = await getContact(ctx, s.workspace_id, s.contact_id);
    const attrs = parseJson<Record<string, unknown>>(contact.attrs, {});
    const app = { ...(typeof attrs.app === "object" && attrs.app ? (attrs.app as Record<string, unknown>) : {}), ...attributes };
    for (const k of Object.keys(app)) if (app[k] === null) delete app[k];
    if (Object.keys(app).length > 40) throw unprocessable("TOO_MANY_ATTRIBUTES", "At most 40 attributes are kept");
    await ctx.db.run("UPDATE contacts SET attrs = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...attrs, app }), nowIso(ctx), contact.id);
    return c.json({ ok: true });
  });
  r.post("/attachments", async (c) => {
    const s = c.get("session");
    const form = await c.req.parseBody();
    const f = form["file"];
    if (!f || typeof f === "string") throw unprocessable("FILE_REQUIRED", "Send the file as multipart field 'file'");
    const att = await saveUpload(ctx, { workspaceId: s.workspace_id, memberId: s.id }, { name: f.name, type: f.type, content: Buffer.from(await f.arrayBuffer()) }, { allowMime: VISITOR_UPLOAD_MIME });
    return c.json({ ...att, url: ctx.storage.signedUrl(att.key, { fileName: att.file_name, contentType: att.content_type, ttlSeconds: ctx.config.SIGNED_URL_TTL_SECONDS }) }, 201);
  });
  r.get("/rooms", async (c) => c.json({ data: await visitorRoomDtos(ctx, await visitorRooms(ctx, c.get("session"))) }));
  r.post("/rooms", async (c) => {
    const body = validate(PublicRoomBody, await c.req.json().catch(() => ({})));
    const res = await visitorStartRoom(ctx, c.get("session"), { inbox_id: body.department_id ?? body.inbox_id, page_url: body.page_url, locale: body.locale });
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
  // rating of the latest ended ticket (or the one named); the room csat above stays for closed conversations
  r.post("/rooms/:id/ticket-csat", async (c) => {
    const body = await parseBody(c, TicketCsat);
    const room = await getVisitorRoom(ctx, c.get("session"), c.req.param("id"));
    const t = await rateTicket(ctx, room, body.score, body.comment, body.ticket_id);
    if (!t) throw new AppError(409, "CSAT_NOT_AVAILABLE", "There is no resolved ticket waiting for a rating");
    return c.json({ ok: true, ticket: visitorTicketDto(t) });
  });
  // a tap on a quick reply under a bot message ("Yes, thanks", "Talk to a person", a department)
  r.post("/rooms/:id/quick-reply", async (c) => c.json(await visitorQuickReply(ctx, c.get("session"), c.req.param("id"), await parseBody(c, QuickReplyBody))));
  // "Talk to a person": always available, whatever the workspace has switched on
  r.post("/rooms/:id/request-human", async (c) => c.json(await visitorRequestHuman(ctx, c.get("session"), c.req.param("id"))));
  r.post("/rooms/:id/messages/:messageId/feedback", async (c) => c.json(await visitorFeedback(ctx, c.get("session"), c.req.param("id"), c.req.param("messageId"), await parseBody(c, VisitorFeedback))));
  // the visitor answers (or skips) a form card in the thread: name, email, phone, consent and custom fields, validated here
  r.post("/rooms/:id/forms/:messageId", async (c) => c.json(await submitContactForm(ctx, c.get("session"), c.req.param("id"), c.req.param("messageId"), await parseBody(c, FormSubmission))));
  r.post("/rooms/:id/forms/:messageId/skip", async (c) => c.json(await skipContactForm(ctx, c.get("session"), c.req.param("id"), c.req.param("messageId"))));
  r.post("/otp/verify", async (c) => c.json(await verifyOtp(ctx, c.get("session"), (await parseBody(c, OtpVerify)).code)));

  return r;
}
