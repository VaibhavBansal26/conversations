import type { RoomFilter, RoomSort, RoomStatusTab } from "../api/types";

export interface RoomListFilters {
  status: RoomStatusTab;
  filter?: RoomFilter;
  inbox_id?: string;
  search?: string;
  sort: RoomSort;
}

export const keys = {
  me: ["me"] as const,
  rooms: ["rooms"] as const,
  roomList: (f: RoomListFilters) => ["rooms", f] as const,
  room: (id: string) => ["room", id] as const,
  thread: (roomId: string) => ["thread", roomId] as const,
  counts: ["counts"] as const,
  inboxes: ["inboxes"] as const,
  members: ["members"] as const,
  contact: (id: string) => ["contact", id] as const,
  contactNotes: (id: string) => ["contact", id, "notes"] as const,
  contactRooms: (id: string) => ["contact", id, "rooms"] as const,
  tickets: ["tickets"] as const,
  ticketList: (f: object) => ["tickets", "list", f] as const,
  ticketCounts: ["tickets", "counts"] as const,
  roomTickets: (roomId: string) => ["tickets", "room", roomId] as const,
  contactTickets: (contactId: string) => ["tickets", "contact", contactId] as const,
  departments: ["departments"] as const,
  departmentStatus: ["departments", "status"] as const,
  routingRules: ["routing-rules"] as const,
  templates: ["templates"] as const,
  senders: ["email-senders"] as const,
  smsNumbers: ["sms-numbers"] as const,
  inbound: ["inbound-addresses"] as const,
  tokens: ["tokens"] as const,
  identity: ["identity"] as const,
  kb: ["kb"] as const,
  notifications: ["notifications"] as const,
  workspace: ["workspace"] as const,
  aiStatus: ["ai-status"] as const,
  credits: ["credits"] as const,
  billing: ["billing"] as const,
  channelStatus: ["channel-status"] as const,
  channelConnections: ["channel-connections"] as const,
  channelEvents: (c: string) => ["channel-events", c] as const,
};
