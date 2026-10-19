import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { unprocessable } from "../errors.js";
import { parseBody, parseQuery, rateLimit, requireLiveSeat, type Env } from "../http.js";
import {
  AssignBody, BulkBody, EditMessageBody, MessageListQuery, ReadBody, RoomCreate, RoomPatch, RoomQuery, SearchQuery, SendMessageBody, SnoozeBody,
} from "../schemas.js";
import { saveUpload } from "../services/attachments.js";
import { deleteMessage, editMessage, listMessagesForAgent, retryMessage, searchMessages, sendAgentMessage, viewMessage } from "../services/messages.js";
import {
  archiveRoom, assignRoom, bulkRooms, getRoomDto, listRooms, markRead, setFavorite, setPriority, setStatus, setSubject,
  snoozeRoom, startConversation, unsnoozeRoom, type RoomFilters,
} from "../services/rooms.js";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../services/notifications.js";
import { z } from "zod";

export function roomRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  // scoped by path: a manager without a live seat must still reach the settings routes mounted after this router
  for (const path of ["/rooms", "/rooms/*", "/messages/*", "/attachments", "/notifications", "/notifications/*"]) r.use(path, requireLiveSeat);

  r.get("/rooms", (c) => {
    const q = parseQuery(c, RoomQuery);
    const f: RoomFilters = {
      status: q.status, inbox_id: q.inbox_id, contact_id: q.contact_id, search: q.search, sort: q.sort, page: q.page, limit: q.limit,
      assigned_to_me: q.assigned_to_me ?? q.filter === "assigned_to_me", unassigned: q.unassigned ?? q.filter === "unassigned",
      mentions: q.mentions ?? q.filter === "mentions", priority: q.priority ?? q.filter === "priority", favorites: q.filter === "favorites",
    };
    return c.json(listRooms(ctx, c.get("actor"), f));
  });

  r.post("/rooms", async (c) => {
    const a = c.get("actor");
    const b = await parseBody(c, RoomCreate);
    const res = startConversation(ctx, a, b);
    let message;
    if (b.message) message = viewMessage(ctx, (await sendAgentMessage(ctx, a, res.room.id, b.message)).message);
    return c.json({ room: getRoomDto(ctx, a, res.room.id), created: res.created, message }, res.created ? 201 : 200);
  });

  r.post("/rooms/bulk", async (c) => c.json(bulkRooms(ctx, c.get("actor"), await parseBody(c, BulkBody))));
  r.get("/rooms/:id", (c) => c.json(getRoomDto(ctx, c.get("actor"), c.req.param("id"))));

  r.patch("/rooms/:id", async (c) => {
    const a = c.get("actor");
    const id = c.req.param("id");
    const b = await parseBody(c, RoomPatch);
    if (b.snooze_until !== undefined) b.snooze_until === null ? unsnoozeRoom(ctx, a, id) : snoozeRoom(ctx, a, id, b.snooze_until);
    if (b.status) setStatus(ctx, a, id, b.status);
    if (b.priority !== undefined) setPriority(ctx, a, id, b.priority);
    if (b.subject !== undefined) setSubject(ctx, a, id, b.subject);
    return c.json(getRoomDto(ctx, a, id));
  });
  r.delete("/rooms/:id", (c) => {
    archiveRoom(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/rooms/:id/assign", async (c) => {
    const a = c.get("actor");
    assignRoom(ctx, a, c.req.param("id"), await parseBody(c, AssignBody));
    return c.json(getRoomDto(ctx, a, c.req.param("id")));
  });
  r.post("/rooms/:id/snooze", async (c) => {
    const a = c.get("actor");
    snoozeRoom(ctx, a, c.req.param("id"), (await parseBody(c, SnoozeBody)).until);
    return c.json(getRoomDto(ctx, a, c.req.param("id")));
  });
  r.delete("/rooms/:id/snooze", (c) => {
    const a = c.get("actor");
    unsnoozeRoom(ctx, a, c.req.param("id"));
    return c.json(getRoomDto(ctx, a, c.req.param("id")));
  });
  r.put("/rooms/:id/favorite", (c) => c.json(setFavorite(ctx, c.get("actor"), c.req.param("id"), true)));
  r.delete("/rooms/:id/favorite", (c) => c.json(setFavorite(ctx, c.get("actor"), c.req.param("id"), false)));
  r.post("/rooms/:id/read", async (c) => c.json(markRead(ctx, c.get("actor"), c.req.param("id"), (await parseBody(c, ReadBody)).message_id)));

  r.get("/rooms/:id/messages", (c) => c.json(listMessagesForAgent(ctx, c.get("actor"), c.req.param("id"), parseQuery(c, MessageListQuery))));
  r.post("/rooms/:id/messages", rateLimit(ctx, "send", 60, 2, (c) => (c.get("actor" as never) as { memberId: string }).memberId), async (c) => {
    const res = await sendAgentMessage(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, SendMessageBody));
    return c.json(viewMessage(ctx, res.message), res.created ? 201 : 200);
  });
  r.get("/messages/search", (c) => c.json({ data: searchMessages(ctx, c.get("actor"), parseQuery(c, SearchQuery)) }));
  r.patch("/messages/:id", async (c) => c.json(viewMessage(ctx, editMessage(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, EditMessageBody)))));
  r.delete("/messages/:id", (c) => {
    deleteMessage(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/messages/:id/retry", async (c) => c.json(viewMessage(ctx, await retryMessage(ctx, c.get("actor"), c.req.param("id")))));

  r.post("/attachments", rateLimit(ctx, "upload", 30, 0.5, (c) => c.req.header("authorization") ?? "anon"), async (c) => {
    const form = await c.req.parseBody();
    const f = form["file"];
    if (!f || typeof f === "string") throw unprocessable("FILE_REQUIRED", "Send the file as multipart field 'file'");
    const att = await saveUpload(ctx, c.get("actor"), { name: f.name, type: f.type, content: Buffer.from(await f.arrayBuffer()) });
    return c.json({ ...att, url: ctx.storage.signedUrl(att.key, { fileName: att.file_name, contentType: att.content_type, ttlSeconds: ctx.config.SIGNED_URL_TTL_SECONDS }) }, 201);
  });

  /* notifications feed (any live seat) */
  r.get("/notifications", (c) => c.json(listNotifications(ctx, c.get("actor"), parseQuery(c, z.object({ unread_only: z.enum(["true", "false"]).optional().transform((v) => v === "true"), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.string().optional() })))));
  r.post("/notifications/read-all", (c) => c.json(markAllNotificationsRead(ctx, c.get("actor"))));
  r.post("/notifications/:id/read", (c) => c.json(markNotificationRead(ctx, c.get("actor"), c.req.param("id"))));

  return r;
}
