import type { TeamChannel, TeamMessage, TeamPage, TeamThreadCache } from "./types";

export const emptyTeamThread: TeamThreadCache = { messages: [], hasMoreBefore: false, beforeCursor: null };

export const teamKeys = {
  channels: ["team", "channels"] as const,
  browse: ["team", "browse"] as const,
  channel: (id: string) => ["team", "channel", id] as const,
  messages: (id: string) => ["team", "messages", id] as const,
  thread: (rootId: string) => ["team", "thread", rootId] as const,
  pins: (id: string) => ["team", "pins", id] as const,
  search: (q: string, channel?: string) => ["team", "search", q, channel ?? ""] as const,
};

const order = (a: TeamMessage, b: TeamMessage): number => {
  const sa = a.local ? Number.POSITIVE_INFINITY : a.seq;
  const sb = b.local ? Number.POSITIVE_INFINITY : b.seq;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
};
export const sortTeam = (list: TeamMessage[]): TeamMessage[] => [...list].sort(order);

export const threadFromPage = (page: TeamPage): TeamThreadCache => ({
  messages: sortTeam(page.data),
  hasMoreBefore: page.pagination.has_more_before,
  beforeCursor: page.pagination.before_cursor,
});

/** Insert or merge by id and by client_msg_id (optimistic bubble -> confirmed message). Reactions and counts from the server always win. */
export function upsertTeam(t: TeamThreadCache, incoming: TeamMessage): TeamThreadCache {
  const i = t.messages.findIndex((m) => m.id === incoming.id || (!!incoming.client_msg_id && m.client_msg_id === incoming.client_msg_id));
  if (i === -1) return { ...t, messages: sortTeam([...t.messages, incoming]) };
  const next = [...t.messages];
  const merged = { ...incoming };
  delete merged.local;
  if (incoming.local) merged.local = incoming.local;
  next[i] = merged;
  return { ...t, messages: sortTeam(next) };
}

export const removeTeam = (t: TeamThreadCache, id: string): TeamThreadCache => (t.messages.some((m) => m.id === id) ? { ...t, messages: t.messages.filter((m) => m.id !== id) } : t);

export const prependTeam = (t: TeamThreadCache, page: TeamPage): TeamThreadCache => {
  const seen = new Set(t.messages.map((m) => m.id));
  return { messages: sortTeam([...page.data.filter((m) => !seen.has(m.id)), ...t.messages]), hasMoreBefore: page.pagination.has_more_before, beforeCursor: page.pagination.before_cursor };
};

/** Channel list order: the newest activity first. */
export const sortChannels = (list: TeamChannel[]): TeamChannel[] =>
  [...list].sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at) || a.id.localeCompare(b.id));

export function applyMessageToChannels(list: TeamChannel[], m: TeamMessage, opts: { self: string; open: boolean }): TeamChannel[] {
  if (m.thread_root_id && !list.some((c) => c.id === m.channel_id)) return list;
  return sortChannels(
    list.map((c) => {
      if (c.id !== m.channel_id) return c;
      const mine = m.sender.id === opts.self;
      return {
        ...c,
        last_message_at: m.created_at,
        last_message: { sender_name: m.sender.name, snippet: (m.content_text || (m.attachments.length ? "Attachment" : m.share ? "Shared a conversation" : "")).slice(0, 100), at: m.created_at },
        unread: mine || opts.open ? c.unread : c.unread + 1,
        mention_unread: mine || opts.open ? c.mention_unread : c.mention_unread + (m.mentions.includes(opts.self) ? 1 : 0),
      };
    }),
  );
}

export const totalUnread = (list: TeamChannel[] | undefined): { unread: number; mentions: number } => {
  let unread = 0;
  let mentions = 0;
  for (const c of list ?? []) {
    if (c.muted && c.mention_unread === 0) continue;
    unread += c.muted ? 0 : c.unread;
    mentions += c.mention_unread;
  }
  return { unread, mentions };
};

/** Replies that have been counted on their thread root already (the sender hears of its own reply twice: the REST answer and the broadcast). */
const counted = new Map<string, Set<string>>();

/** A reply arrived: the root message in the channel timeline shows one more reply. Idempotent per reply id. */
export function bumpReply(qc: import("@tanstack/react-query").QueryClient, m: TeamMessage): void {
  if (!m.thread_root_id || m.local) return;
  const set = counted.get(m.thread_root_id) ?? new Set<string>();
  if (set.has(m.id)) return;
  set.add(m.id);
  counted.set(m.thread_root_id, set);
  if (counted.size > 500) counted.delete(counted.keys().next().value as string);
  qc.setQueryData<TeamThreadCache>(teamKeys.messages(m.channel_id), (t) =>
    t ? { ...t, messages: t.messages.map((x) => (x.id === m.thread_root_id ? { ...x, reply_count: x.reply_count + 1, last_reply_at: m.created_at } : x)) } : t,
  );
}
