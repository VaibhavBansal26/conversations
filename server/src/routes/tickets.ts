import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { parseBody, parseQuery, requireLiveSeat, type Env } from "../http.js";
import { TicketBulk, TicketMerge, TicketPatch, TicketQuery } from "../schemas.js";
import { getRoomRow, getVisibleRoom } from "../services/roomStore.js";
import {
  bulkTickets,
  closeTicket,
  getTicketDetail,
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
