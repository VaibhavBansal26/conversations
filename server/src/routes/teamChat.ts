import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { unprocessable } from "../errors.js";
import { enforce } from "../ratelimit/http.js";
import { parseBody, parseQuery, type Env } from "../http.js";
import {
  TeamChannelCreate,
  TeamChannelPatch,
  TeamDmBody,
  TeamEditBody,
  TeamListQuery,
  TeamMembersBody,
  TeamMuteBody,
  TeamReactionBody,
  TeamReadBody,
  TeamSearchQuery,
  TeamSendBody,
} from "../schemas.js";
import { saveUpload } from "../services/attachments.js";
import {
  addChannelMembers,
  browseChannels,
  createChannel,
  deleteTeamMessage,
  editTeamMessage,
  getChannel,
  getThread,
  joinChannel,
  leaveChannel,
  listChannels,
  listPins,
  listTeamMessages,
  markTeamRead,
  openDm,
  removeChannelMember,
  searchTeam,
  sendTeamMessage,
  setMuted,
  setPinned,
  toggleReaction,
  updateChannel,
} from "../services/teamChat.js";

/** Internal team chat. Every route needs `team_chat:use` (channel creation `team_chat:manage_channels`); the service decides what the caller may see in each channel. */
export function teamChatRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  const a = (c: { get: (k: "actor") => import("../domain/types.js").Actor }) => c.get("actor");

  r.get("/team/channels", async (c) => c.json(await listChannels(ctx, a(c))));
  r.get("/team/channels/browse", async (c) => c.json(await browseChannels(ctx, a(c))));
  r.post("/team/channels", async (c) => {
    await enforce(ctx, "team.create", { key: a(c).workspaceId, workspaceId: a(c).workspaceId });
    return c.json(await createChannel(ctx, a(c), await parseBody(c, TeamChannelCreate)), 201);
  });
  r.post("/team/dms", async (c) => {
    await enforce(ctx, "team.create", { key: a(c).workspaceId, workspaceId: a(c).workspaceId });
    const res = await openDm(ctx, a(c), (await parseBody(c, TeamDmBody)).member_ids);
    return c.json(res.channel, res.created ? 201 : 200);
  });
  r.get("/team/channels/:id", async (c) => c.json(await getChannel(ctx, a(c), c.req.param("id"))));
  r.patch("/team/channels/:id", async (c) => c.json(await updateChannel(ctx, a(c), c.req.param("id"), await parseBody(c, TeamChannelPatch))));
  r.post("/team/channels/:id/join", async (c) => c.json(await joinChannel(ctx, a(c), c.req.param("id"))));
  r.post("/team/channels/:id/leave", async (c) => {
    await leaveChannel(ctx, a(c), c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/team/channels/:id/members", async (c) => c.json(await addChannelMembers(ctx, a(c), c.req.param("id"), (await parseBody(c, TeamMembersBody)).member_ids)));
  r.delete("/team/channels/:id/members/:memberId", async (c) => {
    await removeChannelMember(ctx, a(c), c.req.param("id"), c.req.param("memberId"));
    return c.body(null, 204);
  });
  r.put("/team/channels/:id/mute", async (c) => c.json(await setMuted(ctx, a(c), c.req.param("id"), (await parseBody(c, TeamMuteBody)).muted)));
  r.post("/team/channels/:id/read", async (c) => c.json(await markTeamRead(ctx, a(c), c.req.param("id"), (await parseBody(c, TeamReadBody)).message_id)));

  r.get("/team/channels/:id/messages", async (c) => c.json(await listTeamMessages(ctx, a(c), c.req.param("id"), parseQuery(c, TeamListQuery))));
  r.post("/team/channels/:id/messages", async (c) => {
    const res = await sendTeamMessage(ctx, a(c), c.req.param("id"), await parseBody(c, TeamSendBody));
    return c.json(res.message, res.created ? 201 : 200);
  });
  r.get("/team/channels/:id/pins", async (c) => c.json(await listPins(ctx, a(c), c.req.param("id"))));
  r.get("/team/messages/:id/thread", async (c) => c.json(await getThread(ctx, a(c), c.req.param("id"))));
  r.patch("/team/messages/:id", async (c) => c.json(await editTeamMessage(ctx, a(c), c.req.param("id"), (await parseBody(c, TeamEditBody)).content)));
  r.delete("/team/messages/:id", async (c) => {
    await deleteTeamMessage(ctx, a(c), c.req.param("id"));
    return c.body(null, 204);
  });
  // moderation: delete someone else's message (audited); a separate route so the permission is checked before the handler runs
  r.delete("/team/channels/:id/messages/:messageId", async (c) => {
    await deleteTeamMessage(ctx, a(c), c.req.param("messageId"), { moderate: true });
    return c.body(null, 204);
  });
  r.post("/team/messages/:id/reactions", async (c) => c.json(await toggleReaction(ctx, a(c), c.req.param("id"), (await parseBody(c, TeamReactionBody)).emoji)));
  r.put("/team/messages/:id/pin", async (c) => c.json(await setPinned(ctx, a(c), c.req.param("id"), true)));
  r.delete("/team/messages/:id/pin", async (c) => c.json(await setPinned(ctx, a(c), c.req.param("id"), false)));

  r.get("/team/search", async (c) => c.json(await searchTeam(ctx, a(c), parseQuery(c, TeamSearchQuery))));

  // same pipeline, limits and size caps as customer attachments; the file is then attached to a team message by id
  r.post("/team/attachments", async (c) => {
    const form = await c.req.parseBody();
    const f = form["file"];
    if (!f || typeof f === "string") throw unprocessable("FILE_REQUIRED", "Send the file as multipart field 'file'");
    const att = await saveUpload(ctx, a(c), { name: f.name, type: f.type, content: Buffer.from(await f.arrayBuffer()) });
    return c.json({ ...att, url: ctx.storage.signedUrl(att.key, { fileName: att.file_name, contentType: att.content_type, ttlSeconds: ctx.config.SIGNED_URL_TTL_SECONDS }) }, 201);
  });
  return r;
}
