import { useState } from "react";
import type { Message } from "../../api/types";
import { formatClock } from "../../lib/time";
import { Icon } from "../ui/Icon";
import { Attachments } from "./Attachments";
import { DeliveryStatus } from "./DeliveryStatus";
import { RichText } from "./RichText";

export interface BubbleProps {
  message: Message;
  selfMemberId: string;
  contactName?: string;
  first: boolean;
  last: boolean;
  editWindowOpen?: boolean;
  onReply?: (m: Message) => void;
  onRetry?: (m: Message) => void;
  onEdit?: (m: Message, content: string) => Promise<void> | void;
  onDelete?: (m: Message) => void;
}

const CHANNEL_LABEL = { dm: "Chat", sms: "SMS", email: "Email" } as const;

export function MessageBubble({ message: m, selfMemberId, contactName, first, last, editWindowOpen = true, onReply, onRetry, onEdit, onDelete }: BubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (m.kind === "system") {
    return (
      <div className="sys-line" role="note" data-subtype={String(m.meta.sub_type ?? "")}>
        <span>{m.content_text || m.content}</span>
        <time dateTime={m.created_at}>{formatClock(m.created_at)}</time>
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

  const submitEdit = async () => {
    const next = draft.trim();
    if (next && next !== text) await onEdit?.(m, next);
    setEditing(false);
  };

  return (
    <div className={`msg ${outgoing ? "out" : "in"}${isNote ? " is-note" : ""}${first ? " first" : ""}${last ? " last" : ""}`} data-message-id={m.id}>
      <div className={`bubble${isNote ? " note" : ""}${failed ? " failed" : ""}`}>
        {first && (
          <div className="bubble-meta">
            {isNote && (
              <span className="note-label">
                <Icon name="lock" size={12} /> Internal note
              </span>
            )}
            <span className="sender">{outgoing ? m.sender.name || "Team" : contactName || m.sender.name || "Contact"}</span>
            {!isNote && m.source !== "dm" && <span className="tag">{CHANNEL_LABEL[m.source]}</span>}
            {m.sender.type === "bot" && <span className="tag">Bot</span>}
          </div>
        )}
        {m.subject && m.source === "email" && <div className="subject">{m.subject}</div>}
        {m.ref && (
          <blockquote className="quote">
            <strong>{m.ref.sender_name}</strong>
            <span>{m.ref.deleted ? "Message deleted" : m.ref.snippet || `[${m.ref.kind}]`}</span>
          </blockquote>
        )}
        {editing ? (
          <div className="edit-box">
            <textarea aria-label="Edit message" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} data-autofocus />
            <div className="row">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitEdit()}>
                Save
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          text && (
            <p className="body">
              <RichText text={text} />
            </p>
          )
        )}
        <Attachments items={m.attachments} />
        <div className="bubble-foot">
          <time dateTime={m.created_at}>{formatClock(m.created_at)}</time>
          {m.edited_at && <span>edited</span>}
          {outgoing && !isNote && <DeliveryStatus message={m} />}
        </div>
        {failed && (
          <div className="failure" role="alert">
            <span>Failed to send: {reason}</span>
            {onRetry && (
              <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => onRetry(m)}>
                <Icon name="refresh" size={13} /> Retry
              </button>
            )}
          </div>
        )}
      </div>
      {!m.local && !editing && (
        <div className="bubble-actions" role="group" aria-label="Message actions">
          {onReply && (
            <button type="button" className="icon-btn sm" aria-label="Reply to this message" onClick={() => onReply(m)}>
              <Icon name="reply" size={14} />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label="Edit message"
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
            >
              <Icon name="edit" size={14} />
            </button>
          )}
          {mine && onDelete && (
            <button type="button" className="icon-btn sm" aria-label="Delete message" onClick={() => onDelete(m)}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
