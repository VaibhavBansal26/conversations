import type { Message, MessagePage, ReceiptPayload } from "../api/types";

/** A room's loaded messages, oldest first, plus the cursor for loading older ones. */
export interface Thread {
  messages: Message[];
  hasMoreBefore: boolean;
  beforeCursor: string | null;
}

export const emptyThread: Thread = { messages: [], hasMoreBefore: false, beforeCursor: null };

export const threadFromPage = (page: MessagePage): Thread => ({
  messages: sortMessages(page.data),
  hasMoreBefore: page.pagination.has_more_before,
  beforeCursor: page.pagination.before_cursor,
});

const DELIVERY_RANK = { pending: 0, sent: 1, delivered: 2, failed: 1, not_sent_test_mode: 1 } as const;

/** Unconfirmed local messages sort after everything the server has stored. */
function order(a: Message, b: Message): number {
  const sa = a.local ? Number.POSITIVE_INFINITY : a.seq;
  const sb = b.local ? Number.POSITIVE_INFINITY : b.seq;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

export const sortMessages = (list: Message[]): Message[] => [...list].sort(order);

/**
 * Merge an incoming server message into an existing one. Realtime events and REST/ack responses for the same
 * message can arrive in any order, so receipt state never regresses.
 */
function mergeMessage(existing: Message, incoming: Message): Message {
  const merged: Message = { ...incoming };
  const stale = !existing.local && DELIVERY_RANK[incoming.delivery] < DELIVERY_RANK[existing.delivery] && existing.delivery !== "failed";
  if (stale) merged.delivery = existing.delivery;
  merged.read = incoming.read || existing.read;
  if (merged.read && merged.delivery === "sent") merged.delivery = "delivered";
  delete merged.local;
  return merged;
}

/** Insert or merge a message, deduplicating on `id` and on `client_msg_id` (optimistic bubble -> confirmed bubble). */
export function upsertMessage(thread: Thread, incoming: Message): Thread {
  const idx = thread.messages.findIndex((m) => m.id === incoming.id || (!!incoming.client_msg_id && m.client_msg_id === incoming.client_msg_id));
  if (idx === -1) return { ...thread, messages: sortMessages([...thread.messages, incoming]) };
  const existing = thread.messages[idx]!;
  const next = incoming.local ? incoming : mergeMessage(existing, incoming);
  const messages = [...thread.messages];
  messages[idx] = next;
  return { ...thread, messages: sortMessages(messages) };
}

export const removeMessage = (thread: Thread, messageId: string): Thread =>
  thread.messages.some((m) => m.id === messageId) ? { ...thread, messages: thread.messages.filter((m) => m.id !== messageId) } : thread;

/** A contact read the conversation up to a sequence number: everything the team sent before it becomes "read". */
export function applyReceipt(thread: Thread, receipt: Pick<ReceiptPayload, "reader" | "up_to_seq" | "at">): Thread {
  if (receipt.reader.type !== "contact") return thread;
  let changed = false;
  const messages = thread.messages.map((m) => {
    const outbound = m.sender.type !== "contact" && m.kind !== "system" && m.kind !== "note" && !m.local;
    if (!outbound || m.seq > receipt.up_to_seq || (m.read && m.delivery !== "sent")) return m;
    changed = true;
    return { ...m, read: true, opened_at: m.opened_at ?? receipt.at, delivery: m.delivery === "sent" ? ("delivered" as const) : m.delivery };
  });
  return changed ? { ...thread, messages } : thread;
}

/** Add an older page in front; already-known messages are skipped. */
export function prependOlder(thread: Thread, page: MessagePage): Thread {
  const known = new Set(thread.messages.map((m) => m.id));
  const older = page.data.filter((m) => !known.has(m.id));
  return {
    messages: sortMessages([...older, ...thread.messages]),
    hasMoreBefore: page.pagination.has_more_before,
    beforeCursor: page.pagination.before_cursor,
  };
}

/** Oldest server-confirmed message, used as the `before` cursor. */
export const oldestConfirmed = (thread: Thread): Message | undefined => thread.messages.find((m) => !m.local);
export const newestConfirmed = (thread: Thread): Message | undefined => [...thread.messages].reverse().find((m) => !m.local);
