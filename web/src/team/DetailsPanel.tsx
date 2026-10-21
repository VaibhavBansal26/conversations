import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BellOff, LogOut, Pin, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useCan, useSession } from "../auth/AuthContext";
import { useSocket } from "../realtime/SocketProvider";
import { Avatar, Button, ConfirmDialog, ErrorNotice, Field, Input, Skeleton, Switch, toast } from "../ui";
import { RichText } from "../components/chat/RichText";
import { teamKeys } from "./cache";
import { MemberPicker } from "./MemberPicker";
import { useTeamChannel, useTeamPins } from "./hooks";
import type { TeamChannel } from "./types";

function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex h-full min-h-0 w-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

export function PinsPanel({ channel, onClose, onUnpin }: { channel: TeamChannel; onClose: () => void; onUnpin: (id: string) => void }) {
  const pins = useTeamPins(channel.id, true);
  return (
    <PanelShell title="Pinned messages" onClose={onClose}>
      {pins.isPending && <Skeleton className="h-16" />}
      {pins.data?.length === 0 && (
        <p className="py-8 text-center text-sm text-subtle">
          <Pin className="mx-auto mb-2 size-5" aria-hidden="true" />
          Nothing is pinned yet. Pin a message from its action bar to keep it handy.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {pins.data?.map((m) => (
          <li key={m.id} className="rounded-lg border border-border p-3">
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <strong className="text-foreground">{m.sender.name}</strong>
              <time dateTime={m.created_at}>{new Date(m.created_at).toLocaleDateString()}</time>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">
              <RichText text={m.content} />
            </p>
            <Button variant="ghost" size="sm" className="mt-1.5 -ml-2" onClick={() => onUnpin(m.id)}>
              Unpin
            </Button>
          </li>
        ))}
      </ul>
    </PanelShell>
  );
}

export function DetailsPanel({ channel, onClose }: { channel: TeamChannel; onClose: () => void }) {
  const { member } = useSession();
  const detail = useTeamChannel(channel.id);
  const manage = useCan("team_chat:manage_channels");
  const { onlineMembers } = useSocket();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [topic, setTopic] = useState<string | null>(null);
  const [add, setAdd] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"leave" | "archive" | null>(null);
  const owner = channel.role === "owner";
  const isChannel = channel.kind === "channel";
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: teamKeys.channel(channel.id) });
    void qc.invalidateQueries({ queryKey: teamKeys.channels });
  };
  const patch = useMutation({ mutationFn: (b: { topic?: string; archived?: boolean }) => api.patch(`/team/channels/${channel.id}`, b), onSuccess: () => { toast({ title: "Saved", tone: "success" }); setTopic(null); refresh(); } });
  const mute = useMutation({ mutationFn: (muted: boolean) => api.put(`/team/channels/${channel.id}/mute`, { muted }), onSuccess: refresh });
  const addMembers = useMutation({ mutationFn: () => api.post(`/team/channels/${channel.id}/members`, { member_ids: add }), onSuccess: () => { setAdd([]); toast({ title: "People added", tone: "success" }); refresh(); } });
  const removeMember = useMutation({ mutationFn: (id: string) => api.delete(`/team/channels/${channel.id}/members/${id}`), onSuccess: refresh });
  const leave = useMutation({ mutationFn: () => api.post(`/team/channels/${channel.id}/leave`), onSuccess: () => { refresh(); nav("/team"); } });
  const members = detail.data?.members ?? [];
  const canInvite = isChannel && !channel.archived && (manage || owner || (channel.visibility === "public" && channel.joined));

  return (
    <PanelShell title={isChannel ? "Channel details" : "Conversation details"} onClose={onClose}>
      <div className="flex flex-col gap-6">
        {isChannel && (
          <section aria-label="Topic">
            <form
              className="flex flex-col gap-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (topic !== null) patch.mutate({ topic });
              }}
            >
              <Field label="Topic">
                <Input value={topic ?? channel.topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} disabled={!(manage || owner)} placeholder="What is this channel for?" />
              </Field>
              {(manage || owner) && topic !== null && topic !== channel.topic && (
                <Button type="submit" size="sm" className="self-start" loading={patch.isPending}>
                  Save topic
                </Button>
              )}
            </form>
          </section>
        )}
        {channel.joined && (
          <Switch label="Mute notifications" hint="A muted conversation stays quiet unless someone mentions you by name." checked={channel.muted} onChange={(v) => mute.mutate(v)} />
        )}
        <section aria-label="Members">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
            {channel.member_count} member{channel.member_count === 1 ? "" : "s"}
          </h3>
          {detail.isPending && <Skeleton className="h-20" />}
          {detail.isError && <ErrorNotice error={detail.error} compact />}
          <ul className="flex flex-col">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-1.5">
                <Avatar name={m.name} seed={m.id} size="sm" online={onlineMembers.has(m.id)} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {m.name}
                  {m.id === member.id && <span className="text-subtle"> (you)</span>}
                </span>
                {m.role === "owner" && <span className="rounded bg-surface-3 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Owner</span>}
                {isChannel && (manage || owner) && m.id !== member.id && !channel.is_general && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => removeMember.mutate(m.id)}>
                    <X />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {removeMember.isError && <ErrorNotice error={removeMember.error} compact />}
        </section>
        {canInvite && (
          <section aria-label="Add people" className="flex flex-col gap-2">
            <MemberPicker value={add} onChange={setAdd} exclude={members.map((m) => m.id)} label="Add people" />
            <Button size="sm" className="self-start" disabled={!add.length} loading={addMembers.isPending} onClick={() => addMembers.mutate()}>
              Add {add.length || ""} {add.length === 1 ? "person" : "people"}
            </Button>
            {addMembers.isError && <ErrorNotice error={addMembers.error} compact />}
          </section>
        )}
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          {isChannel && channel.joined && !channel.is_general && (
            <Button variant="outline" onClick={() => setConfirm("leave")} className="justify-start">
              <LogOut aria-hidden="true" /> Leave channel
            </Button>
          )}
          {isChannel && manage && !channel.is_general && (
            <Button variant="danger-ghost" onClick={() => setConfirm("archive")} className="justify-start">
              <BellOff aria-hidden="true" /> {channel.archived ? "Unarchive channel" : "Archive channel"}
            </Button>
          )}
          {leave.isError && <ErrorNotice error={leave.error} compact />}
          {patch.isError && <ErrorNotice error={patch.error} compact />}
        </div>
      </div>
      {confirm === "leave" && <ConfirmDialog title="Leave this channel?" description="You will stop receiving its messages. You can rejoin a public channel at any time." confirmLabel="Leave" onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); leave.mutate(); }} />}
      {confirm === "archive" && (
        <ConfirmDialog
          title={channel.archived ? "Unarchive this channel?" : "Archive this channel?"}
          description={channel.archived ? "People can write in it again." : "It becomes read-only. History stays searchable and the name becomes free."}
          confirmLabel={channel.archived ? "Unarchive" : "Archive"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); patch.mutate({ archived: !channel.archived }); }}
        />
      )}
    </PanelShell>
  );
}
