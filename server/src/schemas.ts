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
export const TokenBody = z.object({ domain: z.string().min(1).max(255) });

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
export const KbBody = z.object({ question: z.string().trim().min(3).max(500), answer: z.string().trim().min(1).max(4000) });
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
});
export const VisitorSend = z.object({ content: z.string().min(1).max(4000), client_msg_id: clientMsgId.optional() });
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
