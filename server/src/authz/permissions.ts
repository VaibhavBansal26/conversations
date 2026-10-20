/**
 * Permission catalogue and the immutable system roles. Permissions are `resource:action` strings; a role is a set of them.
 * The same `can()` check guards REST routes (routePerms.ts) and socket events (EVENT_PERMS), so there is one source of truth.
 */
export const PERMISSIONS = {
  "conversations:read": "See conversations in scope",
  "conversations:reply": "Send messages and notes, change status, snooze, assign to self",
  "conversations:assign": "Assign conversations to other seats and inboxes",
  "conversations:delete": "Delete conversations and other people's messages",
  "contacts:read": "See contacts",
  "contacts:write": "Create and edit contacts and notes",
  "contacts:import": "Import contacts from CSV",
  "contacts:delete": "Delete contacts",
  "inboxes:manage": "Create and edit inboxes and their members",
  "members:read": "See the team",
  "members:manage": "Add, edit and remove team members",
  "roles:manage": "Create custom roles and change member roles",
  "settings:read": "See workspace settings",
  "settings:write": "Change workspace settings",
  "channels:manage": "Manage SMS numbers, email senders and inbound addresses",
  "tokens:manage": "Manage widget embed tokens",
  "templates:manage": "Manage reply templates",
  "kb:manage": "Manage the knowledge base",
  "ai:use": "Use AI assistance",
  "billing:manage": "See and change plan, credits and payment methods, connect a Stripe account",
  "payments:request": "Send payment requests to customers in a conversation",
  "analytics:read": "See analytics",
  "analytics:export": "Export analytics data",
  "analytics_identity:manage": "View, set (import) or rotate the analytics identity pepper",
  "api_keys:manage": "Create and revoke API keys",
  "audit:read": "Read the audit log",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const without = (xs: Permission[], drop: Permission[]) => xs.filter((x) => !drop.includes(x));

export interface SystemRole {
  id: string;
  key: "owner" | "manager" | "agent" | "viewer";
  name: string;
  description: string;
  /** which legacy role this seat behaves as for room visibility: owner/manager see everything, agent sees assigned rooms */
  baseRole: "owner" | "manager" | "agent";
  permissions: Permission[];
}

export const SYSTEM_ROLES: SystemRole[] = [
  { id: "role_owner", key: "owner", name: "Owner", description: "Full control, including billing and roles", baseRole: "owner", permissions: ALL_PERMISSIONS },
  {
    id: "role_manager",
    key: "manager",
    name: "Manager",
    description: "Runs the team and the workspace, without billing or role administration",
    baseRole: "manager",
    permissions: without(ALL_PERMISSIONS, ["billing:manage", "roles:manage", "analytics_identity:manage"]),
  },
  {
    id: "role_agent",
    key: "agent",
    name: "Agent",
    description: "Works conversations assigned to them (and their inboxes)",
    baseRole: "agent",
    permissions: ["conversations:read", "conversations:reply", "contacts:read", "contacts:write", "members:read", "settings:read", "ai:use", "payments:request"],
  },
  {
    id: "role_viewer",
    key: "viewer",
    name: "Viewer",
    description: "Read-only access to conversations, contacts and analytics",
    baseRole: "manager",
    permissions: ["conversations:read", "contacts:read", "members:read", "settings:read", "analytics:read"],
  },
];

export const isPermission = (p: unknown): p is Permission => typeof p === "string" && p in PERMISSIONS;

export interface PermissionHolder {
  permissions: ReadonlySet<string>;
}

/** The one check. Owners are not special-cased: they hold every permission through their role. */
export const can = (a: PermissionHolder, p: Permission): boolean => a.permissions.has(p);
