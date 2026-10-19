import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { forbidden } from "../errors.js";
import { parseBody, parseQuery, requireLiveSeat, requireManager, type Env } from "../http.js";
import { CreditGrant, ContactBody, ContactPatch, InboxBody, InboxPatch, MemberCreate, MemberPatch, Pagination, WorkspacePatch } from "../schemas.js";
import { addNote, contactDto, createContact, deleteContact, deleteNote, getContact, importContactsCsv, listContacts, listNotes, updateContact } from "../services/contacts.js";
import { addInboxMember, createInbox, deleteInbox, getInbox, inboxDto, listInboxes, removeInboxMember, updateInbox } from "../services/inboxes.js";
import { addMember, listMemberRows, memberDto, memberScope, removeMember, updateMember, getMember } from "../services/members.js";
import { rerouteRoom, roomCounts, listRooms } from "../services/rooms.js";
import { listLedger, recordUsage, updateWorkspace, workspaceDto } from "../services/workspaces.js";
import { z } from "zod";

export function teamRoutes(ctx: AppContext) {
  const r = new Hono<Env>();

  /* workspace */
  r.get("/workspace", (c) => c.json(workspaceDto(ctx, c.get("actor").workspaceId)));
  r.patch("/workspace", requireManager, async (c) => c.json(updateWorkspace(ctx, c.get("actor").workspaceId, await parseBody(c, WorkspacePatch))));
  r.get("/credits", (c) => {
    const a = c.get("actor");
    return c.json({ balance: workspaceDto(ctx, a.workspaceId).credit_balance, ledger: listLedger(ctx, a.workspaceId) });
  });
  r.post("/credits/grant", async (c) => {
    const a = c.get("actor");
    if (a.role !== "owner") throw forbidden("Only an owner can add credits");
    const b = await parseBody(c, CreditGrant);
    return c.json({ balance: recordUsage(ctx, a.workspaceId, "grant", b.amount, b.note) }, 201);
  });
  r.get("/dashboard/counts", requireLiveSeat, (c) => c.json(roomCounts(ctx, c.get("actor")).total));

  /* members / seats */
  r.get("/members", (c) => c.json({ data: listMemberRows(ctx, c.get("actor").workspaceId).map((m) => memberDto(ctx, m)) }));
  r.post("/members", requireManager, async (c) => c.json(memberDto(ctx, await addMember(ctx, c.get("actor"), await parseBody(c, MemberCreate))), 201));
  r.get("/members/me", (c) => c.json(memberDto(ctx, getMember(ctx, c.get("actor").workspaceId, c.get("actor").memberId))));
  r.patch("/members/me", async (c) => {
    const a = c.get("actor");
    const b = await parseBody(c, MemberPatch.pick({ name: true, availability: true, dnd_until: true, notification_prefs: true }));
    return c.json(memberDto(ctx, updateMember(ctx, a, a.memberId, b)));
  });
  r.patch("/members/:id", async (c) => c.json(memberDto(ctx, updateMember(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, MemberPatch)))));
  r.delete("/members/:id", (c) => {
    removeMember(ctx, c.get("actor"), c.req.param("id"), (roomId) => rerouteRoom(ctx, roomId));
    return c.body(null, 204);
  });
  r.get("/presence", (c) => {
    const ws = c.get("actor").workspaceId;
    return c.json({ online: listMemberRows(ctx, ws).filter((m) => ctx.presence.isOnline(memberScope(ws), m.id)).map((m) => m.id) });
  });

  /* inboxes */
  r.get("/inboxes", (c) => c.json({ data: listInboxes(ctx, c.get("actor")).map((i) => inboxDto(ctx, i)) }));
  r.get("/inboxes/counts", requireLiveSeat, (c) => c.json(roomCounts(ctx, c.get("actor"))));
  r.post("/inboxes", async (c) => c.json(inboxDto(ctx, createInbox(ctx, c.get("actor"), await parseBody(c, InboxBody))), 201));
  r.get("/inboxes/:id", (c) => c.json(inboxDto(ctx, getInbox(ctx, c.get("actor").workspaceId, c.req.param("id")))));
  r.patch("/inboxes/:id", async (c) => c.json(inboxDto(ctx, updateInbox(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, InboxPatch)))));
  r.delete("/inboxes/:id", (c) => {
    deleteInbox(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.post("/inboxes/:id/members/:memberId", (c) => c.json(inboxDto(ctx, addInboxMember(ctx, c.get("actor"), c.req.param("id"), c.req.param("memberId")))));
  r.delete("/inboxes/:id/members/:memberId", (c) => c.json(inboxDto(ctx, removeInboxMember(ctx, c.get("actor"), c.req.param("id"), c.req.param("memberId")))));

  /* contacts */
  const ContactList = Pagination.extend({ search: z.string().max(200).optional(), tag: z.string().max(50).optional() });
  r.get("/contacts", (c) => c.json(listContacts(ctx, c.get("actor").workspaceId, parseQuery(c, ContactList))));
  r.post("/contacts", async (c) => {
    const b = await parseBody(c, ContactBody);
    return c.json(contactDto(ctx, createContact(ctx, c.get("actor").workspaceId, { ...b, email: b.email || null })), 201);
  });
  r.post("/contacts/import", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    let csv: string;
    if (ct.includes("multipart/form-data")) {
      const f = (await c.req.parseBody())["file"];
      csv = typeof f === "string" ? f : f ? await f.text() : "";
    } else csv = await c.req.text();
    return c.json(importContactsCsv(ctx, c.get("actor").workspaceId, csv));
  });
  r.get("/contacts/:id", (c) => c.json(contactDto(ctx, getContact(ctx, c.get("actor").workspaceId, c.req.param("id")))));
  r.patch("/contacts/:id", async (c) => {
    const b = await parseBody(c, ContactPatch);
    return c.json(contactDto(ctx, updateContact(ctx, c.get("actor"), c.req.param("id"), { ...b, email: b.email === "" ? null : b.email })));
  });
  r.delete("/contacts/:id", (c) => {
    deleteContact(ctx, c.get("actor"), c.req.param("id"));
    return c.body(null, 204);
  });
  r.get("/contacts/:id/notes", (c) => c.json({ data: listNotes(ctx, c.get("actor").workspaceId, c.req.param("id")) }));
  r.post("/contacts/:id/notes", async (c) => c.json(addNote(ctx, c.get("actor"), c.req.param("id"), (await parseBody(c, z.object({ body: z.string().trim().min(1).max(4000) }))).body), 201));
  r.delete("/contacts/:id/notes/:noteId", (c) => {
    deleteNote(ctx, c.get("actor"), c.req.param("id"), c.req.param("noteId"));
    return c.body(null, 204);
  });
  r.get("/contacts/:id/rooms", requireLiveSeat, (c) => {
    const a = c.get("actor");
    getContact(ctx, a.workspaceId, c.req.param("id"));
    return c.json(listRooms(ctx, a, { status: "all", contact_id: c.req.param("id"), page: 1, limit: 20 }));
  });
  return r;
}
