import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { forbidden } from "../errors.js";
import { parseBody, parseQuery, requireLiveSeat, requireManager, type Env } from "../http.js";
import { CreditGrant, ContactBody, ContactPatch, InboxBody, InboxPatch, MemberCreate, MemberPatch, WorkspacePatch } from "../schemas.js";
import {
  addNote,
  contactDto,
  createContact,
  deleteContact,
  deleteNote,
  getContact,
  importContactsCsv,
  listContacts,
  listNotes,
  updateContact,
} from "../services/contacts.js";
import { addInboxMember, createInbox, deleteInbox, getInbox, inboxDto, inboxDtos, listInboxes, removeInboxMember, updateInbox } from "../services/inboxes.js";
import { addMember, listMemberRows, memberDto, memberDtos, onlineMemberIds, removeMember, updateMember, getMember } from "../services/members.js";
import { rerouteRoom, roomCounts, listRooms } from "../services/rooms.js";
import { listLedger, recordUsage, updateWorkspace, workspaceDto } from "../services/workspaces.js";
import { z } from "zod";

export function teamRoutes(ctx: AppContext) {
  const r = new Hono<Env>();

  /* workspace */
  r.get("/workspace", async (c) => c.json(await workspaceDto(ctx, c.get("actor").workspaceId)));
  r.patch("/workspace", requireManager, async (c) => c.json(await updateWorkspace(ctx, c.get("actor").workspaceId, await parseBody(c, WorkspacePatch))));
  r.get("/credits", async (c) => {
    const a = c.get("actor");
    return c.json({ balance: (await workspaceDto(ctx, a.workspaceId)).credit_balance, ledger: await listLedger(ctx, a.workspaceId) });
  });
  r.post("/credits/grant", async (c) => {
    const a = c.get("actor");
    if (a.role !== "owner") throw forbidden("Only an owner can add credits");
    const b = await parseBody(c, CreditGrant);
    return c.json({ balance: await recordUsage(ctx, a.workspaceId, "grant", b.amount, b.note) }, 201);
  });
  r.get("/dashboard/counts", requireLiveSeat, async (c) => c.json((await roomCounts(ctx, c.get("actor"))).total));

  /* members / seats */
  r.get("/members", async (c) => c.json({ data: await memberDtos(ctx, await listMemberRows(ctx, c.get("actor").workspaceId)) }));
  r.post("/members", requireManager, async (c) => c.json(await memberDto(ctx, await addMember(ctx, c.get("actor"), await parseBody(c, MemberCreate))), 201));
  r.get("/members/me", async (c) => c.json(await memberDto(ctx, await getMember(ctx, c.get("actor").workspaceId, c.get("actor").memberId))));
  r.patch("/members/me", async (c) => {
    const a = c.get("actor");
    const b = await parseBody(c, MemberPatch.pick({ name: true, availability: true, dnd_until: true, notification_prefs: true }));
    return c.json(await memberDto(ctx, await updateMember(ctx, a, a.memberId, b)));
  });
  r.patch("/members/:id", async (c) => c.json(await memberDto(ctx, await updateMember(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, MemberPatch)))));
  r.delete("/members/:id", async (c) => {
    await removeMember(ctx, c.get("actor"), c.req.param("id"), (roomId) => rerouteRoom(ctx, roomId));
    return c.body(null, 204);
  });
  r.get("/presence", async (c) => {
    const ws = c.get("actor").workspaceId;
    return c.json({ online: await onlineMemberIds(ctx, ws) });
  });

  /* inboxes */
  r.get("/inboxes", async (c) => c.json({ data: await inboxDtos(ctx, await listInboxes(ctx, c.get("actor"))) }));
  r.get("/inboxes/counts", requireLiveSeat, async (c) => c.json(await roomCounts(ctx, c.get("actor"))));
  r.post("/inboxes", async (c) => c.json(await inboxDto(ctx, await createInbox(ctx, c.get("actor"), await parseBody(c, InboxBody))), 201));
  r.get("/inboxes/:id", async (c) => c.json(await inboxDto(ctx, await getInbox(ctx, c.get("actor").workspaceId, c.req.param("id")))));
  r.patch("/inboxes/:id", async (c) => c.json(await inboxDto(ctx, await updateInbox(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, InboxPatch)))));
  r.delete("/inboxes/:id", async (c) => {
    await deleteInbox(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/inboxes/:id/members/:memberId", async (c) =>
    c.json(await inboxDto(ctx, await addInboxMember(ctx, c.get("actor"), c.req.param("id"), c.req.param("memberId")))),
  );
  r.delete("/inboxes/:id/members/:memberId", async (c) =>
    c.json(await inboxDto(ctx, await removeInboxMember(ctx, c.get("actor"), c.req.param("id"), c.req.param("memberId")))),
  );

  /* contacts */
  const ContactList = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(300).optional(), search: z.string().max(200).optional(), tag: z.string().max(50).optional() });
  r.get("/contacts", async (c) => c.json(await listContacts(ctx, c.get("actor").workspaceId, parseQuery(c, ContactList))));
  r.post("/contacts", async (c) => {
    const b = await parseBody(c, ContactBody);
    return c.json(await contactDto(ctx, await createContact(ctx, c.get("actor").workspaceId, { ...b, email: b.email || null })), 201);
  });
  r.post("/contacts/import", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let csv: string;
    if (ct.includes("multipart/form-data")) {
      const f = (await c.req.parseBody())["file"];
      csv = typeof f === "string" ? f : f ? await f.text() : "";
    } else csv = await c.req.text();
    return c.json(await importContactsCsv(ctx, c.get("actor").workspaceId, csv));
  });
  r.get("/contacts/:id", async (c) => c.json(await contactDto(ctx, await getContact(ctx, c.get("actor").workspaceId, c.req.param("id")))));
  r.patch("/contacts/:id", async (c) => {
    const b = await parseBody(c, ContactPatch);
    return c.json(await contactDto(ctx, await updateContact(ctx, c.get("actor"), c.req.param("id"), { ...b, email: b.email === "" ? null : b.email })));
  });
  r.delete("/contacts/:id", async (c) => {
    await deleteContact(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.get("/contacts/:id/notes", async (c) => c.json({ data: await listNotes(ctx, c.get("actor").workspaceId, c.req.param("id")) }));
  r.post("/contacts/:id/notes", async (c) =>
    c.json(await addNote(ctx, c.get("actor"), c.req.param("id"), (await parseBody(c, z.object({ body: z.string().trim().min(1).max(4000) }))).body), 201),
  );
  r.delete("/contacts/:id/notes/:noteId", async (c) => {
    await deleteNote(ctx, c.get("actor"), c.req.param("id"), c.req.param("noteId"));
    return c.body(null, 204);
  });
  r.get("/contacts/:id/rooms", requireLiveSeat, async (c) => {
    const a = c.get("actor");
    await getContact(ctx, a.workspaceId, c.req.param("id"));
    return c.json({ data: (await listRooms(ctx, a, { status: "all", contact_id: c.req.param("id"), page: 1, limit: 20 })).data });
  });
  return r;
}
