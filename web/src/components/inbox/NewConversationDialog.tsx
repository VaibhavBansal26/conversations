import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { useEmailSenders, useInboxes } from "../../api/hooks";
import type { Channel, Contact, Pagination, Room } from "../../api/types";
import { checkComposer, defaultEmailSubject, messageKindFor, verifiedSenders } from "../../lib/composerRules";
import { newClientMsgId } from "../../lib/ids";
import { keys } from "../../state/keys";
import { Dialog } from "../../ui";
import { ErrorNotice } from "../../ui";
import { Field } from "../../ui";

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
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <div className="segmented" role="radiogroup" aria-label="Contact">
          {(["existing", "new"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {m === "existing" ? "Existing contact" : "New contact"}
            </button>
          ))}
        </div>

        {mode === "existing" ? (
          <div>
            <Field label="Find a contact">
              <input data-autofocus type="search" value={term} placeholder="Name, email or phone" onChange={(e) => setTerm(e.target.value)} />
            </Field>
            {picked && (
              <p className="picked" role="status">
                Selected: <strong>{picked.name || picked.email || picked.phone}</strong>
              </p>
            )}
            <ul className="pick-list" aria-label="Matching contacts">
              {results.data?.data.map((c) => (
                <li key={c.id}>
                  <button type="button" className={picked?.id === c.id ? "active" : ""} aria-pressed={picked?.id === c.id} onClick={() => setPicked(c)}>
                    <strong>{c.name || "Unnamed"}</strong>
                    <small>{[c.email, c.phone].filter(Boolean).join(" · ")}</small>
                  </button>
                </li>
              ))}
              {results.data?.data.length === 0 && <li className="muted">No matching contacts.</li>}
            </ul>
          </div>
        ) : (
          <div className="grid-3">
            <Field label="Name">
              <input data-autofocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <input type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
          </div>
        )}

        <div className="grid-2">
          <Field label="Inbox">
            <select value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
              <option value="">Default inbox</option>
              {inboxes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Channel">
            <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              <option value="dm">Live chat</option>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
          </Field>
        </div>
        {channel === "email" && (
          <Field label="Subject">
            <input value={subject} placeholder={subjectValue} onChange={(e) => setSubject(e.target.value)} />
          </Field>
        )}
        <Field label="First message (optional)">
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>

        {text.trim() !== "" && check.problems.length > 0 && (
          <ul className="problems" aria-live="polite">
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {create.isError && <ErrorNotice error={create.error} compact />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit || create.isPending}>
            {create.isPending ? "Starting…" : text.trim() ? "Start and send" : "Start conversation"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
