import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { useEmailSenders, useInboxes } from "../../api/hooks";
import type { Channel, Contact, Pagination, Room } from "../../api/types";
import { checkComposer, defaultEmailSubject, messageKindFor, verifiedSenders } from "../../lib/composerRules";
import { newClientMsgId } from "../../lib/ids";
import { keys } from "../../state/keys";
import { Search } from "lucide-react";
import { Avatar, Button, Dialog, ErrorNotice, Field, Input, NativeSelect, SegmentedList, SegmentedTrigger, Tabs, Textarea, cn } from "../../ui";

type Mode = "existing" | "new";

export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inboxes = useInboxes().data ?? [];
  const senders = useEmailSenders().data ?? [];
  const [mode, setMode] = useState<Mode>("existing");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<Contact | null>(null);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "" });
  const [inboxId, setInboxId] = useState("");
  const [channel, setChannel] = useState<Channel>("dm");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");

  const results = useQuery({
    queryKey: ["contact-search", term],
    queryFn: () => api.get<{ data: Contact[]; pagination: Pagination }>("/contacts", { search: term, limit: 6 }),
    enabled: mode === "existing",
  });

  const contact = mode === "existing" ? picked : { email: draft.email.trim() || null, phone: draft.phone.trim() || null, sms_opt_out: false };
  const from = (verifiedSenders(senders).find((s) => s.is_default) ?? verifiedSenders(senders)[0])?.address ?? "";
  const subjectValue = subject || defaultEmailSubject({ roomSubject: null, lastEmailSubject: null, contactName: picked?.name ?? draft.name });
  const check = checkComposer({ channel, isNote: false, text, subject: subjectValue, from, attachmentCount: 0, contact, senders });
  const identified = mode === "existing" ? !!picked : !!(draft.name.trim() || draft.email.trim() || draft.phone.trim());
  const canSubmit = identified && (text.trim() === "" || check.canSend);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ room: Room }>("/rooms", {
        ...(mode === "existing" && picked
          ? { contact_id: picked.id }
          : { contact: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)) }),
        inbox_id: inboxId || null,
        subject: channel === "email" ? subjectValue : undefined,
        message: text.trim()
          ? {
              kind: messageKindFor({ isNote: false, hasRef: false, attachmentTypes: [] }),
              source: channel,
              content: text.trim(),
              subject: channel === "email" ? subjectValue : undefined,
              from: channel === "email" ? from : undefined,
              client_msg_id: newClientMsgId(),
            }
          : undefined,
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: keys.rooms });
      void qc.invalidateQueries({ queryKey: keys.counts });
      onClose();
      navigate(`/inbox/${res.room.id}`);
    },
  });

  return (
    <Dialog title="New conversation" onClose={onClose} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <Tabs value={mode} onValueChange={(m) => setMode(m as Mode)}>
          <SegmentedList aria-label="Contact" className="w-full">
            <SegmentedTrigger value="existing" className="flex-1 justify-center">
              Existing contact
            </SegmentedTrigger>
            <SegmentedTrigger value="new" className="flex-1 justify-center">
              New contact
            </SegmentedTrigger>
          </SegmentedList>
        </Tabs>

        {mode === "existing" ? (
          <div className="space-y-2">
            <Field label="Find a contact">
              <Input data-autofocus type="search" value={term} placeholder="Name, email or phone" onChange={(e) => setTerm(e.target.value)} />
            </Field>
            {picked && (
              <p className="text-[13px] text-success-text" role="status">
                Selected: <strong>{picked.name || picked.email || picked.phone}</strong>
              </p>
            )}
            <ul className="max-h-44 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="Matching contacts">
              {results.data?.data.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2", picked?.id === c.id && "bg-primary-soft")}
                    aria-pressed={picked?.id === c.id}
                    onClick={() => setPicked(c)}
                  >
                    <Avatar name={c.name || c.email || "?"} seed={c.id} size="sm" />
                    <span className="min-w-0">
                      <strong className="block truncate text-[13px]">{c.name || "Unnamed"}</strong>
                      <small className="block truncate text-xs text-subtle">{[c.email, c.phone].filter(Boolean).join(" · ")}</small>
                    </span>
                  </button>
                </li>
              ))}
              {results.data?.data.length === 0 && (
                <li className="flex items-center gap-2 px-3 py-4 text-[13px] text-subtle">
                  <Search className="size-4" aria-hidden="true" /> No matching contacts.
                </li>
              )}
            </ul>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">
              <Input data-autofocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Inbox">
            <NativeSelect value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
              <option value="">Default inbox</option>
              {inboxes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Channel">
            <NativeSelect value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              <option value="dm">Live chat</option>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </NativeSelect>
          </Field>
        </div>
        {channel === "email" && (
          <Field label="Subject">
            <Input value={subject} placeholder={subjectValue} onChange={(e) => setSubject(e.target.value)} />
          </Field>
        )}
        <Field label="First message (optional)">
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>

        {text.trim() !== "" && check.problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-danger-text" aria-live="polite">
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {create.isError && <ErrorNotice error={create.error} compact />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit} loading={create.isPending}>
            {create.isPending ? "Starting…" : text.trim() ? "Start and send" : "Start conversation"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
