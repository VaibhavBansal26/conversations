import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Hash, Lock, Search as SearchIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useCan } from "../auth/AuthContext";
import { Avatar, Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot, EmptyState, ErrorNotice, Field, Input, Skeleton, toast } from "../ui";
import { teamKeys } from "./cache";
import { MemberPicker } from "./MemberPicker";
import { useBrowseChannels, useTeamChannels, useTeamSearch } from "./hooks";
import type { TeamChannel } from "./types";

export function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const [people, setPeople] = useState<string[]>([]);
  const nav = useNavigate();
  const qc = useQueryClient();
  const open = useMutation({
    mutationFn: () => api.post<TeamChannel>("/team/dms", { member_ids: people }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: teamKeys.channels });
      onClose();
      nav(`/team/${c.id}`);
    },
  });
  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="New message" description="Pick one person for a direct message, or up to seven for a group." />
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (people.length) open.mutate();
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogBody>
            <MemberPicker value={people} onChange={setPeople} includeSelf autoFocus label="To" />
            {people.length > 7 && <p className="mt-2 text-xs text-danger-text">A group holds up to 8 people including you.</p>}
            {open.isError && <div className="mt-3"><ErrorNotice error={open.error} compact /></div>}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={open.isPending} disabled={!people.length || people.length > 7}>
              Start conversation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

export function CreateChannelDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [people, setPeople] = useState<string[]>([]);
  const nav = useNavigate();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.post<TeamChannel>("/team/channels", { name: name.trim(), topic: topic.trim() || undefined, visibility, member_ids: people }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: teamKeys.channels });
      void qc.invalidateQueries({ queryKey: teamKeys.browse });
      toast({ title: `#${c.name} created`, tone: "success" });
      onClose();
      nav(`/team/${c.id}`);
    },
  });
  const slug = name.trim().toLowerCase().replace(/^#/, "").replace(/[\s.]+/g, "-").replace(/[^a-z0-9_-]/g, "");
  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader title="Create a channel" description="Channels are for a team, a project or a topic." />
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (slug) create.mutate();
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogBody className="flex flex-col gap-4">
            <Field label="Name" hint={slug ? `It will be called #${slug}` : "Lower case letters, numbers, dashes and underscores"}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="support-escalations" maxLength={60} data-autofocus required />
            </Field>
            <Field label="Topic (optional)">
              <Input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} placeholder="What is this channel for?" />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[13px] font-medium">Who can see it</legend>
              {(
                [
                  ["public", "Public", "Everyone in the workspace can find and join it", Hash],
                  ["private", "Private", "Only people you add can see it", Lock],
                ] as const
              ).map(([v, label, hint, Icon]) => (
                <label key={v} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary-soft/40">
                  <input type="radio" name="visibility" className="mt-1 size-4 accent-[var(--color-primary)]" checked={visibility === v} onChange={() => setVisibility(v)} />
                  <Icon className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <MemberPicker value={people} onChange={setPeople} label="Add people (optional)" />
            {create.isError && <ErrorNotice error={create.error} compact />}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!slug}>
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

export function BrowseChannelsDialog({ onClose }: { onClose: () => void }) {
  const browse = useBrowseChannels();
  const nav = useNavigate();
  const qc = useQueryClient();
  const join = useMutation({
    mutationFn: (id: string) => api.post<TeamChannel>(`/team/channels/${id}/join`),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: teamKeys.channels });
      void qc.invalidateQueries({ queryKey: teamKeys.browse });
      onClose();
      nav(`/team/${c.id}`);
    },
  });
  return (
    <Dialog title="Browse channels" description="Public channels you have not joined yet." onClose={onClose}>
      {browse.isPending && <Skeleton className="h-24" />}
      {browse.isError && <ErrorNotice error={browse.error} onRetry={() => void browse.refetch()} />}
      {browse.data?.length === 0 && <EmptyState icon={Hash} title="You are in every channel" hint="Ask a manager to create a new one." className="py-8" />}
      <ul className="flex flex-col divide-y divide-border">
        {browse.data?.map((c) => (
          <li key={c.id} className="flex items-center gap-3 py-2.5">
            <Hash className="size-4 shrink-0 text-subtle" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-sm">{c.name}</strong>
              <span className="block truncate text-xs text-muted-foreground">{c.topic || `${c.member_count} member${c.member_count === 1 ? "" : "s"}`}</span>
            </div>
            <Button size="sm" variant="outline" aria-label={`Join ${c.name}`} loading={join.isPending && join.variables === c.id} onClick={() => join.mutate(c.id)}>
              Join
            </Button>
          </li>
        ))}
      </ul>
      {join.isError && <div className="mt-3"><ErrorNotice error={join.error} compact /></div>}
    </Dialog>
  );
}

export function TeamSearchDialog({ onClose, channelId }: { onClose: () => void; channelId?: string }) {
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const res = useTeamSearch(q.trim(), channelId);
  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader title={channelId ? "Search this channel" : "Search team chat"} />
        <DialogBody>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
            <Input type="search" aria-label="Search messages" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages (at least 2 letters)" data-autofocus />
          </div>
          <div className="mt-3" aria-live="polite">
            {res.isFetching && q.trim().length >= 2 && <Skeleton className="h-16" />}
            {res.isError && <ErrorNotice error={res.error} compact />}
            {res.data?.length === 0 && !res.isFetching && <p className="py-6 text-center text-sm text-subtle">No messages match “{q.trim()}”.</p>}
            <ul className="flex flex-col divide-y divide-border">
              {res.data?.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 px-1 py-2.5 text-left hover:bg-surface-2"
                    onClick={() => {
                      onClose();
                      nav(`/team/${h.channel_id}${h.thread_root_id ? `?thread=${h.thread_root_id}` : ""}`);
                    }}
                  >
                    <Avatar name={h.sender.name} seed={h.sender.id} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                        <strong className="text-foreground">{h.sender.name}</strong> in {h.channel.kind === "channel" ? `#${h.channel.title}` : `a message with ${h.channel.title}`} · {new Date(h.created_at).toLocaleDateString()}
                      </span>
                      <span className="line-clamp-2 text-sm">{h.content_text}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}

/** From a customer conversation: post a link card into a channel or direct message, with an optional note. */
export function ShareToTeamDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const channels = useTeamChannels();
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const canChat = useCan("team_chat:use");
  const send = useMutation({
    mutationFn: () => api.post(`/team/channels/${target}/messages`, { content: note.trim() || undefined, share_room_id: roomId, client_msg_id: crypto.randomUUID() }),
    onSuccess: () => {
      toast({ title: "Shared with your team", tone: "success" });
      onClose();
    },
  });
  const usable = (channels.data ?? []).filter((c) => !c.archived);
  return (
    <Dialog title="Share with the team" description="Posts a link to this conversation. Only teammates who can open the conversation see its details." onClose={onClose}>
      {!canChat && <ErrorNotice error={new Error("Your role cannot use team chat.")} />}
      {channels.isPending && <Skeleton className="h-20" />}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (target) send.mutate();
        }}
      >
        <Field label="Where">
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-sm" required>
            <option value="">Choose a channel or person</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === "channel" ? `#${c.name}` : c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Can someone take this one?" />
        </Field>
        {send.isError && <ErrorNotice error={send.error} compact />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={send.isPending} disabled={!target || !canChat}>
            Share
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
