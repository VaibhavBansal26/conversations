import type { Channel, ContactBrief, EmailSender, MessageKind } from "../api/types";

/** The server rejects SMS bodies of 1600 characters or more. */
export const SMS_LIMIT = 1599;

export interface ComposerState {
  channel: Channel;
  isNote: boolean;
  text: string;
  subject: string;
  from: string;
  attachmentCount: number;
  contact: Pick<ContactBrief, "email" | "phone" | "sms_opt_out"> | null;
  senders: Pick<EmailSender, "address" | "verified">[];
}

export interface ComposerCheck {
  channel: Channel;
  canSend: boolean;
  /** Blocking problems the agent can fix. */
  problems: string[];
  smsRemaining: number | null;
}

/** Internal notes never leave the workspace, so they are always plain chat messages. */
export const effectiveChannel = (channel: Channel, isNote: boolean): Channel => (isNote ? "dm" : channel);

export const verifiedSenders = <T extends Pick<EmailSender, "verified">>(senders: T[]): T[] => senders.filter((s) => s.verified);

export function defaultEmailSubject(opts: { roomSubject: string | null; lastEmailSubject: string | null; contactName: string }): string {
  const base = opts.lastEmailSubject || opts.roomSubject;
  if (base) return /^re:/i.test(base) ? base : `Re: ${base}`;
  return `Conversation with ${opts.contactName || "customer"}`;
}

export function checkComposer(s: ComposerState): ComposerCheck {
  const channel = effectiveChannel(s.channel, s.isNote);
  const problems: string[] = [];
  const hasBody = s.text.trim().length > 0;
  let smsRemaining: number | null = null;

  if (channel === "sms") {
    smsRemaining = SMS_LIMIT - s.text.length;
    if (!s.contact?.phone) problems.push("This contact has no phone number, so SMS is unavailable.");
    if (s.contact?.sms_opt_out) problems.push("This contact opted out of SMS (STOP). Texts are blocked.");
    if (smsRemaining < 0) problems.push(`SMS is limited to ${SMS_LIMIT} characters (${-smsRemaining} over).`);
    if (s.attachmentCount > 0) problems.push("SMS supports text only. Remove the attachments or switch channel.");
  }
  if (s.isNote && s.attachmentCount > 0) problems.push("Internal notes cannot have attachments.");
  if (channel === "email") {
    if (!s.contact?.email) problems.push("This contact has no email address, so email is unavailable.");
    if (!verifiedSenders(s.senders).some((x) => x.address === s.from)) problems.push("Choose a verified sender address to send email.");
    if (!s.subject.trim()) problems.push("Add a subject for the email.");
  }
  const empty = !hasBody && s.attachmentCount === 0;
  return { channel, canSend: !empty && problems.length === 0, problems, smsRemaining };
}

/** The server only accepts attachments on image / voice / attachment messages, and quoted replies as "ref". */
export function messageKindFor(o: { isNote: boolean; hasRef: boolean; attachmentTypes: string[] }): MessageKind {
  if (o.isNote) return "note";
  const types = o.attachmentTypes;
  if (types.length) {
    if (types.every((t) => t.startsWith("image/"))) return "image";
    if (types.length === 1 && types[0]?.startsWith("audio/")) return "voice";
    return "attachment";
  }
  return o.hasRef ? "ref" : "text";
}
