import type { AppContext } from "../context.js";
import { buildThread, chooseEmailSender, chooseSmsNumber, deriveSubject, isE164, lockChannel } from "../channels/rules.js";
import { inQuietHours } from "../calls/phone.js";
import { deliverMessage } from "../services/delivery.js";
import { getContact } from "../services/contacts.js";
import { emitInserted, insertMessage, postSystemMessage, type MessageRow } from "../services/messageStore.js";
import { getRoomRow, type RoomRow } from "../services/roomStore.js";
import { handoffTicket } from "../services/routing.js";
import { announceResolved, liveTicketOf, publishTickets, resolveTicketRow } from "../services/tickets.js";
import { getSettings, verifyBalance } from "../services/workspaces.js";
import { recordAudit } from "../services/audit.js";
import { parseJson } from "../util/json.js";
import { textToHtml } from "../util/html.js";
import { agentDto, selectAgent, type AgentDto } from "./config.js";
import { asksForHuman, fitSms, optionsLine, pickOption, plainText, stripQuoted, type ChannelOption } from "./channelText.js";
import { agentMeta, handleAgentTurn, type TurnCapture } from "./pipeline.js";

/**
 * AI agents answering SMS and email (docs/AI-AGENTS.md "AI agents on SMS and email"). The same pipeline as the chat widget (classification, the
 * knowledge base, the safety guards, hand-off triggers, the AI budget, redaction) decides; this module decides WHETHER the AI may answer at all on
 * these channels, and turns the answer into a plain-text SMS or email sent through the workspace's own providers and the normal delivery pipeline
 * (test mode stays honest: `not_sent_test_mode`, nothing billed).
 *
 * The AI never answers: automatic messages (out-of-office, bounces, mailing lists, no-reply senders, other bots, short codes), STOP/START keywords,
 * contacts who opted out or unsubscribed, at night (SMS quiet hours), more than N times per conversation per 24 hours (a person takes over), or faster
 * than the per-contact rate limit. In each case the team gets the message the usual way.
 */
export type ReplyChannel = "sms" | "email";
const isChannel = (s: string): s is ReplyChannel => s === "sms" || s === "email";

async function skipped(ctx: AppContext, room: RoomRow, ticketId: string, reason: string, line: string): Promise<"none"> {
  // say it to the team once per ticket and reason (an internal line: the customer never sees it)
  const seen = await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND ticket_id = ? AND kind = 'system' AND meta LIKE ? LIMIT 1", room.id, ticketId, `%"ai_skip":"${reason}"%`);
  if (!seen) await postSystemMessage(ctx, room.id, room.workspace_id, line, { sub_type: "ai_skip", ai_skip: reason, internal: true });
  return "none";
}

/** AI replies sent on this channel in this conversation in the last 24 hours. */
async function repliesToday(ctx: AppContext, roomId: string, channel: ReplyChannel): Promise<number> {
  const since = new Date(ctx.clock().getTime() - 86_400_000).toISOString();
  return Number((await ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND sender_type = 'bot' AND source = ? AND created_at >= ? AND deleted_at IS NULL", roomId, channel, since))!.n);
}

/** The last AI message of this ticket that offered numbered options, if they are still open. */
async function openOptions(ctx: AppContext, room: RoomRow, ticketId: string, channel: ReplyChannel): Promise<{ msg: MessageRow; options: ChannelOption[]; purpose: string; reason?: string } | null> {
  const m = await ctx.db.get<MessageRow>("SELECT * FROM messages WHERE room_id = ? AND ticket_id = ? AND sender_type = 'bot' AND source = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1", room.id, ticketId, channel);
  if (!m) return null;
  const meta = parseJson<{ options?: ChannelOption[]; options_purpose?: string; options_answered?: string; options_reason?: string }>(m.meta, {});
  if (!meta.options?.length || meta.options_answered) return null;
  return { msg: m, options: meta.options, purpose: meta.options_purpose ?? "solved", reason: meta.options_reason };
}

/** Entry point from `onContactMessage` for SMS and email. "handled" means the team is told through the hand-off, not once per message. */
export async function handleChannelMessage(ctx: AppContext, room: RoomRow, message: MessageRow): Promise<"handled" | "none"> {
  if (message.sender_type !== "contact" || !isChannel(message.source)) return "none";
  const channel = message.source;
  const ws = room.workspace_id;
  const settings = await getSettings(ctx, ws);
  const s = settings.ai_channels[channel];
  if (!s.enabled) return "none";
  const ticket = await liveTicketOf(ctx, room.id);
  if (!ticket || ticket.status === "resolved") return "none";
  const sel = await selectAgent(ctx, ws, { channel, departmentId: ticket.department_id ?? room.inbox_id });
  if (!sel) return "none";
  if (ticket.handler?.startsWith("human:") || ticket.status === "waiting_for_human") return "none";
  const meta = parseJson<{ auto?: string; keyword?: string }>(message.meta, {});
  if (meta.keyword) return "none";
  if (meta.auto) return skipped(ctx, room, ticket.id, `auto_${meta.auto}`, `The AI agent did not answer: this looks like an automatic message (${meta.auto.replace(/_/g, " ")}).`);
  const contact = await getContact(ctx, ws, room.contact_id);
  if (channel === "sms" && contact.sms_opt_out) return skipped(ctx, room, ticket.id, "opted_out", "The AI agent did not answer: the contact opted out of SMS.");
  if (channel === "email" && contact.unsubscribed) return skipped(ctx, room, ticket.id, "unsubscribed", "The AI agent did not answer: the contact unsubscribed from email.");
  const q = settings.ai_channels.sms.quiet_hours;
  if (channel === "sms" && q.enabled) {
    const zone = parseJson<{ timezone?: string }>(contact.attrs, {}).timezone ?? settings.widget.office_hours.timezone ?? "UTC";
    if (inQuietHours(zone, ctx.clock(), q.start, q.end)) return skipped(ctx, room, ticket.id, "quiet_hours", `The AI agent does not text at night (${q.start} to ${q.end}, ${zone}): a person will answer.`);
  }
  const a = agentDto(sel.agent);
  if ((await repliesToday(ctx, room.id, channel)) >= s.max_replies_per_day) {
    await handoffTicket(ctx, ticket.id, { reason: "bot_reply_limit", by: { type: "bot", id: a.id } });
    await recordAudit(ctx, { workspaceId: ws, actor: { type: "system" }, action: "ai_agent.handoff", target: ticket.id, detail: { agent_id: a.id, reason: "bot_reply_limit", channel } });
    await skipped(ctx, room, ticket.id, "reply_limit", `The AI agent stopped after ${s.max_replies_per_day} replies in 24 hours in this conversation: a person takes over.`);
    return "handled";
  }
  const rl = await ctx.ratelimit.check("ai.channel.contact", { key: `${ws}:${room.contact_id}:${channel}`, workspaceId: ws });
  if (!rl.allowed) return skipped(ctx, room, ticket.id, "rate_limited", "The AI agent did not answer: this contact wrote too often in a short time.");

  const text = channel === "email" ? stripQuoted(message.content_text) : message.content_text.trim();
  // numbered options of the last AI message ("Reply 1 for yes ...")
  const open = await openOptions(ctx, room, ticket.id, channel);
  const picked = open ? pickOption(text, open.options) : null;
  if (open && picked) {
    await ctx.db.run("UPDATE messages SET meta = ? WHERE id = ? AND room_id = ?", JSON.stringify({ ...parseJson<Record<string, unknown>>(open.msg.meta, {}), options_answered: picked.id }), open.msg.id, room.id);
    if (open.purpose === "solved" && picked.id === "yes") {
      const row = await resolveTicketRow(ctx, ticket.id, { type: "contact" }, { resolution: "bot_resolved", reason: "visitor_confirmed" });
      if (row && row.status === "resolved") await announceResolved(ctx, row);
      await publishTickets(ctx, [ticket.id]);
      await sendChannelReply(ctx, room, a, channel, "Glad I could help. Write again any time.", { kind: "resolved" }).catch(() => undefined);
      return "handled";
    }
    if (picked.id === "human" || (open.purpose === "department" && picked.id.startsWith("dept:"))) {
      await handoffTicket(ctx, ticket.id, { reason: picked.id === "human" ? "customer_requested_human" : open.reason ?? "model_handoff", by: { type: "contact" }, departmentId: picked.id.startsWith("dept:") ? picked.id.slice(5) : undefined });
      await handoffNotice(ctx, room, a, channel, ticket.id);
      return "handled";
    }
    // "not quite": the agent tries again, knowing the answer did not help
    return afterTurn(ctx, room, a, channel, ticket.id, await handleAgentTurn(ctx, room, message, { dissatisfied: true, channel, text }));
  }
  if (asksForHuman(text)) {
    await handoffTicket(ctx, ticket.id, { reason: "customer_requested_human", by: { type: "contact" } });
    await handoffNotice(ctx, room, a, channel, ticket.id);
    return "handled";
  }
  const capture: TurnCapture = {};
  return afterTurn(ctx, room, a, channel, ticket.id, await handleAgentTurn(ctx, room, message, { channel, text, capture }));
}

/** After a turn: a hand-off (by the model, a trigger, the hours) is told to the customer once, on their channel. */
async function afterTurn(ctx: AppContext, room: RoomRow, a: AgentDto, channel: ReplyChannel, ticketId: string, r: "handled" | "none"): Promise<"handled" | "none"> {
  const t = await ctx.db.get<{ status: string; handler: string | null }>("SELECT status, handler FROM tickets WHERE id = ?", ticketId);
  if (t && (t.status === "waiting_for_human" || t.handler?.startsWith("human:"))) await handoffNotice(ctx, room, a, channel, ticketId);
  return r;
}

async function handoffNotice(ctx: AppContext, room: RoomRow, a: AgentDto, channel: ReplyChannel, ticketId: string) {
  const sent = await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND ticket_id = ? AND sender_type = 'bot' AND meta LIKE '%\"handoff_notice\":true%' LIMIT 1", room.id, ticketId);
  if (sent) return;
  await sendChannelReply(ctx, room, a, channel, "Thanks. I have passed this to our team: a person will reply here.", { kind: "handoff", meta: { handoff_notice: true } }).catch((e) => ctx.log.warn("hand-off notice not sent", { error: e instanceof Error ? e.message : String(e) }));
}

/**
 * One AI reply as an SMS or email: plain text, the AI disclosure in the first reply of a ticket (and an email sign-off on every one), numbered options
 * instead of buttons, the channel's length limits, then the normal delivery pipeline (the workspace's providers, test mode, credits, retries).
 */
export async function sendChannelReply(
  ctx: AppContext,
  room: RoomRow,
  a: AgentDto,
  channel: ReplyChannel,
  text: string,
  o: { kind: string; options?: ChannelOption[]; optionsPurpose?: string; optionsReason?: string; meta?: Record<string, unknown> },
): Promise<MessageRow> {
  const ws = room.workspace_id;
  const settings = await getSettings(ctx, ws);
  const contact = await getContact(ctx, ws, room.contact_id);
  const ticket = await liveTicketOf(ctx, room.id);
  const first = !(ticket
    ? await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND sender_type = 'bot' AND source = ? AND deleted_at IS NULL AND ticket_id = ? LIMIT 1", room.id, channel, ticket.id)
    : await ctx.db.get("SELECT 1 FROM messages WHERE room_id = ? AND sender_type = 'bot' AND source = ? AND deleted_at IS NULL LIMIT 1", room.id, channel));
  const wsRow = await ctx.db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", ws);
  const body = plainText(text);
  const opts = o.options?.length ? optionsLine(o.options) : "";
  let content: string;
  let contentText: string;
  let route: { from: string; to: string; subject?: string; rfc?: string; inReplyTo?: string | null; references?: string[] };
  if (channel === "sms") {
    if (!contact.phone || !isE164(contact.phone)) throw new Error("no phone");
    if (contact.sms_opt_out) throw new Error("opted out");
    const max = settings.ai_channels.sms.max_segments;
    const prefix = first ? `${a.name} (${a.disclosure_label}): ` : "";
    const suffix = `${opts ? `\n${opts}` : ""}${first ? `${opts ? " " : "\n"}Reply HUMAN for a person.` : ""}`;
    contentText = fitSms(prefix, body.replace(/\n{2,}/g, "\n"), suffix, max);
    content = contentText;
    await verifyBalance(ctx, ws, "sms");
    route = { from: (await chooseSmsNumber(ctx, ws, room.id, contact.phone)).from, to: contact.phone };
  } else {
    if (!contact.email) throw new Error("no email");
    if (contact.unsubscribed) throw new Error("unsubscribed");
    const es = settings.ai_channels.email;
    const clipped = body.length > es.max_chars ? `${body.slice(0, es.max_chars).replace(/\s+\S*$/, "")}…` : body;
    const opening = first ? `This is ${a.name}, the ${a.disclosure_label} of ${wsRow?.name ?? "our team"} (not a person).\n\n` : "";
    const signoff = `\n\n-- \n${a.name} (${a.disclosure_label}), ${wsRow?.name ?? ""}${es.signature ? `\n${es.signature}` : ""}\nReply HUMAN to reach a person.`;
    contentText = `${opening}${clipped}${opts ? `\n\n${opts}` : ""}${signoff}`;
    content = textToHtml(contentText);
    await verifyBalance(ctx, ws, "email");
    const sender = await chooseEmailSender(ctx, ws, null);
    const firstContact = await ctx.db.get<{ content_text: string }>("SELECT content_text FROM messages WHERE room_id = ? AND sender_type = 'contact' AND deleted_at IS NULL ORDER BY seq LIMIT 1", room.id);
    const subject = deriveSubject(room.subject, firstContact?.content_text);
    const thread = await buildThread(ctx, room.id, sender.address);
    route = { from: sender.address, to: contact.email, subject, rfc: thread.messageId, inReplyTo: thread.inReplyTo, references: thread.references };
  }
  const r = await ctx.db.tx(async () => {
    await lockChannel(ctx, ws, room.id, channel, route.from, route.to);
    return insertMessage(ctx, {
      workspaceId: ws,
      roomId: room.id,
      senderType: "bot",
      senderId: a.id,
      senderName: a.name,
      kind: "text",
      source: channel,
      content,
      contentText,
      subject: route.subject ?? null,
      delivery: "pending",
      rfcMessageId: route.rfc ?? null,
      inReplyTo: route.inReplyTo ?? null,
      referencesHdr: route.references?.join(" ") ?? null,
      fromAddr: route.from,
      toAddr: route.to,
      meta: { ai: true, agent: agentMeta(a), ai_channel: channel, reply_kind: o.kind, first_reply: first, ...(o.options?.length ? { options: o.options, options_purpose: o.optionsPurpose ?? "solved", ...(o.optionsReason ? { options_reason: o.optionsReason } : {}) } : {}), ...o.meta },
    });
  });
  if (channel === "email" && route.subject && !room.subject) await ctx.db.run("UPDATE rooms SET subject = ? WHERE id = ?", route.subject, room.id);
  await emitInserted(ctx, r);
  return deliverMessage(ctx, r.message.id);
}

/** The pipeline posts an answer: on SMS and email it goes out through here (a hand-off when the channel cannot be used, so nobody waits for nothing). */
export async function postChannelAnswer(ctx: AppContext, room: RoomRow, a: AgentDto, channel: ReplyChannel, text: string, meta: Record<string, unknown>): Promise<MessageRow> {
  const card = meta.card as { purpose?: string; options?: ChannelOption[]; reason?: string } | undefined;
  const fresh = await getRoomRow(ctx, room.workspace_id, room.id);
  const { card: _drop, ...rest } = meta;
  return sendChannelReply(ctx, fresh, a, channel, text, { kind: "answer", options: card?.options, optionsPurpose: card?.purpose, optionsReason: card?.reason, meta: rest });
}

