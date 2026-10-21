import { useQuery } from "@tanstack/react-query";
import { Mic, MicOff, MonitorUp, Phone, PhoneOff, UserPlus, Video, VideoOff, Presentation } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useMembers } from "../api/hooks";
import { useCan, useSession } from "../auth/AuthContext";
import { useSocket } from "../realtime/SocketProvider";
import { MemberPicker } from "../team/MemberPicker";
import { useTeamChannel } from "../team/hooks";
import type { TeamChannel } from "../team/types";
import { Button, Dialog, DialogFooter, cn, toast } from "../ui";
import type { CallKind } from "./engine";
import { GroupCallEngine, SKIP_REASONS, type GroupCallDto, type GroupTile, type GroupView } from "./groupEngine";
import type { TeamCallsConfig } from "./TeamCallProvider";

export interface GroupCallsConfig extends TeamCallsConfig {
  group: boolean;
  group_max: number;
  live_group_calls: GroupCallDto[];
}
interface GroupCallsValue {
  /** group calls are on and this member may place and take them */
  available: boolean;
  config: GroupCallsConfig | null;
  view: GroupView;
  engine: GroupCallEngine;
  start(channel: TeamChannel, kind: CallKind, inviteIds?: string[]): Promise<void>;
  join(callId: string, kind: CallKind, title: string): Promise<void>;
}
const Ctx = createContext<GroupCallsValue | null>(null);
/** Null outside the provider: the call buttons simply do not show. */
export const useGroupCalls = (): GroupCallsValue | null => useContext(Ctx);

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function GroupCallProvider({ children }: { children: ReactNode }) {
  const socket = useSocket();
  const canCall = useCan("calls:internal");
  const me = useSession().member;
  const cfg = (useQuery({ queryKey: ["team-calls", "config"], enabled: canCall, staleTime: 60_000, queryFn: () => api.get<GroupCallsConfig>("/team-calls/config") }).data ?? null) as GroupCallsConfig | null;
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const engine = useMemo(
    () => new GroupCallEngine({ selfId: () => me.id, selfName: () => me.name, transport: { emit: (e, p, t) => socketRef.current.emit(e, p, t), subscribe: (e, h) => socketRef.current.subscribe(e, h) } }),
    [me.id, me.name],
  );
  const [view, setView] = useState<GroupView>(engine.state);
  useEffect(() => engine.subscribe(setView), [engine]);
  useEffect(() => () => engine.reset(), [engine]);
  useEffect(() => {
    if (!socket.connected || !canCall) return;
    return socket.subscribe("gcall:state", ((p: { call: GroupCallDto }) => engine.handleState(p.call)) as never);
  }, [socket, socket.connected, canCall, engine]);
  // a tab opened in the middle of a ringing group call
  useEffect(() => {
    const ringing = cfg?.live_group_calls?.find((c) => c.participants.some((p) => p.member_id === me.id && p.status === "invited"));
    if (ringing && engine.state.phase === "idle") engine.handleState(ringing);
  }, [cfg?.live_group_calls, engine, me.id]);
  const available = canCall && !!cfg?.enabled && !!cfg.group;
  const start = useCallback(
    async (channel: TeamChannel, kind: CallKind, inviteIds?: string[]) => {
      const r = await engine.start(channel.id, kind, channel.title, inviteIds);
      if (!r.ok) toast({ title: "Could not start the call", description: r.message, tone: "error" });
      else if (r.skipped.length) toast({ title: "Some people could not be rung", description: r.skipped.map((s) => `${s.name} ${SKIP_REASONS[s.reason] ?? s.reason}`).join(". "), tone: "default" });
    },
    [engine],
  );
  const join = useCallback(
    async (callId: string, kind: CallKind, title: string) => {
      const r = await engine.join(callId, kind, title);
      if (!r.ok) toast({ title: "Could not join the call", description: r.message, tone: "error" });
    },
    [engine],
  );
  const value = useMemo<GroupCallsValue>(() => ({ available, config: cfg, view, engine, start, join }), [available, cfg, view, engine, start, join]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <IncomingGroupCall />
      <GroupCallPanel />
    </Ctx.Provider>
  );
}

function useRing(on: boolean) {
  useEffect(() => {
    if (!on || typeof window === "undefined") return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext | null = null;
    const beep = () => {
      try {
        ctx ??= new Ctor();
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);
        g.gain.value = 0.05;
        osc.frequency.value = 480;
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } catch {
        /* the screen is the signal */
      }
    };
    beep();
    const t = setInterval(beep, 2200);
    return () => {
      clearInterval(t);
      void ctx?.close().catch(() => {});
    };
  }, [on]);
}

/** Rings in every tab, wherever the member is in the app. */
export function IncomingGroupCall() {
  const c = useGroupCalls();
  const accept = useRef<HTMLButtonElement>(null);
  const ringing = c?.view.phase === "ringing_in";
  useRing(!!ringing);
  useEffect(() => {
    if (ringing) accept.current?.focus();
  }, [ringing]);
  if (!c || !ringing) return null;
  const { view, engine } = c;
  const others = (view.call?.participants ?? []).filter((p) => p.status === "joined").length;
  return (
    <section role="alertdialog" aria-label="Incoming group call" aria-describedby="incoming-gcall-text" className="fixed left-1/2 top-4 z-[60] flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-border-strong bg-neutral-900 p-3 text-white shadow-xl">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white/15" aria-hidden="true">
        {view.kind === "video" ? <Video className="size-5" /> : <Phone className="size-5" />}
      </span>
      <p id="incoming-gcall-text" className="min-w-0 flex-1 text-sm">
        <strong className="block truncate">{view.title}</strong>
        <span className="text-white/80">
          invites you to a group {view.kind === "video" ? "video " : ""}call{others > 0 ? ` (${others} in it now)` : ""}
        </span>
      </p>
      <button ref={accept} type="button" aria-label={`Join the group call from ${view.title}`} onClick={() => void engine.join()} className="grid size-11 place-items-center rounded-full bg-success text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        <Phone className="size-5" aria-hidden="true" />
      </button>
      <button type="button" aria-label={`Decline the group call from ${view.title}`} onClick={() => void engine.decline()} className="grid size-11 place-items-center rounded-full bg-danger text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        <PhoneOff className="size-5" aria-hidden="true" />
      </button>
    </section>
  );
}

function Tile({ tile, big }: { tile: GroupTile; big?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = tile.stream;
  }, [tile.stream]);
  const self = tile.link === "self";
  const showVideo = !!tile.stream && tile.stream.getVideoTracks().length > 0 && (!tile.cameraOff || tile.presenting);
  return (
    <li
      data-testid="group-tile"
      data-speaking={tile.speaking || undefined}
      aria-label={`${tile.name}${tile.speaking ? ", speaking" : ""}${tile.muted ? ", muted" : ""}${tile.presenting ? ", sharing their screen" : ""}`}
      className={cn("relative grid place-items-center overflow-hidden rounded-lg bg-neutral-800 ring-2 ring-transparent transition-shadow", tile.speaking && "ring-success", big ? "aspect-video" : "aspect-video")}
    >
      {/* every remote tile plays its person's audio through its own media element, also in a voice call */}
      <video ref={ref} autoPlay playsInline muted={self} className={cn("size-full object-contain", self && !tile.presenting && "-scale-x-100", !showVideo && "hidden")} />
      {!showVideo && (
        <span className="grid size-12 place-items-center rounded-full bg-white/15 text-lg font-semibold" aria-hidden="true">
          {tile.name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-xs">
        {tile.muted && <MicOff className="size-3.5 text-danger-soft" aria-hidden="true" />}
        {tile.presenting && <Presentation className="size-3.5" aria-hidden="true" />}
        <span className="truncate">{tile.name}</span>
        {tile.link === "connecting" && <span className="ml-auto text-white/70">Connecting...</span>}
        {tile.link === "reconnecting" && <span className="ml-auto text-warning">Reconnecting...</span>}
      </span>
    </li>
  );
}

/** The call in progress (or just ended): floats over the app so the conversation stays in view. */
export function GroupCallPanel() {
  const c = useGroupCalls();
  const [adding, setAdding] = useState(false);
  const v = c?.view;
  if (!c || !v || v.phase === "idle" || v.phase === "ringing_in") return null;
  const { engine } = c;
  const video = v.kind === "video";
  const presenter = v.tiles.find((t) => t.presenting);
  const rest = v.tiles.filter((t) => t !== presenter);
  const count = v.tiles.length;
  const max = v.call?.max_participants ?? 4;
  const pending = (v.call?.participants ?? []).filter((p) => p.status === "invited");
  if (v.phase === "ended") {
    return (
      <section role="dialog" aria-label="Group call ended" className="fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] items-center justify-between gap-2 rounded-xl border border-border-strong bg-neutral-900 p-3 text-white shadow-xl">
        <p className="text-sm" role="status">
          {v.message}
        </p>
        <button type="button" className="rounded-md bg-white/15 px-3 py-1.5 text-sm font-medium hover:bg-white/25" onClick={() => engine.reset()}>
          Close
        </button>
      </section>
    );
  }
  return (
    <section role="dialog" aria-label={`Group call: ${v.title}`} className="fixed bottom-4 right-4 z-50 flex w-[min(34rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border-strong bg-neutral-900 text-white shadow-xl">
      <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
        <span className="min-w-0 truncate font-medium">{v.title}</span>
        <span className="flex shrink-0 items-center gap-3 tabular-nums">
          <span>
            {count} of {max}
          </span>
          <span role="timer">{mmss(v.seconds)}</span>
        </span>
      </div>
      <ul className={cn("grid gap-2 px-3", presenter ? "grid-cols-1" : count > 1 ? "grid-cols-2" : "grid-cols-1")} aria-label="People in the call">
        {presenter && <Tile tile={presenter} big />}
        {presenter ? (
          <li className="list-none">
            <ul className="grid grid-cols-4 gap-2">
              {rest.map((t) => (
                <Tile key={t.memberId} tile={t} />
              ))}
            </ul>
          </li>
        ) : (
          v.tiles.map((t) => <Tile key={t.memberId} tile={t} />)
        )}
      </ul>
      {pending.length > 0 && (
        <p className="px-3 pt-2 text-xs text-white/80" role="status">
          Ringing: {pending.map((p) => p.name).join(", ")}
        </p>
      )}
      {(v.message || v.warning) && (
        <p className="px-3 pt-2 text-xs text-white/80" role="status">
          {v.message || v.warning}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2 p-3">
        <button type="button" aria-label={v.muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={v.muted} onClick={() => engine.toggleMute()} className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 aria-pressed:bg-white aria-pressed:text-neutral-900">
          {v.muted ? <MicOff className="size-5" aria-hidden="true" /> : <Mic className="size-5" aria-hidden="true" />}
        </button>
        {video && v.local?.getVideoTracks().length ? (
          <button type="button" aria-label={v.cameraOff ? "Turn camera on" : "Turn camera off"} aria-pressed={v.cameraOff} onClick={() => engine.toggleCamera()} className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 aria-pressed:bg-white aria-pressed:text-neutral-900">
            {v.cameraOff ? <VideoOff className="size-5" aria-hidden="true" /> : <Video className="size-5" aria-hidden="true" />}
          </button>
        ) : null}
        {video && c.config?.screen_share ? (
          <button
            type="button"
            aria-label={v.sharing ? "Stop sharing your screen" : "Share your screen"}
            aria-pressed={v.sharing}
            disabled={!v.sharing && !!v.call?.sharing_id && v.call.sharing_id !== v.tiles.find((t) => t.link === "self")?.memberId}
            title={v.call?.sharing_id && !v.sharing ? "Someone else is sharing their screen" : undefined}
            onClick={() => void engine.toggleShare()}
            className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 disabled:opacity-40 aria-pressed:bg-white aria-pressed:text-neutral-900"
          >
            <MonitorUp className="size-5" aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" aria-label="Add people to the call" disabled={count + pending.length >= max} title={count + pending.length >= max ? `At most ${max} people` : undefined} onClick={() => setAdding(true)} className="grid size-11 place-items-center rounded-full bg-white/15 hover:bg-white/25 disabled:opacity-40">
          <UserPlus className="size-5" aria-hidden="true" />
        </button>
        <button type="button" aria-label="Leave the call" onClick={() => void engine.leave()} className="grid size-11 place-items-center rounded-full bg-danger text-white hover:brightness-110">
          <PhoneOff className="size-5" aria-hidden="true" />
        </button>
      </div>
      {adding && <AddPeople onClose={() => setAdding(false)} />}
    </section>
  );
}

/** Which people of the conversation to ring: used to start a call and to add people to one. */
export function PickPeople({ channel, onClose, title, action, room, preselect = [], exclude = [], onConfirm }: { channel: TeamChannel; onClose: () => void; title: string; action: string; room: number; preselect?: string[]; exclude?: string[]; onConfirm: (ids: string[]) => Promise<void> | void }) {
  const detail = useTeamChannel(channel.id);
  const members = useMembers();
  const [ids, setIds] = useState<string[]>(preselect);
  const [busy, setBusy] = useState(false);
  const inChannel = new Set((detail.data?.members ?? channel.members ?? []).map((m) => m.id));
  const hide = channel.visibility === "public" && channel.kind === "channel" ? exclude : [...(members.data ?? []).map((m) => m.id).filter((id) => !inChannel.has(id)), ...exclude];
  return (
    <Dialog title={title} description={`Up to ${room} more ${room === 1 ? "person" : "people"}. Each person's device sends audio and video to each other person, which is why a group call has a limit.`} onClose={onClose}>
      <MemberPicker value={ids} onChange={(next) => setIds(next.slice(-room))} exclude={hide} label="People to ring" autoFocus />
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {ids.length} of {room} chosen
      </p>
      <DialogFooter className="-mx-5 -mb-4 mt-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm(ids);
            setBusy(false);
            onClose();
          }}
        >
          {action}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function AddPeople({ onClose }: { onClose: () => void }) {
  const c = useGroupCalls()!;
  const { view, engine } = c;
  const channel = useTeamChannel(view.channelId ?? undefined).data;
  const taken = (view.call?.participants ?? []).filter((p) => p.status === "joined" || p.status === "invited");
  if (!channel) return null;
  return (
    <PickPeople
      channel={channel}
      onClose={onClose}
      title="Add people to the call"
      action="Ring them"
      room={Math.max(1, (view.call?.max_participants ?? 4) - taken.length)}
      exclude={taken.map((p) => p.member_id)}
      onConfirm={async (ids) => {
        if (!ids.length) return;
        const r = await engine.invite(ids);
        if (!r.ok) toast({ title: "Could not add them", description: r.message, tone: "error" });
        else if (r.skipped.length) toast({ title: "Some people could not be rung", description: r.skipped.map((s) => `${s.name} ${SKIP_REASONS[s.reason] ?? s.reason}`).join(". "), tone: "default" });
      }}
    />
  );
}

/** Voice and video buttons of a group message or channel: start a call, picking who to ring. */
export function GroupCallButtons({ channel }: { channel: TeamChannel }) {
  const g = useGroupCalls();
  const [picking, setPicking] = useState<CallKind | null>(null);
  const { member } = useSession();
  if (!g?.available || !g.config || channel.kind === "dm" || !channel.joined || channel.archived) return null;
  const busy = g.view.phase !== "idle" && g.view.phase !== "ended";
  const live = g.config.live_group_calls?.some((x) => x.channel_id === channel.id);
  const why = busy ? "You are in a call" : null;
  const max = g.config.group_max;
  const others = (channel.member_ids ?? channel.members?.map((m) => m.id) ?? []).filter((id) => id !== member.id);
  const kinds = [g.config.voice && ("voice" as const), g.config.video && ("video" as const)].filter(Boolean) as CallKind[];
  void live;
  return (
    <>
      {kinds.map((k) => (
        <Button key={k} variant="ghost" size="icon-sm" aria-label={`Start a group ${k} call`} title={why ?? `Start a group ${k} call (up to ${max} people)`} disabled={!!why} onClick={() => setPicking(k)}>
          {k === "voice" ? <Phone /> : <Video />}
        </Button>
      ))}
      {picking && (
        <PickPeople
          channel={channel}
          onClose={() => setPicking(null)}
          title={`Start a group ${picking} call`}
          action="Start the call"
          room={max - 1}
          preselect={channel.kind === "group" && others.length <= max - 1 ? others : []}
          onConfirm={async (ids) => g.start(channel, picking, ids)}
        />
      )}
    </>
  );
}

/** The card of a group call in the conversation: shows who is in it and a Join button while it is live. */
export function GroupCallCard({ call }: { call: { id: string; kind: CallKind; state: string; joined: number; max: number }; text: string }) {
  const g = useGroupCalls();
  const mine = g?.view.callId === call.id && (g.view.phase === "in_call" || g.view.phase === "joining");
  const canJoin = !!g?.available && call.state === "live" && !mine && (g.view.phase === "idle" || g.view.phase === "ended") && call.joined < call.max;
  // a finished call is said by the line above the card ("Group video call, 4 min"): no box
  if (call.state !== "live") return null;
  return (
    <div className="mt-1 inline-flex max-w-full items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm" data-testid="group-call-card">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-text" aria-hidden="true">
        {call.kind === "video" ? <Video className="size-4" /> : <Phone className="size-4" />}
      </span>
      <span className="min-w-0">{call.state === "live" && call.joined >= call.max ? "Full" : mine ? "You are in this call" : ""}</span>
      {canJoin && (
        <Button size="sm" onClick={() => void g!.join(call.id, call.kind, "")}>
          Join
        </Button>
      )}
    </div>
  );
}
