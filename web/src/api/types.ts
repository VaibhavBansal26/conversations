export type Role = "owner" | "manager" | "agent";
export type Availability = "active" | "away" | "inactive";
export type InboxVisibility = "assigned" | "assigned_inbox";
export type Channel = "dm" | "sms" | "email";
export type MessageKind = "text" | "image" | "voice" | "gif" | "attachment" | "ref" | "note" | "system";
export type SenderType = "agent" | "contact" | "bot" | "system";
/** `not_sent_test_mode`: stored while the SMS/email provider was the console one, nothing left the server */
export type Delivery = "pending" | "sent" | "delivered" | "failed" | "not_sent_test_mode";
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
  department_selector?: boolean;
  visitor_info?: VisitorInfo;
}

export type InfoMode = "off" | "optional" | "required" | "ask_when_needed";
export interface CustomField {
  key: string;
  label: string;
  type: "text" | "select";
  options: string[];
  mode: InfoMode;
}
export interface VisitorInfo {
  fields: { name: InfoMode; email: InfoMode; phone: InfoMode };
  custom_fields: CustomField[];
  moments: { handoff: boolean; no_agent: boolean; callback: boolean; after: boolean };
  consent: { enabled: boolean; text: string; privacy_url: string | null };
}
export interface DepartmentVisitorInfo {
  fields?: Partial<VisitorInfo["fields"]>;
  moments?: Partial<VisitorInfo["moments"]>;
}

export type AiTone = "friendly" | "professional" | "concise" | "empathetic";

export interface PhoneCallSettings {
  enabled: boolean;
  caller_id: string | null;
  daily_limit: number;
  allowed_countries: string[];
  max_duration_s: number;
  quiet_hours: { enabled: boolean; start: string; end: string };
}
export interface AiCallSettings {
  enabled: boolean;
  voice: boolean;
  video: boolean;
  max_duration_s: number;
  idle_timeout_s: number;
  max_concurrent: number;
  daily_limit: number;
  realtime_minutes_daily: number;
  realtime_max_concurrent: number;
}
export interface CallSettings {
  browser: { enabled: boolean; voice: boolean; video: boolean; screen_share: boolean };
  ai?: AiCallSettings;
  ai_engine?: "browser" | "realtime";
  phone?: PhoneCallSettings;
  ring_seconds: number;
  turn_provider: "none" | "static" | "twilio";
}

export interface WorkspaceSettings {
  default_region: string;
  edit_window_seconds: number;
  credits_enforced: boolean;
  ai_triage_enabled: boolean;
  ai_autoresponder_enabled: boolean;
  ai_redact_pii: boolean;
  ai_tone: AiTone;
  tickets: TicketSettings;
  routing?: { require_online: boolean };
  calls?: CallSettings;
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
  /** the address this deployment is reached at (PUBLIC_URL): what embed snippets and webhook URLs must contain */
  public_url?: string;
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

export type TicketStatus = "new" | "bot_handling" | "waiting_for_human" | "open" | "pending_customer" | "resolved" | "closed";
export type TicketResolution = "bot_resolved" | "human_resolved" | "abandoned" | "auto_closed" | "merged";
export type TicketPriority = 0 | 1 | 2 | 3;

/** What a conversation row and the thread header need to know about the live ticket. */
export interface TicketBrief {
  id: string;
  number: number;
  status: TicketStatus;
  /** `bot:<agent id>` or `human:<member id>` */
  handler: string | null;
  department_id: string | null;
  priority: TicketPriority;
  subject: string;
}

export interface Ticket extends TicketBrief {
  room_id: string;
  contact_id: string;
  subject_set_by: "auto" | "agent";
  resolution: TicketResolution | null;
  channel: Channel;
  opened_at: string;
  first_response_at: string | null;
  handoff_at: string | null;
  first_human_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  csat: number | null;
  csat_comment: string | null;
  tags: string[];
  summary: string;
  handoff_reason: string | null;
  merged_into_id: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  contact?: { id: string; name: string; email: string | null } | null;
}

export interface TicketEvent {
  id: string;
  type: string;
  actor_type: "contact" | "member" | "bot" | "system";
  actor_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface TicketPage {
  data: Ticket[];
  pagination: { limit: number; has_more: boolean; next_cursor: string | null };
}

export type TicketCounts = Record<TicketStatus | "total_live", number>;

export interface TicketSettings {
  reopen_hours: number;
  bot_idle_minutes: number;
  pending_idle_hours: number;
  close_resolved_hours: number;
  csat_prompt: boolean;
  closing_message: string;
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
  /** the live ticket of the conversation (null while nothing is open) */
  ticket?: TicketBrief | null;
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
  description?: string;
  live_routing_visibility: boolean;
  default_email_inbound: boolean;
  default_sms_inbound: boolean;
  last_assigned_member_id: string | null;
  member_ids: string[];
  created_at: string;
}

export type RoutingMode = "round_robin" | "least_busy" | "skills_based" | "manual_pick";

export interface DepartmentHours extends OfficeHours {
  /** local dates (YYYY-MM-DD, in the timezone) the department is closed */
  holidays: string[];
}

export interface DepartmentMember {
  member_id: string;
  name: string;
  skills: string[];
  languages: string[];
  capacity: number | null;
}

export interface DepartmentStatus {
  id: string;
  name: string;
  open: boolean;
  next_opening: string | null;
  available_agents: number;
  queue_length: number;
  estimated_wait_s: number | null;
}

/** An inbox with its routing configuration (docs/DEPARTMENTS.md). */
export interface Department extends Inbox {
  routing_mode: RoutingMode | null;
  effective_routing_mode: RoutingMode;
  capacity: number;
  hours: DepartmentHours;
  sla_first_response_s: number | null;
  sla_resolution_s: number | null;
  overflow_inbox_id: string | null;
  auto_reply_closed: string;
  auto_reply_queued: string;
  visitor_info: DepartmentVisitorInfo;
  members: DepartmentMember[];
  status: DepartmentStatus;
}

export type RuleField = "page_url" | "locale" | "channel" | "tag" | "email_domain" | "attr";
export type RuleOp = "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "ends_with" | "exists";
export interface RuleCondition {
  field: RuleField;
  key?: string;
  op: RuleOp;
  value: string;
}
export interface RoutingRule {
  id: string;
  position: number;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  department_id: string;
  created_at: string;
  updated_at: string;
}
export interface RuleTestResult {
  department_id: string | null;
  rule: RoutingRule | null;
  evaluated: { rule_id: string; name: string; matched: boolean }[];
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
  /** groups entries; an AI agent can be limited to some collections */
  collection: string;
  /** the page the answer comes from, shown to the visitor as a source */
  url: string | null;
  updated_at: string;
}

export type AgentAutonomy = "suggest_only" | "auto_answer" | "auto_resolve";
export type AgentTone = "friendly" | "professional" | "concise" | "empathetic";
export type AgentAction = "collect_info" | "route" | "resolve" | "quick_replies" | "request_human" | "schedule_callback" | "offer_call" | "ai_call";
export interface HandoffTriggers {
  human_request: boolean;
  low_confidence: boolean;
  repeated_rephrase: boolean;
  negative_sentiment: boolean;
  high_urgency: boolean;
  sensitive_topic: boolean;
  vip_contact: boolean;
  tool_failure: boolean;
  sensitive_topics: string[];
}
export interface AiAgent {
  id: string;
  name: string;
  avatar_url: string | null;
  avatar_alt: string;
  /** the picture is an upload held by the app (rather than a bundled picture or a link) */
  avatar_uploaded: boolean;
  persona: string;
  tone: AgentTone;
  languages: string[];
  greeting: string;
  department_ids: string[];
  hours: OfficeHours;
  kb_collections: string[];
  autonomy: AgentAutonomy;
  confidence_threshold: number;
  coverage_threshold: number;
  max_turns: number;
  max_attempts: number;
  allowed_actions: AgentAction[];
  handoff_triggers: HandoffTriggers;
  waiting_behavior: "silent" | "gather_info";
  disclosure_label: string;
  channels: "widget"[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
export type AgentTurnOutcome = "answered" | "suggested" | "clarified" | "refused" | "handoff" | "resolved" | "skipped";
export interface AgentSource {
  id: string;
  question: string;
  url: string | null;
  score: number;
  coverage: number;
}
export interface AgentTurn {
  id: string;
  created_at: string;
  ticket_id: string;
  ticket_number: number | null;
  room_id: string;
  agent_id: string;
  outcome: AgentTurnOutcome;
  intent: string | null;
  department_id: string | null;
  confidence: number | null;
  reason: string | null;
  visitor_text: string;
  answer: string | null;
  sources: AgentSource[];
  actions: { tool: string; ok: boolean }[];
  provider: string;
  tokens: { in: number; out: number };
  latency_ms: number;
  votes: { up: number; down: number };
  message_id: string | null;
}
export interface AgentTurnPage {
  data: AgentTurn[];
  pagination: { limit: number; has_more: boolean; next_cursor: string | null };
}
export interface UnansweredCluster {
  count: number;
  sample: string;
  examples: string[];
  last_seen: string;
  suggested_question: string;
}
export interface SandboxResult {
  kind: string;
  reply: string;
  handoff: { reason: string; departmentId: string | null; skills: string[] } | null;
  confidence: number | null;
  intent: string | null;
  sentiment: string | null;
  urgency: number | null;
  department: { id: string | null; confidence: number };
  sources: AgentSource[];
  actions: { tool: string }[];
  subject: string | null;
  quick_replies: boolean;
  provider: string;
  degraded: boolean;
  tokens: { in: number; out: number };
  latency_ms: number;
  trace: string[];
  routing: { outcome: string; department: { id: string; name: string } | null; mode: string | null; assignee: { id: string; name: string } | null; path: string[]; closed: string | null; confirm_between: unknown } | null;
}

export interface EmbedToken {
  id: string;
  domain: string;
  token: string;
  status: string;
  last_used_at: string | null;
  /** newest widget config request from a real site (the in-app preview does not count) */
  last_seen_origin?: string | null;
  last_seen_at?: string | null;
  /** the hosted full-page chat (/chat) may use this token */
  hosted_chat_enabled?: boolean;
  created_at: string;
}

export interface IdentityStatus {
  configured: boolean;
  enforce: boolean;
  rotated_at: string | null;
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
  /** team chat notifications open a channel instead of a conversation */
  channel_id?: string | null;
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

export interface ChannelStatus {
  channel: "sms" | "email";
  mode: "live" | "test" | "attention";
  connected: boolean;
  provider: string;
  source: "platform" | "workspace" | "none";
  summary: string;
  details: Record<string, unknown>;
  last_error: { message: string; code: string | null; at: string } | null;
  last_ok_at: string | null;
}
export interface ChannelStatuses {
  sms: ChannelStatus;
  email: ChannelStatus;
  system_email: { mode: "live" | "test"; provider: string };
}

export interface ChannelConnection {
  id: string;
  channel: "sms" | "email";
  provider: "twilio" | "sendgrid";
  status: "pending" | "verified" | "error";
  masked: Record<string, string>;
  account: { friendly_name?: string; type?: string; status?: string; scopes_ok?: boolean; domains?: { domain: string; valid: boolean }[]; verified_senders?: number } | null;
  inbound_domain: string | null;
  event_public_key_set: boolean;
  verified_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  webhooks: Record<string, string>;
  created_at: string;
  updated_at: string;
}
export interface ChannelConnections {
  sms: ChannelConnection | null;
  email: ChannelConnection | null;
}
export interface VerifyResult {
  connection: ChannelConnection;
  warnings: string[];
  senders?: { email: string; name: string; verified: boolean }[] | null;
}
export interface ChannelEvent {
  id: string;
  kind: string;
  outcome: "processed" | "duplicate" | "ignored" | "rejected";
  detail: string | null;
  at: string;
}
export interface TwilioNumberRow {
  e164: string;
  label: string;
  sms_capable: boolean;
  imported: boolean;
}
