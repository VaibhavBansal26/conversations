import { Paperclip, SendHorizontal } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import { api } from "../api/client";
import { useMembers } from "../api/hooks";
import type { Attachment, Member } from "../api/types";
import { AttachmentChips } from "../components/composer/AttachmentChips";
import { EmojiPicker } from "../components/composer/EmojiPicker";
import { SuggestList, type SuggestItem } from "../components/composer/SuggestList";
import { activeMention, insertMention } from "../lib/mentions";
import { useSocket } from "../realtime/SocketProvider";
import { Button, cn, ErrorNotice, Tooltip } from "../ui";
import { useSession } from "../auth/AuthContext";

const drafts = new Map<string, string>();
const TYPING_THROTTLE_MS = 2500;

interface Props {
  /** drafts are kept per key (channel, or channel + thread) while you move around */
  draftKey: string;
  channelId: string;
  threadRootId?: string | null;
  placeholder: string;
  onSend: (a: { content: string; attachmentIds: string[] }) => void;
  /** ArrowUp in an empty box edits your last message */
  onEditLast?: () => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  disabledReason?: string;
  compact?: boolean;
}

/** Message box for team chat: @mentions (and @channel), emoji, attachments by button, paste or drop, a draft per channel, typing pings. */
export function TeamComposer({ draftKey, channelId, threadRootId, placeholder, onSend, onEditLast, textareaRef, disabled, disabledReason, compact }: Props) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  const { member } = useSession();
  const socket = useSocket();
  const members = useMembers();
  const listId = useId();
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [caret, setCaret] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [notice, setNotice] = useState<unknown>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    setText(drafts.get(draftKey) ?? "");
    setAttachments([]);
    setNotice(null);
  }, [draftKey]);

  const update = (v: string, c = v.length) => {
    setText(v);
    setCaret(c);
    setActive(0);
    setDismissed(false);
    if (v) drafts.set(draftKey, v);
    else drafts.delete(draftKey);
    const now = Date.now();
    if (v && socket.connected && now - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = now;
      void socket.emit("team:typing", { channel_id: channelId, typing: true, thread_root_id: threadRootId ?? undefined }).catch(() => undefined);
    }
  };

  const mention = activeMention(text, caret);
  const items = useMemo<SuggestItem[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const people = (members.data ?? [])
      .filter((m: Member) => m.id !== member.id && (m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)))
      .slice(0, 6)
      .map((m) => ({ id: m.id, label: m.name, hint: m.email }));
    return "channel".startsWith(q) && q.length < 8 ? [{ id: "@channel", label: "@channel", hint: "notify everyone here" }, ...people].slice(0, 7) : people;
  }, [mention, members.data, member.id]);
  const open = !dismissed && !!mention;

  const pick = (item: SuggestItem) => {
    if (item.id === "@channel") {
      const start = mention ? mention.start : caret;
      const next = `${text.slice(0, start)}@channel ${text.slice(caret)}`;
      pendingCaret.current = start + 9;
      update(next, start + 9);
      return;
    }
    const next = insertMention(text, caret, { id: item.id, name: String(item.label) });
    pendingCaret.current = next.caret;
    update(next.text, next.caret);
  };

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    ref.current?.setSelectionRange(at, at);
  }, [text, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text, ref]);

  const upload = async (files: File[]) => {
    setNotice(null);
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const att = await api.upload<Attachment>("/team/attachments", file);
        setAttachments((cur) => [...cur, att]);
      } catch (e) {
        setNotice(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const canSend = !disabled && uploading === 0 && (text.trim().length > 0 || attachments.length > 0);
  const submit = () => {
    if (!canSend) return;
    onSend({ content: text.trim(), attachmentIds: attachments.map((a) => a.id) });
    drafts.delete(draftKey);
    setText("");
    setAttachments([]);
    setNotice(null);
    if (socket.connected) void socket.emit("team:typing", { channel_id: channelId, typing: false, thread_root_id: threadRootId ?? undefined }).catch(() => undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = Math.max(items.length, 1);
        setActive((i) => (e.key === "ArrowDown" ? i + 1 : i - 1 + n) % n);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && items[active]) {
        e.preventDefault();
        pick(items[active]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "ArrowUp" && !text && onEditLast) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const insertAtCaret = (s: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? text.length;
    update(text.slice(0, at) + s + text.slice(el?.selectionEnd ?? at), at + s.length);
    el?.focus();
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void upload(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void upload(files);
  };
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <form
      aria-label={threadRootId ? "Reply in thread" : "Message"}
      className={cn("@container shrink-0 bg-surface px-3 pb-3 pt-2 md:px-4", !compact && "border-t border-border")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setDragging(false)}
      onDrop={onDrop}
    >
      {disabled && disabledReason ? (
        <p className="rounded-lg bg-surface-2 px-3 py-3 text-center text-[13px] text-muted-foreground" role="status">
          {disabledReason}
        </p>
      ) : (
        <div className={cn("relative rounded-xl border bg-surface shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20", dragging ? "border-primary ring-2 ring-primary/30" : "border-border-strong")}>
          {dragging && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl bg-primary-soft/90 text-sm font-medium text-primary-text">Drop files to attach</div>}
          {open && <SuggestList id={listId} label="Mention a teammate" items={items} active={active} onPick={pick} />}
          <textarea
            ref={ref}
            aria-label={placeholder}
            placeholder={placeholder}
            rows={1}
            value={text}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && items.length ? `${listId}-${active}` : undefined}
            onChange={(e) => update(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-52 min-h-11 w-full resize-none bg-transparent px-3.5 py-2.5 text-[14px] leading-relaxed placeholder:text-subtle focus:outline-none"
          />
          <AttachmentChips items={attachments} uploading={uploading} onRemove={(id) => setAttachments((a) => a.filter((x) => x.id !== id))} />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Attach files" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void upload(f); }} />
            <Tooltip content="Attach files">
              <button type="button" aria-label="Attach files" onClick={() => fileInput.current?.click()} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground">
                <Paperclip className="size-4" aria-hidden="true" />
              </button>
            </Tooltip>
            <EmojiPicker onPick={insertAtCaret} />
            <button type="button" aria-label="Mention someone" onClick={() => insertAtCaret(text && !/\s$/.test(text) ? " @" : "@")} className="grid size-8 place-items-center rounded-md text-sm font-semibold text-muted-foreground hover:bg-surface-2 hover:text-foreground">
              @
            </button>
            {compact ? null : <span className="ml-auto hidden text-xs text-subtle @xl:inline">Enter to send, Shift+Enter for a new line</span>}
            <Button type="submit" size="sm" className={cn("ml-auto @xl:ml-2", compact && "@xl:ml-auto")} disabled={!canSend} aria-label="Send message">
              <SendHorizontal aria-hidden="true" /> <span className="hidden sm:inline">Send</span>
            </Button>
          </div>
        </div>
      )}
      {notice !== null && <div className="mt-2"><ErrorNotice error={notice} compact /></div>}
    </form>
  );
}
