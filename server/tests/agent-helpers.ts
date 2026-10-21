import type { AiProvider, AiRequest } from "../src/ai/provider.js";
import { AiUnavailableError } from "../src/ai/provider.js";
import { createAgent, AgentBodySchema, type AgentRow } from "../src/agents/config.js";
import { createKb } from "../src/services/settings.js";
import { updateMember } from "../src/services/members.js";
import { createInbox } from "../src/services/inboxes.js";
import { updateDepartment } from "../src/services/departments.js";
import { addMemberRaw, setSettings } from "./helpers.js";
import { widgetWorld } from "./widget-helpers.js";
import type { z } from "zod";

/** A model that answers from a script and remembers every request it was sent (so tests can assert what reached it). */
export class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly calls: AiRequest[] = [];
  constructor(private readonly script: (req: AiRequest, n: number) => unknown | Promise<unknown>) {}
  async complete(req: AiRequest): Promise<string> {
    this.calls.push(req);
    const out = await this.script(req, this.calls.length);
    if (out instanceof Error) throw out;
    return typeof out === "string" ? out : JSON.stringify(out);
  }
}
export const unavailable = () => new ScriptedProvider(() => new AiUnavailableError());
export const answerWith = (over: Record<string, unknown> = {}) => (req: AiRequest) => {
  const kb = (req.input.kb as { id: string; answer: string }[])[0];
  return { answer: kb?.answer ?? "", confidence: 0.9, intent: "support", handoff: false, cited_ids: kb ? [kb.id] : [], actions: [], ...over };
};

export const KB = [
  { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password. We email you a link.", collection: "account", url: "https://help.example.test/reset-password" },
  { question: "What are your opening hours?", answer: "Our support team is available Monday to Friday from 9 to 17 CET.", collection: "general", url: null },
  { question: "How can I download my invoice?", answer: "Open Billing, select the invoice and press Download PDF.", collection: "billing", url: "https://help.example.test/invoices" },
];

type AgentInput = z.input<typeof AgentBodySchema>;

/** A workspace with a widget token, a knowledge base, two departments with a person each, and one enabled AI agent. */
export async function agentWorld(o: { agent?: Partial<AgentInput>; kb?: typeof KB; env?: Record<string, string>; redact?: boolean } = {}) {
  const w = await widgetWorld(o.env);
  await setSettings(w.ctx, w.wsId, { routing: { require_online: false }, ...(o.redact ? { ai_redact_pii: true } : {}) });
  for (const k of o.kb ?? KB) await createKb(w.ctx, w.owner, k);
  const ann = await addMemberRaw(w.ctx, w.wsId, { name: "Ann Support", inbox_visibility: "assigned_inbox" });
  const bo = await addMemberRaw(w.ctx, w.wsId, { name: "Bo Billing", inbox_visibility: "assigned_inbox" });
  const support = await createInbox(w.ctx, w.owner, { name: "Technical support", member_ids: [ann.memberId], live_routing_visibility: true });
  const billing = await createInbox(w.ctx, w.owner, { name: "Billing", member_ids: [bo.memberId], live_routing_visibility: true });
  await updateDepartment(w.ctx, w.owner, support.id, { routing_mode: "round_robin", description: "Errors, bugs, login problems and how-to questions" });
  await updateDepartment(w.ctx, w.owner, billing.id, { routing_mode: "round_robin", description: "Invoices, payments and subscriptions" });
  await w.http.patch("/api/workspace", { settings: { widget: { default_inbox_id: support.id } } }, w.token);
  const agent: AgentRow = await createAgent(w.ctx, w.owner, AgentBodySchema.parse({ name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", ...o.agent }));
  void updateMember;
  return { ...w, ann, bo, support, billing, agent };
}
export type AgentWorld = Awaited<ReturnType<typeof agentWorld>>;

/** The ticket of a conversation (the live one, else the newest). */
export const ticketOf = async (w: AgentWorld, roomId: string) =>
  (await w.ctx.db.get<import("../src/services/tickets.js").TicketRow>("SELECT * FROM tickets WHERE room_id = ? ORDER BY opened_at DESC, id DESC LIMIT 1", roomId))!;

/** Everything the bot said in a room as a visitor sees it (text messages only, oldest first). */
export const botSays = async (w: AgentWorld, roomId: string) =>
  (await w.ctx.db.all<{ content_text: string; meta: string; kind: string }>("SELECT content_text, meta, kind FROM messages WHERE room_id = ? AND sender_type = 'bot' AND kind = 'text' ORDER BY seq", roomId)).map((m) => ({ text: m.content_text, meta: JSON.parse(m.meta) as Record<string, any> }));

/** Visitor writes and the background turn finishes. */
export async function say(w: AgentWorld, v: { send: (t: string) => Promise<{ status: number; body: any }> }, text: string) {
  const r = await v.send(text);
  await w.ctx.background.settle();
  return r;
}
