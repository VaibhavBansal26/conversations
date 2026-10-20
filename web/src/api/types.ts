export type Role = "owner" | "manager" | "agent";
export type Availability = "active" | "away" | "inactive";
export type InboxVisibility = "assigned" | "assigned_inbox";
export type Channel = "dm" | "sms" | "email";
export type MessageKind = "text" | "image" | "voice" | "gif" | "attachment" | "ref" | "note" | "system";
export type SenderType = "agent" | "contact" | "bot" | "system";
export type Delivery = "pending" | "sent" | "delivered" | "failed";
export type RoomStatus = "open" | "closed";
export type RoomStatusTab = "open" | "closed" | "snoozed";
export type RoomFilter = "assigned_to_me" | "unassigned" | "mentions" | "priority" | "favorites";
export type RoomSort = "newest" | "oldest" | "waiting_longest" | "priority_first";
export type RephraseMode = "improve" | "fix_grammar" | "shorten" | "friendly" | "professional" | "empathetic";

export interface NotificationPrefs {
  assigned_to_you: boolean;
  assigned_to_your_team: boolean;
  unassigned: boolean;
  delayed_msgs: boolean;
  email: boolean;
  mentions: boolean;
}

export interface Member {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: Role;
  live_seat: boolean;
  availability: Availability;
  dnd_until: string | null;
  inbox_visibility: InboxVisibility;
  notification_prefs: NotificationPrefs;
  online: boolean;
  created_at: string;
}

export interface OfficeHours {
  enabled: boolean;
  timezone: string;
  days: { day: number; start: string; end: string }[];
}

export interface WidgetSettings {
  title: string;
  intro: string;
  primary_color: string;
  text_color: string;
  logo_url: string | null;
  launcher_position: "left" | "right";
  launcher_spacing: number;
  launcher_style: "bubble" | "pill" | "icon";
  launcher_label: string;
  /** panel corner radius in px (0-24) */
  radius: number;
  sound: boolean;
  welcome_message: string;
  away_message: string;
  required_info: ("name" | "email" | "phone")[];
  chat_type: "live_chat" | "sms";
  office_hours: OfficeHours;
  default_inbox_id: string | null;
}

export type AiTone = "friendly" | "professional" | "concise" | "empathetic";

export interface WorkspaceSettings {
  default_region: string;
  edit_window_seconds: number;
  credits_enforced: boolean;
  ai_triage_enabled: boolean;
  ai_autoresponder_enabled: boolean;
  ai_redact_pii: boolean;
  ai_tone: AiTone;
  widget: WidgetSettings;
}

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
  settings: WorkspaceSettings;
  credit_balance: number;
  plan?: "free" | "pro" | "business";
  /** ok | grace (a payment failed, still working) | locked (overdue: external sends refused) */
  billing_access?: "ok" | "grace" | "locked";
  billing_grace_until?: string | null;
  currency?: string;
}

export interface Session {
  user: { id: string; name: string; email: string };
  member: Member;
  workspace: Workspace;
}

export interface AuthResponse extends Session {
  token: string;
  refresh_token: string;
  expires_in: number;
}

export interface MfaRequired {
  mfa_required: true;
  mfa_token: string;
}

export interface ContactBrief {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  sms_opt_out: boolean;
}

export interface Contact extends ContactBrief {
  attrs: Record<string, unknown>;
  tags: string[];
  unsubscribed: boolean;
  source: string;
  followers: string[];
  created_at: string;
  updated_at: string;
}

export interface ContactNote {
  id: string;
  body: string;
  author_name?: string;
  member_id?: string;
  created_at: string;
}

export interface LastMessage {
  id: string;
  kind: MessageKind;
  source: Channel;
  sender_type: SenderType;
  sender_name: string;
  snippet: string;
  created_at: string;
}

export interface Room {
  id: string;
  contact: ContactBrief | null;
  contact_id: string;
  inbox_id: string | null;
  assignee_ids: string[];
  status: RoomStatus;
  priority: 0 | 1;
  snooze_until: string | null;
  snoozed_by: string | null;
  subject: string | null;
  room_type: string;
  verified_session: boolean;
  last_message: LastMessage | null;
  last_message_at: string | null;
  last_contact_message_at: string | null;
  waiting_since: string | null;
  unread_count: number;
  favorite: boolean;
  bot_paused: boolean;
  triage: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type RoomPatch = Pick<Room, "id"> & Partial<Omit<Room, "id">>;

export interface Pagination {
  page: number;
  limit: number;
  has_more: boolean;
  total?: number | null;
  /** keyset cursor for the next page (null/absent when there is none or the sort is offset-paged) */
  next_cursor?: string | null;
}

export interface RoomPage {
  data: Room[];
  pagination: Pagination;
}

export interface Attachment {
  id: string;
  file_name: string;
  content_type: string;
  size: number;
  url: string;
}

export interface MessageRef {
  id: string;
  sender_name: string;
  sender_type: SenderType;
  kind: MessageKind;
  snippet: string;
  deleted: boolean;
}

export interface SendPayload {
  kind: MessageKind;
  source: Channel;
  content: string;
  format?: "text" | "html";
  subject?: string;
  from?: string;
  ref_message_id?: string;
  attachment_ids?: string[];
  client_msg_id: string;
}

export type LocalStatus = "sending" | "failed";

export interface LocalState {
  status: LocalStatus;
  error?: string;
  payload: SendPayload;
}

export interface Message {
  id: string;
  room_id: string;
  seq: number;
  client_msg_id: string | null;
  sender: { type: SenderType; id: string | null; name: string };
  kind: MessageKind;
  source: Channel;
  content: string;
  content_text: string;
  subject: string | null;
  ref: MessageRef | null;
  attachments: Attachment[];
  meta: Record<string, unknown>;
  delivery: Delivery;
  failure_reason: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  read: boolean;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
  /** Client-only: present while the message has not been confirmed by the server. */
  local?: LocalState;
}

export interface MessagePage {
  data: Message[];
  pagination: {
    has_more_before: boolean;
    has_more_after: boolean;
    before_cursor: string | null;
    after_cursor: string | null;
  };
}

export interface Counts {
  total: { open: number; closed: number; snoozed: number; priority: number; unassigned: number; assigned: number; mentions: number };
  inboxes: { inbox_id: string; open: number; priority: number; unassigned: number; assigned: number }[];
  unread_rooms: number;
}

export interface Inbox {
  id: string;
  name: string;
  icon: string;
  algorithm: "manual" | "round_robin";
  live_routing_visibility: boolean;
  default_email_inbound: boolean;
  default_sms_inbound: boolean;
  last_assigned_member_id: string | null;
  member_ids: string[];
  created_at: string;
}

export interface Template {
  id: string;
  name: string;
  channel: "any" | Channel;
  subject: string | null;
  body: string;
  shortcut: string | null;
}

export interface KbEntry {
  id: string;
  question: string;
  answer: string;
  updated_at: string;
}

export interface EmbedToken {
  id: string;
  domain: string;
  token: string;
  status: string;
  last_used_at: string | null;
  created_at: string;
}

export interface SmsNumber {
  id: string;
  e164: string;
  label: string;
  is_default: boolean;
}

export interface EmailSender {
  id: string;
  address: string;
  display_name: string;
  verified: boolean;
  is_default: boolean;
}

export interface InboundAddress {
  address: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  room_id: string | null;
  message_id: string | null;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface NotificationList {
  data: NotificationItem[];
  unread_count: number;
}

export interface AiSummary {
  summary: string;
  key_facts: string[];
  open_questions: string[];
  next_action: string;
  truncated: boolean;
}

export interface AiSuggestions {
  suggestions: { text: string; tone?: string }[];
}

export interface TypingEvent {
  room_id: string;
  typing: boolean;
  who: { type: "agent" | "contact"; id?: string; name?: string };
}

export interface MessageEventPayload {
  message: Message;
  room: Omit<RoomPatch, "assignee_ids"> & { id: string };
}

export interface ReceiptPayload {
  room_id: string;
  reader: { type: "agent" | "contact"; id?: string };
  up_to_seq: number;
  up_to_message_id: string;
  at: string;
}

export interface LedgerEntry {
  id: string;
  kind: string;
  delta: number;
  balance_after: number;
  created_at: string;
}
