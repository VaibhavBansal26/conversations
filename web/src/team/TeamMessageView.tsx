import { Copy, ExternalLink, FileText, Lock, MessageSquareReply, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, SmilePlus, Trash2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { RichText } from "../components/chat/RichText";
import { formatClock } from "../lib/time";
import { Avatar, Button, cn, Menu, Textarea, toast, Tooltip } from "../ui";
import { SettingsLink } from "../components/channels/SettingsLink";
import type { TeamMessage } from "./types";

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];

export interface TeamMessageHandlers {
  onReact?: (m: TeamMessage, emoji: string) => void;
  onReply?: (m: TeamMessage) => void;
  onEdit?: (m: TeamMessage, content: string) => Promise<void> | void;
  onDelete?: (m: TeamMessage) => void;
  onPin?: (m: TeamMessage, pinned: boolean) => void;
  onRetry?: (m: TeamMessage) => void;
  onOpenThread?: (m: TeamMessage) => void;
}

interface Props extends TeamMessageHandlers {
  message: TeamMessage;
  selfId: string;
  first: boolean;
  online?: boolean;
  /** inside the thread panel: no "N replies" link and no reply action */
  inThread?: boolean;
  canModerate?: boolean;
  readOnly?: boolean;
  highlight?: boolean;
  /** set to this message's id (ArrowUp in an empty composer) to open its editor */
  editRequestId?: string | null;
  onEditStarted?: () => void;
}

function ShareCard({ share, mine }: { share: NonNullable<TeamMessage["share"]>; mine: boolean }) {
  if (!share.available) {
    return (
      <div className={cn("mt-1 flex max-w-sm items-center gap-2.5 rounded-lg border border-dashed border-border bg-surface-2/60 px-3 py-2 text-[13px] text-muted-foreground", mine && "ml-0")} data-testid="share-card" data-available="false">
        <Lock className="size-4 shrink-0" aria-hidden="true" />
        <span>A customer conversation was shared. You do not have access to it.</span>
      </div>
    );
  }
  return (
    <SettingsLink to={`/inbox/${share.room_id}`} className="mt-1 flex max-w-sm items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left shadow-xs transition-colors hover:bg-surface-2" >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-text" aria-hidden="true">
        <ExternalLink className="size-4" />
      </span>
      <span className="min-w-0" data-testid="share-card" data-available="true">
        <span className="block truncate text-sm font-semibold">{share.title ?? "Conversation"}</span>
        <span className="block text-xs text-muted-foreground">Customer conversation · {share.status === "closed" ? "closed" : "open"} · open in the inbox</span>
      </span>
    </SettingsLink>
  );
}

function Attachments({ items }: { items: TeamMessage["attachments"] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-2">
      {items.map((a) =>
        a.content_type.startsWith("image/") ? (
          <li key={a.id}>
            <a href={a.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.file_name}`}>
              <img src={a.url} alt={a.file_name} loading="lazy" className="max-h-60 max-w-full rounded-lg border border-border object-cover" />
            </a>
          </li>
        ) : (
          <li key={a.id}>
            <a href={a.url} target="_blank" rel="noopener noreferrer" className="flex max-w-xs items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-2">
              <FileText className="size-4 shrink-0 text-subtle" aria-hidden="true" />
              <span className="min-w-0 truncate">{a.file_name}</span>
              <span className="shrink-0 text-xs text-subtle">{Math.max(1, Math.round(a.size / 1024))} KB</span>
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} onClick={onClick} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-3 hover:text-foreground">
        {children}
      </button>
    </Tooltip>
  );
}

function TeamMessageViewImpl({ message: m, selfId, first, online, inThread, canModerate, readOnly, highlight, editRequestId, onEditStarted, onReact, onReply, onEdit, onDelete, onPin, onRetry, onOpenThread }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // touch screens have no hover: tapping a message reveals its actions instead
  const [tapped, setTapped] = useState(false);
  const mine = m.sender.id === selfId;
  const failed = m.local?.status === "failed";
  const sending = m.local?.status === "sending";
  const canEdit = mine && !m.local && !readOnly && m.kind !== "share";
  const canDelete = (mine || canModerate) && !m.local && !readOnly;

  useEffect(() => {
    if (editRequestId === m.id && !editing && !m.local) {
      setDraft(m.content);
      setEditing(true);
      onEditStarted?.();
    }
  }, [editRequestId, m.id, m.content, m.local, editing, onEditStarted]);

  const submitEdit = async () => {
    const next = draft.trim();
    if (next && next !== m.content) await onEdit?.(m, next);
    setEditing(false);
  };

  return (
    <div
      className={cn("group relative flex gap-3 rounded-md px-2 py-0.5 hover:bg-surface-2/60 focus-within:bg-surface-2/60", first ? "mt-3 pt-1" : "", highlight && "bg-warning-soft/60", sending && "opacity-70")}
      data-message-id={m.id}
      data-testid="team-message"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,textarea,img,[role=menu]")) return;
        setTapped((t) => !t);
      }}
    >
      <div className="w-9 shrink-0 pt-0.5">{first && <Avatar name={m.sender.name} seed={m.sender.id} size="md" online={online} />}</div>
      <div className="min-w-0 flex-1">
        {first && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{m.sender.name}</span>
            <time dateTime={m.created_at} className="text-xs text-subtle">
              {formatClock(m.created_at)}
            </time>
            {m.pinned && (
              <span className="inline-flex items-center gap-1 text-xs text-warning-text">
                <Pin className="size-3" aria-hidden="true" /> Pinned
              </span>
            )}
          </div>
        )}
        {editing ? (
          <div className="flex flex-col gap-2 py-1">
            <Textarea
              aria-label="Edit message"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              data-autofocus
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitEdit();
                } else if (e.key === "Escape") setEditing(false);
              }}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void submitEdit()}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            {m.content && (
              <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
                <RichText text={m.content} />
                {m.edited_at && <span className="ml-1.5 text-xs text-subtle">(edited)</span>}
                {!first && (
                  <time dateTime={m.created_at} className="ml-2 hidden text-[11px] text-subtle group-hover:inline">
                    {formatClock(m.created_at)}
                  </time>
                )}
              </p>
            )}
            {m.share && <ShareCard share={m.share} mine={mine} />}
            <Attachments items={m.attachments} />
          </>
        )}
        {m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Reactions">
            {m.reactions.map((r) => {
              const reacted = r.member_ids.includes(selfId);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={reacted}
                  aria-label={`${r.emoji} ${r.count}${reacted ? ", you reacted" : ""}`}
                  onClick={() => onReact?.(m, r.emoji)}
                  className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs", reacted ? "border-primary bg-primary-soft text-primary-text" : "border-border bg-surface hover:bg-surface-2")}
                >
                  <span aria-hidden="true">{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}
        {!inThread && m.reply_count > 0 && (
          <button type="button" onClick={() => onOpenThread?.(m)} className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary-text hover:bg-primary-soft">
            <MessageSquareReply className="size-3.5" aria-hidden="true" />
            {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}
          </button>
        )}
        {failed && (
          <div className="mt-1 flex items-center gap-2 text-xs text-danger-text" role="alert">
            <span>Not sent: {m.local?.error ?? "unknown error"}</span>
            {onRetry && (
              <Button size="sm" variant="danger-ghost" className="h-6 px-2 text-xs" onClick={() => onRetry(m)}>
                <RefreshCw className="size-3" aria-hidden="true" /> Retry
              </Button>
            )}
          </div>
        )}
      </div>
      {!m.local && !editing && !readOnly && (
        <div
          data-open={tapped}
          className="absolute -top-3 right-2 flex items-center rounded-lg border border-border bg-surface p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100 data-[open=true]:opacity-100 pointer-coarse:data-[open=false]:hidden"
          role="group"
          aria-label="Message actions"
        >
          <Menu
            label="Add reaction"
            triggerClassName="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-3 hover:text-foreground"
            trigger={<SmilePlus className="size-3.5" aria-hidden="true" />}
            align="end"
            items={QUICK_REACTIONS.map((e) => ({ id: e, label: <span className="text-lg leading-none">{e}</span>, onSelect: () => onReact?.(m, e) }))}
          />
          {!inThread && onReply && (
            <ActionButton label="Reply in thread" onClick={() => onReply(m)}>
              <MessageSquareReply className="size-3.5" aria-hidden="true" />
            </ActionButton>
          )}
          {!m.thread_root_id && onPin && (
            <ActionButton label={m.pinned ? "Unpin message" : "Pin message"} onClick={() => onPin(m, !m.pinned)}>
              {m.pinned ? <PinOff className="size-3.5" aria-hidden="true" /> : <Pin className="size-3.5" aria-hidden="true" />}
            </ActionButton>
          )}
          <Menu
            label="More actions"
            triggerClassName="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-3 hover:text-foreground"
            trigger={<MoreHorizontal className="size-3.5" aria-hidden="true" />}
            align="end"
            items={[
              ...(m.content ? [{ id: "copy", label: (<span className="inline-flex items-center gap-2"><Copy className="size-4" aria-hidden="true" /> Copy text</span>), onSelect: () => void navigator.clipboard?.writeText(m.content_text || m.content).then(() => toast({ title: "Copied to clipboard", tone: "success" })) }] : []),
              ...(canEdit ? [{ id: "edit", label: (<span className="inline-flex items-center gap-2"><Pencil className="size-4" aria-hidden="true" /> Edit message</span>), onSelect: () => { setDraft(m.content); setEditing(true); } }] : []),
              ...(canDelete ? [{ id: "delete", danger: true, label: (<span className="inline-flex items-center gap-2"><Trash2 className="size-4" aria-hidden="true" /> Delete message</span>), onSelect: () => onDelete?.(m) }] : []),
            ]}
          />
        </div>
      )}
    </div>
  );
}

export const TeamMessageView = memo(TeamMessageViewImpl);
