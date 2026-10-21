import type { TicketBrief, TicketPriority, TicketStatus } from "../api/types";

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  new: "New",
  bot_handling: "AI agent",
  waiting_for_human: "Waiting for a person",
  open: "Open",
  pending_customer: "Waiting for customer",
  resolved: "Resolved",
  closed: "Closed",
};

export type ChipTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export const TICKET_STATUS_TONE: Record<TicketStatus, ChipTone> = {
  new: "info",
  bot_handling: "primary",
  waiting_for_human: "warning",
  open: "success",
  pending_customer: "neutral",
  resolved: "neutral",
  closed: "neutral",
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = { 0: "Low", 1: "Normal", 2: "High", 3: "Urgent" };

/** `bot:<id>` / `human:<id>` -> a readable name, given the names the caller knows. */
export function handlerLabel(handler: string | null, names: { members?: Map<string, string>; agents?: Map<string, string> } = {}): string {
  if (!handler) return "Nobody yet";
  const [kind, ...rest] = handler.split(":");
  const id = rest.join(":");
  if (kind === "bot") return names.agents?.get(id) ?? "AI agent";
  if (kind === "human") return names.members?.get(id) ?? "A teammate";
  return "Nobody yet";
}

export const ticketIsLive = (t: Pick<TicketBrief, "status">): boolean => t.status !== "closed";
export const ticketLabel = (t: Pick<TicketBrief, "number">): string => `#${t.number}`;
