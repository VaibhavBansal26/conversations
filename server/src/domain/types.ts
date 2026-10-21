export type Role = "owner" | "manager" | "agent";
export type Availability = "active" | "away" | "inactive";
export type InboxVisibility = "assigned" | "assigned_inbox";
export type MessageKind = "text" | "image" | "voice" | "gif" | "attachment" | "ref" | "note" | "system";
export type MessageSource = "dm" | "sms" | "email";
export type SenderType = "agent" | "contact" | "bot" | "system";
/** `not_sent_test_mode`: the active provider is the console/fake one, the message was stored but nothing left the server */
export type Delivery = "pending" | "sent" | "delivered" | "failed" | "not_sent_test_mode";

export interface NotificationPrefs {
  assigned_to_you: boolean;
  assigned_to_your_team: boolean;
  unassigned: boolean;
  delayed_msgs: boolean;
  email: boolean;
  mentions: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  assigned_to_you: true,
  assigned_to_your_team: true,
  unassigned: true,
  delayed_msgs: true,
  email: true,
  mentions: true,
};

/** The authenticated team member ("seat") performing a request. */
export interface Actor {
  memberId: string;
  userId: string;
  workspaceId: string;
  role: Role;
  name: string;
  email: string;
  liveSeat: boolean;
  inboxVisibility: InboxVisibility;
  /** what this seat may do (from its role); `can(actor, permission)` is the check */
  permissions: ReadonlySet<string>;
  /** key of the role: owner | manager | agent | viewer | a custom role's key */
  roleKey: string;
  /** set on a support token: the platform admin looking at this workspace. Such an actor is read-only everywhere (REST and sockets) */
  impersonatedBy?: string;
}

export const seesAll = (a: Pick<Actor, "role">): boolean => a.role === "owner" || a.role === "manager";

export interface Attachment {
  id: string;
  file_name: string;
  content_type: string;
  size: number;
  key: string;
}
