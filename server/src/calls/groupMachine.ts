/**
 * The rules of a group call as pure functions, so they can be tested exhaustively (docs/CALLS.md, ADR 0038).
 *
 * A person in a group call is `invited` (their phone rings), `joined`, `left`, `declined` or `missed` (rang out). Anyone allowed to see the conversation
 * can join while the call is live, also after declining, missing or leaving. The call is `live` until the last person leaves (then `ended`, or `missed`
 * when nobody but the host ever joined). The host leaving does not end anything.
 */
export const PARTICIPANT_STATUSES = ["invited", "joined", "left", "declined", "missed"] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];
export const PARTICIPANT_EVENTS = ["invite", "join", "leave", "decline", "ring_timeout", "gone_timeout"] as const;
export type ParticipantEvent = (typeof PARTICIPANT_EVENTS)[number];

export class IllegalParticipantTransition extends Error {
  constructor(
    readonly from: ParticipantStatus | null,
    readonly event: ParticipantEvent,
  ) {
    super(`a person who is ${from ?? "not in the call"} cannot ${event}`);
  }
}

const TABLE: Record<string, Partial<Record<ParticipantEvent, ParticipantStatus>>> = {
  none: { invite: "invited", join: "joined" },
  invited: { join: "joined", decline: "declined", ring_timeout: "missed", invite: "invited" },
  joined: { leave: "left", gone_timeout: "left" },
  left: { join: "joined", invite: "invited" },
  declined: { join: "joined", invite: "invited" },
  missed: { join: "joined", invite: "invited" },
};

/** The status after `event`, or an IllegalParticipantTransition. */
export function nextStatus(from: ParticipantStatus | null, event: ParticipantEvent): ParticipantStatus {
  const to = TABLE[from ?? "none"]![event];
  if (!to) throw new IllegalParticipantTransition(from, event);
  return to;
}

export const GROUP_MAX = 4;
/** The configured cap, kept between 2 and 4 whatever is stored. */
export const clampGroupMax = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(GROUP_MAX, Math.max(2, Math.trunc(n))) : GROUP_MAX);

/** May one more person join? (`joined` counts people in the call now.) */
export const hasRoom = (joined: number, max: number): boolean => joined < clampGroupMax(max);

/** The call after someone left or the sweep removed them: ended when nobody is in it. */
export function afterDeparture(joinedLeft: number, everConnected: boolean): "live" | "ended" | "missed" {
  if (joinedLeft > 0) return "live";
  return everConnected ? "ended" : "missed";
}

/** The label on the card in the conversation. */
export function groupCardText(c: { kind: "voice" | "video"; state: "live" | "ended" | "missed"; joined: number; duration_s: number | null }): string {
  const k = c.kind === "video" ? "Group video call" : "Group voice call";
  if (c.state === "live") return c.joined > 1 ? `${k}: ${c.joined} in the call` : `${k}: ringing`;
  if (c.state === "missed") return `Missed ${k.toLowerCase()}`;
  const s = c.duration_s ?? 0;
  return s > 0 ? `${k}, ${s < 60 ? `${s} s` : `${Math.max(1, Math.round(s / 60))} min`}` : `${k}, not connected`;
}
