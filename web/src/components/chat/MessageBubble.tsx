// Adapted from the legacy UI (see docs/PROVENANCE.md): message card layout, hover action bar, quote block, inbound-form and voice-note cards.
import { Copy, Lock, Pencil, RefreshCw, Reply, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useCalls } from "../../calls/CallProvider";
import type { Message } from "../../api/types";
import { formatClock } from "../../lib/time";
import { Avatar, Button, cn, Textarea, Tooltip, toast } from "../../ui";
import { SettingsLink } from "../channels/SettingsLink";
import { Attachments } from "./Attachments";
import { DeliveryStatus } from "./DeliveryStatus";
import { COLLAPSE_FROM, EmailBody } from "./EmailBody";
import { PaymentCard, asPaymentCard } from "./PaymentCard";
import { RichText } from "./RichText";

export interface BubbleProps {
  message: Message;
  selfMemberId: string;
  contactName?: string;
  contactSeed?: string;
  first: boolean;
  last: boolean;
  editWindowOpen?: boolean;
  onReply?: (m: Message) => void;
  onRetry?: (m: Message) => void;
  onEdit?: (m: Message, content: string) => Promise<void> | void;
  onDelete?: (m: Message) => void;
}

const CHANNEL_LABEL = { dm: "Chat", sms: "SMS", email: "Email" } as const;

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} onClick={onClick} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-3 hover:text-foreground">
        {children}
      </button>
    </Tooltip>
  );
}

/** The team marks an AI agent's answer helpful or not; the ratings feed the review page under Settings, AI agents. */
function AnswerRating({ message }: { message: Message }) {
  const [vote, setVote] = useState<1 | -1 | null>(null);
  const [failed, setFailed] = useState(false);
  const rate = (rating: 1 | -1) => {
    setVote(rating);
    setFailed(false);
    api.post(`/messages/${message.id}/feedback?room_id=${encodeURIComponent(message.room_id)}`, { rating }).catch(() => (setVote(null), setFailed(true)));
  };
  return (
    <div className="mt-1 flex items-center gap-1 px-1 text-xs text-subtle" role="group" aria-label="Rate this AI answer">
      <span>Was this answer right?</span>
      <button type="button" aria-label="Helpful answer" aria-pressed={vote === 1} onClick={() => rate(1)} className={cn("grid size-6 place-items-center rounded-md hover:bg-surface-3", vote === 1 && "bg-success-soft text-success-text")}>
        <ThumbsUp className="size-3.5" aria-hidden="true" />
      </button>
      <button type="button" aria-label="Not helpful answer" aria-pressed={vote === -1} onClick={() => rate(-1)} className={cn("grid size-6 place-items-center rounded-md hover:bg-surface-3", vote === -1 && "bg-danger-soft text-danger-text")}>
        <ThumbsDown className="size-3.5" aria-hidden="true" />
      </button>
      {failed && <span role="alert" className="text-danger-text">Could not save</span>}
    </div>
  );
}

export function MessageBubble({ message: m, selfMemberId, contactName, contactSeed, first, last, editWindowOpen = true, onReply, onRetry, onEdit, onDelete }: BubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // touch screens have no hover: tapping a message reveals its actions instead
  const [tapped, setTapped] = useState(false);
  const calls = useCalls();

  if (m.kind === "system") {
    const callKind = m.meta.sub_type === "call_request" ? (m.meta.kind === "video" ? "video" : "voice") : null;
    return (
      <div className="my-2 flex justify-center" role="note" data-subtype={String(m.meta.sub_type ?? "")} data-message-id={m.id}>
        <span className="flex max-w-[90%] items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-xs text-muted-foreground">
          <span>{m.content_text || m.content}</span>
          {callKind && calls?.available && calls.view.phase === "idle" && (
            <button type="button" className="rounded-full bg-primary px-2 py-0.5 font-medium text-primary-foreground hover:brightness-110" onClick={() => void calls.start(m.room_id, callKind)}>
              Call now
            </button>
          )}
          <time dateTime={m.created_at} className="text-subtle">
            {formatClock(m.created_at)}
          </time>
        </span>
      </div>
    );
  }

  const outgoing = m.sender.type === "agent" || m.sender.type === "bot";
  const isNote = m.kind === "note";
  const mine = m.sender.type === "agent" && m.sender.id === selfMemberId;
  const failed = m.delivery === "failed" || m.local?.status === "failed";
  const reason = m.local?.error ?? m.failure_reason ?? "Unknown error";
  const canEdit = mine && !m.local && m.kind === "text" && editWindowOpen && !!onEdit;
  const text = m.content_text || m.content;
  const payCard = asPaymentCard(m.meta);
  const senderName = outgoing ? m.sender.name || "Team" : contactName || m.sender.name || "Contact";
  const onBrand = outgoing && !isNote;

  const submitEdit = async () => {
    const next = draft.trim();
    if (next && next !== text) await onEdit?.(m, next);
    setEditing(false);
  };

  return (
    <div
      className={cn("group relative flex gap-2 data-[found=true]:animate-flash", outgoing ? "flex-row-reverse" : "flex-row", first ? "mt-3" : "mt-0.5")}
      data-message-id={m.id}
      data-kind={m.kind}
      data-direction={outgoing ? "out" : "in"}
    >
      {!outgoing && <div className="w-7 shrink-0 self-end">{last && <Avatar name={senderName} seed={contactSeed} size="sm" />}</div>}
      <div className={cn("flex min-w-0 max-w-[85%] flex-col sm:max-w-[min(34rem,78%)]", outgoing ? "items-end" : "items-start")}>
        {first && (
          <div className={cn("mb-1 flex items-center gap-1.5 px-1 text-xs text-subtle", outgoing && "flex-row-reverse")}>
            <span className="font-medium text-muted-foreground">{senderName}</span>
            {!isNote && m.source !== "dm" && <span className="rounded bg-surface-3 px-1.5 text-[10px] font-semibold uppercase tracking-wide">{CHANNEL_LABEL[m.source]}</span>}
            {m.sender.type === "bot" && <span className="rounded bg-primary-soft px-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary-text">{m.meta.ai ? "AI" : "Bot"}</span>}
          </div>
        )}
        <div
          data-bubble={isNote ? "note" : outgoing ? "out" : "in"}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a,button,audio,img,textarea")) return;
            setTapped((t) => !t);
          }}
          className={cn(
            "relative max-w-full rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed shadow-xs",
            isNote
              ? "border border-dashed border-warning-border bg-warning-soft text-foreground"
              : outgoing
                ? "bg-bubble-out text-primary-foreground"
                : "border border-border bg-bubble-in text-foreground",
            outgoing ? (first ? "" : "rounded-tr-md") : first ? "" : "rounded-tl-md",
            outgoing ? (last ? "" : "rounded-br-md") : last ? "rounded-bl-md" : "rounded-bl-md",
            failed && "border border-danger ring-1 ring-danger/40",
          )}
        >
          {isNote && (
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-warning-text">
              <Lock className="size-3" aria-hidden="true" /> Internal note
            </div>
          )}
          {m.subject && m.source === "email" && <div className={cn("mb-1 border-b pb-1 text-[13px] font-semibold", onBrand ? "border-white/25" : "border-border")}>{m.subject}</div>}
          {m.ref && (
            <blockquote className={cn("mb-1.5 flex flex-col rounded-md border-l-[3px] px-2.5 py-1 text-[13px]", onBrand ? "border-white/60 bg-black/15" : "border-primary bg-surface-2")}>
              <strong className="text-xs">{m.ref.sender_name}</strong>
              <span className="line-clamp-2 opacity-85">{m.ref.deleted ? "Message deleted" : m.ref.snippet || `[${m.ref.kind}]`}</span>
            </blockquote>
          )}
          {editing ? (
            <div className="flex min-w-60 flex-col gap-2 text-foreground">
              <Textarea aria-label="Edit message" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} data-autofocus autoFocus />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void submitEdit()}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : payCard ? (
            <PaymentCard card={payCard} />
          ) : (
            text && <p className="whitespace-pre-wrap">{m.source === "email" && m.sender.type === "contact" && text.length >= COLLAPSE_FROM ? <EmailBody text={text} /> : <RichText text={text} />}</p>
          )}
          <Attachments items={m.attachments} tone={onBrand ? "out" : "in"} />
          <div className={cn("mt-1 flex items-center justify-end gap-1.5 text-[11px] leading-none", onBrand ? "text-white/80" : "text-subtle")}>
            {m.edited_at && <span>edited</span>}
            <time dateTime={m.created_at}>{formatClock(m.created_at)}</time>
            {outgoing && !isNote && <DeliveryStatus message={m} />}
          </div>
        </div>
        {m.sender.type === "bot" && m.meta.ai === true && m.kind === "text" && !m.local && last && <AnswerRating message={m} />}
        {m.delivery === "not_sent_test_mode" && !m.local && (
          <p className="mt-1 max-w-full text-xs text-warning-text" data-testid="test-mode-note">
            Test mode: not sent. {m.source === "email" ? "Email" : "SMS"} is not connected, so this message was only saved.{" "}
            <SettingsLink to="/settings/channels" className="font-medium underline underline-offset-2">
              Connect {m.source === "email" ? "SendGrid" : "Twilio"}
            </SettingsLink>
            {onRetry && (
              <>
                {" "}
                or{" "}
                <button type="button" className="font-medium underline underline-offset-2" onClick={() => onRetry(m)}>
                  send it now
                </button>{" "}
                once connected.
              </>
            )}
          </p>
        )}
        {failed && (
          <div className="mt-1 flex items-center gap-2 text-xs text-danger-text" role="alert">
            <span>Failed to send: {reason}</span>
            {onRetry && (
              <Button size="sm" variant="danger-ghost" className="h-6 px-2 text-xs" onClick={() => onRetry(m)}>
                <RefreshCw className="size-3" aria-hidden="true" /> Retry
              </Button>
            )}
          </div>
        )}
      </div>
      {!m.local && !editing && (
        <div
          data-open={tapped}
          className="mb-1 flex shrink-0 items-center self-center rounded-lg border border-border bg-surface p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100 data-[open=true]:opacity-100 pointer-coarse:data-[open=false]:hidden"
          role="group"
          aria-label="Message actions"
        >
          {onReply && (
            <ActionButton label="Reply to this message" onClick={() => onReply(m)}>
              <Reply className="size-3.5" aria-hidden="true" />
            </ActionButton>
          )}
          {text && (
            <ActionButton
              label="Copy text"
              onClick={() => {
                void navigator.clipboard?.writeText(text).then(() => toast({ title: "Copied to clipboard", tone: "success" }));
              }}
            >
              <Copy className="size-3.5" aria-hidden="true" />
            </ActionButton>
          )}
          {canEdit && (
            <ActionButton
              label="Edit message"
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </ActionButton>
          )}
          {mine && onDelete && (
            <ActionButton label="Delete message" onClick={() => onDelete(m)}>
              <Trash2 className="size-3.5" aria-hidden="true" />
            </ActionButton>
          )}
        </div>
      )}
    </div>
  );
}
