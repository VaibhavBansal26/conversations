import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { parseBody, parseQuery, requireLiveSeat, type Env } from "../http.js";
import { TicketAssignAgent, TicketBulk, TicketMerge, TicketPatch, TicketQuery, TicketTransfer } from "../schemas.js";
import { claimTicket, transferTicket } from "../services/routing.js";
import { assignTicketToAgent, handBackTicket } from "../agents/handover.js";
import { handleAgentTurn } from "../agents/pipeline.js";
import type { MessageRow } from "../services/messageStore.js";
import { getRoomRow, getVisibleRoom } from "../services/roomStore.js";
import {
  bulkTickets,
  closeTicket,
  getTicketDetail,
  getVisibleTicket,
  listTickets,
  mergeTickets,
  reopenTicket,
  resolveTicket,
  ticketCounts,
  ticketDto,
  ticketsOfContact,
  ticketsOfRoom,
  updateTicket,
} from "../services/tickets.js";
import { getContact } from "../services/contacts.js";

export function ticketRoutes(ctx: AppContext) {
  const r = new Hono<Env>();
  for (const path of ["/tickets", "/tickets/*", "/rooms/:id/tickets", "/contacts/:id/tickets"]) r.use(path, requireLiveSeat);

  r.get("/tickets", async (c) => c.json(await listTickets(ctx, c.get("actor"), parseQuery(c, TicketQuery))));
  r.get("/tickets/counts", async (c) => c.json(await ticketCounts(ctx, c.get("actor"))));
  r.post("/tickets/bulk", async (c) => c.json(await bulkTickets(ctx, c.get("actor"), await parseBody(c, TicketBulk))));
  r.get("/tickets/:id", async (c) => c.json(await getTicketDetail(ctx, c.get("actor"), c.req.param("id"))));
  r.patch("/tickets/:id", async (c) => c.json(ticketDto(await updateTicket(ctx, c.get("actor"), c.req.param("id"), await parseBody(c, TicketPatch)))));
  r.post("/tickets/:id/resolve", async (c) => c.json(ticketDto(await resolveTicket(ctx, c.get("actor"), c.req.param("id")))));
  r.post("/tickets/:id/close", async (c) => c.json(ticketDto(await closeTicket(ctx, c.get("actor"), c.req.param("id")))));
  r.post("/tickets/:id/reopen", async (c) => c.json(ticketDto(await reopenTicket(ctx, c.get("actor"), c.req.param("id")))));
  r.post("/tickets/:id/merge", async (c) => c.json(ticketDto(await mergeTickets(ctx, c.get("actor"), c.req.param("id"), (await parseBody(c, TicketMerge)).into_id))));

  r.post("/tickets/:id/claim", async (c) => c.json(ticketDto(await claimTicket(ctx, c.get("actor"), c.req.param("id")))));
  r.post("/tickets/:id/assign-agent", async (c) => {
    const row = await assignTicketToAgent(ctx, c.get("actor"), c.req.param("id"), (await parseBody(c, TicketAssignAgent)).agent_id);
    // the visitor wrote last and nobody answered: the agent answers that message now instead of waiting for the next one
    await ctx.background.run(async () => {
      const last = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND kind NOT IN ('note','system') ORDER BY seq DESC LIMIT 1", row.room_id);
      if (last && last.sender_type === "contact" && last.source === "dm") await handleAgentTurn(ctx, await getRoomRow(ctx, row.workspace_id, row.room_id), last);
    });
    return c.json(ticketDto(row));
  });
  r.post("/tickets/:id/hand-back", async (c) => c.json(ticketDto(await handBackTicket(ctx, c.get("actor"), c.req.param("id")))));
  r.post("/tickets/:id/transfer", async (c) => {
    const a = c.get("actor");
    const b = await parseBody(c, TicketTransfer);
    await getVisibleTicket(ctx, a, c.req.param("id"));
    const res = await transferTicket(ctx, c.req.param("id"), { to: b.department_id, note: b.note, by: { type: "member", id: a.memberId } });
    return c.json({ ticket: ticketDto(res.ticket), outcome: res.outcome, department_id: res.department?.id ?? null, assignee_id: res.assignee?.id ?? null });
  });
  r.get("/rooms/:id/tickets", async (c) => {
    const a = c.get("actor");
    const room = await getVisibleRoom(ctx, a, c.req.param("id"));
    return c.json({ data: await ticketsOfRoom(ctx, a, (await getRoomRow(ctx, a.workspaceId, room.id)).id) });
  });
  r.get("/contacts/:id/tickets", async (c) => {
    const a = c.get("actor");
    const contact = await getContact(ctx, a.workspaceId, c.req.param("id"));
    return c.json({ data: await ticketsOfContact(ctx, a, contact.id) });
  });
  return r;
}
