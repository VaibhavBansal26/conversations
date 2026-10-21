export interface TeamChannel {
  id: string;
  kind: "channel" | "dm" | "group";
  visibility: "public" | "private";
  name: string | null;
  /** what to show: the channel name, or the other people of a direct / group message */
  title: string;
  topic: string;
  is_general: boolean;
  archived: boolean;
  member_ids?: string[];
  member_count: number;
  joined: boolean;
  role: "owner" | "member" | null;
  muted: boolean;
  unread: number;
  mention_unread: number;
  last_message: { sender_name: string; snippet: string; at: string } | null;
  last_message_at: string | null;
  created_at: string;
  members?: { id: string; name: string; role: "owner" | "member"; last_read_seq: number }[];
}

export interface TeamShare {
  room_id: string;
  available: boolean;
  title?: string;
  status?: string;
}

export interface TeamAttachment {
  id: string;
  file_name: string;
  content_type: string;
  size: number;
  url: string;
}

export interface TeamReaction {
  emoji: string;
  count: number;
  member_ids: string[];
}

export interface TeamMessage {
  id: string;
  channel_id: string;
  seq: number;
  thread_root_id: string | null;
  client_msg_id: string | null;
  sender: { id: string; name: string };
  kind: "text" | "share" | "system";
  content: string;
  content_text: string;
  attachments: TeamAttachment[];
  mentions: string[];
  mention_all: boolean;
  reactions: TeamReaction[];
  reply_count: number;
  last_reply_at: string | null;
  pinned: boolean;
  pinned_at: string | null;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
  share: TeamShare | null;
  /** a card of a group call: who is in it now and whether it can still be joined */
  group_call?: { id: string; kind: "voice" | "video"; state: string; joined: number; max: number } | null;
  /** client only: not confirmed by the server yet */
  local?: { status: "sending" | "failed"; error?: string; attachmentIds?: string[] };
}

export interface TeamPage {
  data: TeamMessage[];
  pagination: { has_more_before: boolean; has_more_after: boolean; before_cursor: string | null; after_cursor: string | null };
}

export interface TeamThreadCache {
  messages: TeamMessage[];
  hasMoreBefore: boolean;
  beforeCursor: string | null;
}

export interface TeamSearchHit extends TeamMessage {
  channel: { id: string; kind: string; name: string | null; title: string };
}
