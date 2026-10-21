import { z } from "zod";
import { WorkspaceSettingsPatchSchema } from "./domain/settings.js";

export const id = z.string().min(1).max(64);
export const clientMsgId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "client_msg_id may contain letters, digits, _ and -");

export const RegisterBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(100),
  workspace_name: z.string().trim().min(1).max(100),
});
export const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200), workspace_id: z.string().optional() });

export const WorkspacePatch = z.object({ name: z.string().trim().min(1).max(100).optional(), settings: WorkspaceSettingsPatchSchema.optional() });

const prefs = z
  .object({
    assigned_to_you: z.boolean(),
    assigned_to_your_team: z.boolean(),
    unassigned: z.boolean(),
    delayed_msgs: z.boolean(),
    email: z.boolean(),
    mentions: z.boolean(),
    team_messages: z.boolean(),
  })
  .partial();

export const MemberCreate = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200).optional(),
  role: z.enum(["manager", "agent"]).default("agent"),
  live_seat: z.boolean().optional(),
  inbox_visibility: z.enum(["assigned", "assigned_inbox"]).optional(),
});
export const MemberPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(["owner", "manager", "agent"]).optional(),
  live_seat: z.boolean().optional(),
  inbox_visibility: z.enum(["assigned", "assigned_inbox"]).optional(),
  availability: z.enum(["active", "away", "inactive"]).optional(),
  dnd_until: z.string().datetime().nullable().optional(),
  notification_prefs: prefs.optional(),
});

export const ContactBody = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.string().email().max(254).nullable().optional().or(z.literal("")),
  phone: z.string().max(40).nullable().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
});
export const ContactPatch = ContactBody.extend({ sms_opt_out: z.boolean().optional(), unsubscribed: z.boolean().optional() });

export const Pagination = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });

export const InboxBody = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(40).optional(),
  algorithm: z.enum(["manual", "round_robin"]).optional(),
  live_routing_visibility: z.boolean().optional(),
  default_email_inbound: z.boolean().optional(),
  default_sms_inbound: z.boolean().optional(),
  member_ids: z.array(id).max(200).optional(),
});
export const InboxPatch = InboxBody.partial();

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
export const RoomQuery = Pagination.extend({
  status: z.enum(["open", "closed", "snoozed", "all"]).default("open"),
  filter: z.enum(["all", "assigned_to_me", "unassigned", "mentions", "priority", "favorites"]).optional(),
  inbox_id: id.optional(),
  contact_id: id.optional(),
  /** filters on the live ticket of the room: a status (or comma list), a handler (`bot`, `human`, `unassigned`, `me`, `bot:<id>`, `human:<id>`), a department */
  ticket_status: z.string().max(120).optional(),
  ticket_handler: z.string().max(80).optional(),
  department_id: id.optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(["newest", "oldest", "waiting_longest", "priority_first"]).default("newest"),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unassigned: bool.optional(),
  mentions: bool.optional(),
  priority: bool.optional(),
  assigned_to_me: bool.optional(),
});

export const RoomCreate = z.object({
  contact_id: id.optional(),
  contact: z.object({ name: z.string().max(200).optional(), email: z.string().email().optional(), phone: z.string().max(40).optional() }).optional(),
  inbox_id: id.nullable().optional(),
  subject: z.string().max(300).nullable().optional(),
  message: z.lazy(() => SendMessageBody).optional(),
});
export const RoomPatch = z.object({
  status: z.enum(["open", "closed"]).optional(),
  priority: z.union([z.literal(0), z.literal(1)]).optional(),
  subject: z.string().max(300).nullable().optional(),
  snooze_until: z.string().datetime({ offset: true }).nullable().optional(),
});
export const AssignBody = z.object({ member_ids: z.array(id).max(20).optional(), inbox_id: id.nullable().optional(), auto: z.boolean().optional() });
export const SnoozeBody = z.object({ until: z.string().min(1).max(40) });
export const BulkBody = z.object({
  room_ids: z.array(id).min(1).max(100),
  action: z.enum(["close", "reopen", "assign", "priority", "tag"]),
  member_ids: z.array(id).max(20).optional(),
  priority: z.union([z.literal(0), z.literal(1)]).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});
export const ReadBody = z.object({ message_id: id });

export const SendMessageBody = z.object({
  kind: z.enum(["text", "image", "voice", "gif", "attachment", "ref", "note"]).default("text"),
  source: z.enum(["dm", "sms", "email"]).default("dm"),
  content: z.string().max(20000).optional(),
  format: z.enum(["text", "html"]).optional(),
  subject: z.string().max(300).optional(),
  from: z.string().email().optional(),
  ref_message_id: id.optional(),
  attachment_ids: z.array(id).max(10).optional(),
  client_msg_id: clientMsgId.optional(),
});
export const EditMessageBody = z.object({ content: z.string().min(1).max(20000), format: z.enum(["text", "html"]).optional() });
export const MessageListQuery = z.object({ before: id.optional(), after: id.optional(), limit: z.coerce.number().int().min(1).max(50).default(30) });
export const SearchQuery = z.object({ q: z.string().trim().min(1).max(200), room_id: id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });

export const SmsNumberBody = z.object({ e164: z.string().min(5).max(20), label: z.string().max(60).optional(), is_default: z.boolean().optional() });
export const SenderBody = z.object({
  address: z.string().email().max(254),
  display_name: z.string().max(100).optional(),
  verified: z.boolean().optional(),
  is_default: z.boolean().optional(),
});
export const InboundAddressBody = z.object({ address: z.string().email().max(254) });
/** Credentials pasted by a workspace admin. Validated loosely on purpose: the provider is the judge of whether they work. */
export const TwilioConnectBody = z.object({
  account_sid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, "Account SID looks like AC followed by 32 characters"),
  auth_token: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, "Auth Token is 32 letters and digits"),
  api_key_sid: z.string().trim().regex(/^SK[0-9a-fA-F]{32}$/, "API key SID looks like SK followed by 32 characters").optional(),
  api_key_secret: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, "API key secret is letters and digits").optional(),
});
export const SendGridConnectBody = z.object({
  api_key: z.string().trim().regex(/^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/, "SendGrid API keys look like SG.xxxx.yyyy"),
  inbound_domain: z.string().max(253).nullable().optional(),
  event_public_key: z.string().max(400).nullable().optional(),
});
export const EmailSettingsBody = z.object({ inbound_domain: z.string().max(253).nullable().optional(), event_public_key: z.string().max(400).nullable().optional() });
export const ImportNumbersBody = z.object({ e164s: z.array(z.string().max(20)).min(1).max(100) });
export const TestSendBody = z.object({ to: z.string().trim().min(3).max(254) });
export const TokenBody = z.object({ domain: z.string().min(1).max(255), hosted_chat_enabled: z.boolean().optional() });
export const TokenPatch = z.object({ hosted_chat_enabled: z.boolean() });
export const IdentityPatch = z.object({ enforce: z.boolean() });

export const TemplateBody = z.object({
  name: z.string().trim().min(1).max(100),
  channel: z.enum(["any", "email", "sms", "dm"]).default("any"),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(10000),
  shortcut: z
    .string()
    .trim()
    .max(40)
    .regex(/^[a-z0-9_-]*$/i)
    .nullable()
    .optional(),
});
export const TemplateRender = z.object({ contact_id: id.optional(), room_id: id.optional(), format: z.enum(["text", "html"]).default("text") });
export const KbBody = z.object({
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(1).max(4000),
  /** group entries (an AI agent can be limited to some collections) */
  collection: z.string().trim().max(60).default(""),
  /** the help-centre page this answer comes from; shown to visitors as a link under the AI agent's answer */
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => u === "" || /^https?:\/\/[^\s]+$/i.test(u), "Use an http or https address")
    .nullable()
    .default(null),
});
export const RephraseBody = z.object({
  text: z.string().min(1).max(8000),
  mode: z.enum(["improve", "fix_grammar", "shorten", "friendly", "professional", "empathetic"]).default("improve"),
  room_id: id.optional(),
});
export const AiRoomBody = z.object({ room_id: id });

export const SessionBody = z.object({
  name: z.string().trim().max(100).optional(),
  email: z.string().email().max(254).optional().or(z.literal("")),
  phone: z.string().max(40).optional().or(z.literal("")),
  /** your own id for this person; only used together with a valid identity_hash */
  external_id: z.string().trim().min(1).max(128).optional(),
  /** hex HMAC-SHA256(identity secret, external_id|email), computed on YOUR server (docs/MOBILE-BRIDGE.md#identity-verification) */
  identity_hash: z.string().trim().max(64).optional(),
});
export const SessionAttributes = z.object({
  attributes: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Keys are lower-case letters, digits and _"), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 20, "At most 20 attributes"),
});
export const VisitorSend = z
  .object({
    content: z.string().max(4000).optional(),
    /** ids returned by POST /public/attachments (at most 4 per message) */
    attachment_ids: z.array(id).max(4).optional(),
    client_msg_id: clientMsgId.optional(),
  })
  .refine((b) => (b.content ?? "").length > 0 || (b.attachment_ids?.length ?? 0) > 0, "Send some text or an attachment");
export const OtpVerify = z.object({ code: z.string().regex(/^\d{5}$/, "Code is 5 digits") });

export const TypingBody = z.object({ room_id: id, typing: z.boolean(), internal: z.boolean().optional() });
export const CreditGrant = z.object({ amount: z.number().int().min(1).max(1_000_000), note: z.string().max(200).optional() });

/* ---- team chat ---- */
const memberId = z.string().regex(/^mem_[0-9a-f]{24}$/, "Invalid member id");
export const TeamChannelCreate = z.object({
  name: z.string().trim().min(1).max(60),
  visibility: z.enum(["public", "private"]).default("public"),
  topic: z.string().max(250).optional(),
  member_ids: z.array(memberId).max(200).optional(),
});
export const TeamChannelPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), topic: z.string().max(250).optional(), archived: z.boolean().optional() });
export const TeamDmBody = z.object({ member_ids: z.array(memberId).min(1).max(8) });
export const TeamMembersBody = z.object({ member_ids: z.array(memberId).min(1).max(200) });
export const TeamSendBody = z.object({
  content: z.string().max(4000).optional(),
  thread_root_id: z.string().max(64).nullable().optional(),
  attachment_ids: z.array(z.string().max(64)).max(10).optional(),
  client_msg_id: z.string().min(8).max(64).optional(),
  share_room_id: z.string().max(64).optional(),
});
export const TeamEditBody = z.object({ content: z.string().min(1).max(4000) });
export const TeamReactionBody = z.object({ emoji: z.string().min(1).max(32) });
export const TeamMuteBody = z.object({ muted: z.boolean() });
export const TeamReadBody = z.object({ message_id: z.string().max(64).optional() });
export const TeamListQuery = z.object({ before: z.string().max(64).optional(), after: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(50).default(30) });
export const TeamSearchQuery = z.object({ q: z.string().trim().min(2).max(100), channel_id: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const TeamSocketSend = TeamSendBody.extend({ channel_id: id });
export const TeamSocketTyping = z.object({ channel_id: id, typing: z.boolean(), thread_root_id: id.optional() });
export const TeamSocketRead = TeamReadBody.extend({ channel_id: id });
export const TeamSocketReaction = TeamReactionBody.extend({ message_id: id });

/* ---- tickets ---- */
export const TicketQuery = z.object({
  status: z.string().max(120).optional(),
  handler: z.string().max(80).optional(),
  department_id: id.optional(),
  priority_min: z.coerce.number().int().min(0).max(3).optional(),
  contact_id: id.optional(),
  room_id: id.optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["activity", "opened"]).default("activity"),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const TicketPatch = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  status: z.enum(["open", "pending_customer"]).optional(),
  summary: z.string().max(2000).optional(),
});
export const TicketBulk = z.object({ ticket_ids: z.array(id).min(1).max(100), action: z.enum(["resolve", "close"]) });
export const TicketMerge = z.object({ into_id: id });
export const TicketCsat = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional(), ticket_id: id.optional() });

/** Starting a conversation from the widget: all optional (an empty body is fine). `department_id` is the widget's name for `inbox_id`. */
export const PublicRoomBody = z
  .object({
    inbox_id: id.optional(),
    department_id: id.optional(),
    /** where the visitor is: only origin and path are kept (routing rules, AI agent context) */
    page_url: z.string().max(500).optional(),
    locale: z.string().max(20).optional(),
  })
  .default({});
export const TicketTransfer = z.object({ department_id: id, note: z.string().trim().max(500).optional() });
export const QuickReplyBody = z.object({ message_id: id, option_id: z.string().min(1).max(80) });
export const VisitorFeedback = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().trim().max(500).optional() });

/* ---- calls (socket events; docs/CALLS.md) ---- */
export const CallKind = z.enum(["voice", "video"]);
export const CallInviteBody = z.object({ room_id: id, kind: CallKind });
export const CallRequestBody = z.object({ room_id: id, kind: CallKind });
export const CallIdBody = z.object({ call_id: id });
export const CallFailedBody = z.object({ call_id: id, reason: z.string().max(40).default("failed") });
/** an SDP or an ICE candidate; the service checks sizes and the shape per kind */
/* AI calls (ADR 0033): the visitor's browser does the speech, these events carry text */
export const AiCallStartBody = z.object({
  room_id: id,
  kind: CallKind,
  locale: z.string().trim().max(20).optional(),
  speech: z.object({ stt: z.boolean(), tts: z.boolean(), webrtc: z.boolean().optional() }).optional(),
});
export const AiCallSayBody = z.object({ call_id: id, text: z.string().max(2000), seq: z.number().int().min(0).max(100000), via: z.enum(["voice", "typed"]).default("voice") });
export const AiCallToolBody = z.object({ call_id: id, name: z.string().min(1).max(40), arguments: z.string().max(4000).default("{}") });
export const AiCallTranscriptBody = z.object({ call_id: id, role: z.enum(["user", "assistant"]), text: z.string().max(4000), item_id: z.string().min(1).max(80), greeting: z.boolean().optional(), via: z.enum(["voice", "typed"]).default("voice") });
export const AiCallFallbackBody = z.object({ call_id: id, reason: z.string().max(40).default("client_failed") });
export const AiCallEndBody = z.object({ call_id: id, reason: z.enum(["completed", "silence", "unsupported", "error"]).default("completed") });
export const TeamCallInviteBody = z.object({ channel_id: id, kind: CallKind });
export const CallSignalBody = z.object({ call_id: id, data: z.record(z.string(), z.unknown()) });
