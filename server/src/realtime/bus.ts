/**
 * What services need from the realtime layer. Services never touch Socket.IO directly,
 * which keeps them testable and lets the adapter (memory/redis) stay a deployment concern.
 */
export interface RealtimeBus {
  /**
   * Emit to every team socket that may see the room. `visitor` (when given) is the payload
   * for the room's visitor sockets; omit it for team-only events such as notes.
   */
  toRoom(workspaceId: string, roomId: string, event: string, payload: unknown, opts?: { visitor?: unknown }): void;
  toMember(workspaceId: string, memberId: string, event: string, payload: unknown): void;
  /** One socket only (call signalling: offers and ICE candidates must reach the other party and nobody else). */
  toSocket(workspaceId: string, socketId: string, event: string, payload: unknown): void;
  toInbox(workspaceId: string, inboxId: string, event: string, payload: unknown): void;
  toManagers(workspaceId: string, event: string, payload: unknown): void;
  toWorkspace(workspaceId: string, event: string, payload: unknown): void;
  /** Re-evaluate which sockets belong in the room (after create/assign/inbox change). */
  refreshRoomAccess(workspaceId: string, roomId: string): Promise<void>;
  /** Re-evaluate everything a member's sockets are joined to (role/inbox change). */
  refreshMemberAccess(workspaceId: string, memberId: string): Promise<void>;
  /** Re-evaluate which rooms a visitor session may join (after OTP verification). */
  refreshVisitorAccess(workspaceId: string, sessionId: string): Promise<void>;
  disconnectMember(workspaceId: string, memberId: string): void;
}

export interface RecordedEvent {
  workspaceId: string;
  target: "room" | "member" | "socket" | "inbox" | "managers" | "workspace";
  targetId?: string;
  event: string;
  payload: any;
  visitor?: unknown;
}

/** Collects events instead of sending them; used by tests and by the standalone (no socket) context. */
export class RecordingBus implements RealtimeBus {
  readonly events: RecordedEvent[] = [];
  readonly refreshed: string[] = [];
  readonly disconnected: string[] = [];

  toRoom(workspaceId: string, roomId: string, event: string, payload: unknown, opts?: { visitor?: unknown }) {
    this.events.push({ workspaceId, target: "room", targetId: roomId, event, payload, visitor: opts?.visitor });
  }
  toMember(workspaceId: string, memberId: string, event: string, payload: unknown) {
    this.events.push({ workspaceId, target: "member", targetId: memberId, event, payload });
  }
  toSocket(workspaceId: string, socketId: string, event: string, payload: unknown) {
    this.events.push({ workspaceId, target: "socket", targetId: socketId, event, payload });
  }
  toInbox(workspaceId: string, inboxId: string, event: string, payload: unknown) {
    this.events.push({ workspaceId, target: "inbox", targetId: inboxId, event, payload });
  }
  toManagers(workspaceId: string, event: string, payload: unknown) {
    this.events.push({ workspaceId, target: "managers", event, payload });
  }
  toWorkspace(workspaceId: string, event: string, payload: unknown) {
    this.events.push({ workspaceId, target: "workspace", event, payload });
  }
  async refreshRoomAccess(_ws: string, roomId: string) {
    this.refreshed.push(`room:${roomId}`);
  }
  async refreshMemberAccess(_ws: string, memberId: string) {
    this.refreshed.push(`member:${memberId}`);
  }
  async refreshVisitorAccess(_ws: string, sessionId: string) {
    this.refreshed.push(`visitor:${sessionId}`);
  }
  disconnectMember(_ws: string, memberId: string) {
    this.disconnected.push(memberId);
  }
  ofType(event: string) {
    return this.events.filter((e) => e.event === event);
  }
  clear() {
    this.events.length = 0;
  }
}
