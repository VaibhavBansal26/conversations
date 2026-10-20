import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { api } from "../../api/client";
import type { Attachment, Channel, Member, Message, Room, Template } from "../../api/types";
import { useEmailSenders, useMembers, useTemplates } from "../../api/hooks";
import { useSession } from "../../auth/AuthContext";
import { checkComposer, defaultEmailSubject, messageKindFor, SMS_LIMIT, verifiedSenders } from "../../lib/composerRules";
import { activeMention, insertMention } from "../../lib/mentions";
import { useSocket } from "../../realtime/SocketProvider";
import { useSendMessage } from "../../state/useSendMessage";
import { ErrorNotice } from "../../ui";
import { Icon } from "../../ui";
import { AttachmentChips } from "./AttachmentChips";
import { ChannelBar } from "./ChannelBar";
import { EmojiPicker } from "./EmojiPicker";
import { RephraseMenu } from "./RephraseMenu";
import { SuggestionStrip } from "./SuggestionStrip";
import { SuggestList, type SuggestItem } from "./SuggestList";
import { VoiceRecorder } from "./VoiceRecorder";

interface Props {
  room: Room;
  messages: Message[];
  replyTo: Message | null;
  onClearReply: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

const drafts = new Map<string, string>();
const TYPING_THROTTLE_MS = 2500;

function initialChannel(messages: Message[]): Channel {
  const last = [...messages].reverse().find((m) => m.kind !== "system" && m.kind !== "note");
  return last?.source ?? "dm";
}

export function Composer({ room, messages, replyTo, onClearReply, textareaRef }: Props) {
  const { member } = useSession();
  const socket = useSocket();
  const members = useMembers();
  const templates = useTemplates();
  const senders = useEmailSenders();
  const { send } = useSendMessage(room.id);
  const listId = useId();

  const [text, setText] = useState(() => drafts.get(room.id) ?? "");
  const [channel, setChannel] = useState<Channel>(() => initialChannel(messages));
  const [isNote, setNote] = useState(false);
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [notice, setNotice] = useState<unknown>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const subjectSeeded = useRef(false);

  const contact = room.contact;
  const senderList = senders.data ?? [];

  useEffect(() => {
    if (from || !senderList.length) return;
    const ok = verifiedSenders(senderList);
    setFrom((ok.find((s) => s.is_default) ?? ok[0])?.address ?? "");
  }, [senderList, from]);

  useEffect(() => {
    if (channel !== "email" || subjectSeeded.current) return;
    subjectSeeded.current = true;
    const lastEmail = [...messages].reverse().find((m) => m.source === "email" && m.subject)?.subject ?? null;
    setSubject(defaultEmailSubject({ roomSubject: room.subject, lastEmailSubject: lastEmail, contactName: contact?.name ?? "" }));
  }, [channel, messages, room.subject, contact?.name]);

  const update = (next: string, nextCaret = next.length) => {
    setText(next);
    setCaret(nextCaret);
    setActive(0);
    setDismissed(false);
    drafts.set(room.id, next);
    const now = Date.now();
    if (socket.connected && next && now - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = now;
      void socket.emit("typing", { room_id: room.id, typing: true, internal: isNote }).catch(() => undefined);
    }
  };

  const check = useMemo(
    () => checkComposer({ channel, isNote, text, subject, from, attachmentCount: attachments.length, contact, senders: senderList }),
    [channel, isNote, text, subject, from, attachments.length, contact, senderList],
  );

  const slash = !isNote && text.startsWith("/") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
  const mention = isNote ? activeMention(text, caret) : null;

  const templateItems = useMemo<SuggestItem[]>(() => {
    if (slash === null) return [];
    return (templates.data ?? [])
      .filter((t) => (t.channel === "any" || t.channel === check.channel) && (t.name.toLowerCase().includes(slash) || (t.shortcut ?? "").toLowerCase().includes(slash)))
      .slice(0, 8)
      .map((t) => ({ id: t.id, label: t.name, hint: t.shortcut ? `/${t.shortcut}` : t.channel }));
  }, [slash, templates.data, check.channel]);

  const mentionItems = useMemo<SuggestItem[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return (members.data ?? [])
      .filter((m: Member) => m.id !== member.id && (m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)))
      .slice(0, 6)
      .map((m) => ({ id: m.id, label: m.name, hint: m.email }));
  }, [mention, members.data, member.id]);

  const suggestOpen = !dismissed && (slash !== null || !!mention);
  const items = slash !== null ? templateItems : mentionItems;

  const render = useMutation({
    mutationFn: (t: Template) => api.post<{ subject: string | null; body: string }>(`/templates/${t.id}/render`, { room_id: room.id }),
    onSuccess: (r) => {
      update(r.body);
      if (r.subject && channel === "email") setSubject(r.subject);
      textareaRef.current?.focus();
    },
    onError: setNotice,
  });

  const pick = (item: SuggestItem) => {
    if (slash !== null) {
      const t = templates.data?.find((x) => x.id === item.id);
      if (t) render.mutate(t);
      return;
    }
    const next = insertMention(text, caret, { id: item.id, name: String(item.label) });
    update(next.text, next.caret);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.caret, next.caret));
  };

  const upload = async (files: File[]) => {
    setNotice(null);
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const att = await api.upload<Attachment>("/attachments", file);
        setAttachments((cur) => [...cur, att]);
      } catch (e) {
        setNotice(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const submit = () => {
    if (!check.canSend) return;
    const email = check.channel === "email";
    void send({
      kind: messageKindFor({ isNote, hasRef: !!replyTo, attachmentTypes: attachments.map((a) => a.content_type) }),
      source: check.channel,
      content: text.trim(),
      subject: email ? subject.trim() : undefined,
      from: email ? from : undefined,
      ref_message_id: replyTo?.id,
      attachment_ids: attachments.length ? attachments.map((a) => a.id) : undefined,
    });
    drafts.delete(room.id);
    setText("");
    setAttachments([]);
    setNotice(null);
    onClearReply();
    if (socket.connected) void socket.emit("typing", { room_id: room.id, typing: false, internal: isNote }).catch(() => undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestOpen) {
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const insertAtCaret = (s: string) => {
    const el = textareaRef.current;
    const at = el?.selectionStart ?? text.length;
    update(text.slice(0, at) + s + text.slice(el?.selectionEnd ?? at), at + s.length);
    el?.focus();
  };

  const lastConfirmed = [...messages].reverse().find((m) => !m.local && m.kind !== "system");
  const suggestFor = lastConfirmed && lastConfirmed.sender.type === "contact" && !isNote && !text ? lastConfirmed.id : null;
  const problemsId = `${listId}-problems`;

  return (
    <form
      className={`composer${isNote ? " is-note" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {replyTo && (
        <div className="reply-bar">
          <Icon name="reply" size={14} />
          <span>
            Replying to <strong>{replyTo.sender.name || "message"}</strong>: {replyTo.content_text.slice(0, 90) || `[${replyTo.kind}]`}
          </span>
          <button type="button" className="icon-btn sm" aria-label="Cancel reply" onClick={onClearReply}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <SuggestionStrip roomId={room.id} triggerMessageId={suggestFor} onPick={(s) => update(s)} />
      <ChannelBar channel={channel} onChannel={setChannel} isNote={isNote} onNote={setNote} senders={senderList} from={from} onFrom={setFrom} subject={subject} onSubject={setSubject} />
      <div className="composer-input">
        {suggestOpen && <SuggestList id={listId} label={slash !== null ? "Templates" : "Mention a teammate"} items={items} active={active} onPick={pick} />}
        <textarea
          ref={textareaRef}
          aria-label={isNote ? "Write an internal note" : "Write a reply"}
          placeholder={isNote ? "Write a note for your team. Type @ to mention someone." : "Reply… Type / for templates"}
          rows={3}
          value={text}
          aria-describedby={check.problems.length ? problemsId : undefined}
          aria-controls={suggestOpen ? listId : undefined}
          aria-activedescendant={suggestOpen && items.length ? `${listId}-${active}` : undefined}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
      </div>
      <AttachmentChips items={attachments} uploading={uploading} onRemove={(id) => setAttachments((a) => a.filter((x) => x.id !== id))} />
      {notice !== null && <ErrorNotice error={notice} compact />}
      {check.problems.length > 0 && (text.trim() || attachments.length > 0 || channel !== "dm") && (
        <ul id={problemsId} className="problems" aria-live="polite">
          {check.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="composer-tools">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <button type="button" className="icon-btn" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
          <Icon name="paperclip" />
        </button>
        <EmojiPicker onPick={insertAtCaret} />
        <VoiceRecorder disabled={isNote} onRecorded={(f) => void upload([f])} onError={(m) => setNotice(new Error(m))} />
        <RephraseMenu text={text} roomId={room.id} onResult={(t) => update(t)} onError={setNotice} />
        <span className="grow" />
        {check.smsRemaining !== null && (
          <span className={`counter${check.smsRemaining < 0 ? " over" : ""}`} aria-live="polite">
            {text.length}/{SMS_LIMIT}
          </span>
        )}
        <button type="submit" className="btn btn-primary" disabled={!check.canSend}>
          <Icon name="send" size={16} /> {isNote ? "Add note" : "Send"}
        </button>
      </div>
    </form>
  );
}
