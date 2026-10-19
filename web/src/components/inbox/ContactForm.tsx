import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import type { Contact } from "../../api/types";
import { fieldErrors } from "../../lib/apiError";
import { keys } from "../../state/keys";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Field } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { Switch } from "../ui/Switch";

type Attr = { key: string; value: string };

const toAttrs = (a: Record<string, unknown>): Attr[] => Object.entries(a).map(([key, v]) => ({ key, value: typeof v === "string" ? v : JSON.stringify(v) }));

/** Editable contact card: identity, tags, custom attributes and the SMS opt-out flag, saved together. */
export function ContactForm({ contact }: { contact: Contact }) {
  const qc = useQueryClient();
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [tags, setTags] = useState(contact.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [attrs, setAttrs] = useState<Attr[]>(toAttrs(contact.attrs));
  const [optOut, setOptOut] = useState(contact.sms_opt_out);

  const save = useMutation({
    mutationFn: () =>
      api.patch<Contact>(`/contacts/${contact.id}`, {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        tags,
        attrs: Object.fromEntries(attrs.filter((a) => a.key.trim()).map((a) => [a.key.trim(), a.value])),
        sms_opt_out: optOut,
      }),
    onSuccess: (c) => {
      qc.setQueryData(keys.contact(contact.id), c);
      void qc.invalidateQueries({ queryKey: keys.rooms });
      void qc.invalidateQueries({ queryKey: ["room"] });
    },
  });
  const errors = fieldErrors(save.error);

  const addTag = () => {
    const t = tagDraft.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft("");
  };

  return (
    <form
      className="contact-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name" error={errors.name}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Email" error={errors.email}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Phone" hint="International format, e.g. +14155550123" error={errors.phone}>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Switch label="Opted out of SMS" hint="Set when the contact replies STOP. Texts are blocked while on." checked={optOut} onChange={setOptOut} />

      <fieldset className="tags">
        <legend>Tags</legend>
        <ul className="chip-row">
          {tags.map((t) => (
            <li key={t} className="chip">
              {t}
              <button type="button" className="icon-btn sm" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <label className="sr-only" htmlFor="tag-draft">
            Add tag
          </label>
          <input
            id="tag-draft"
            value={tagDraft}
            placeholder="Add tag"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={addTag}>
            Add
          </button>
        </div>
      </fieldset>

      <fieldset className="attrs">
        <legend>Custom attributes</legend>
        {attrs.map((a, i) => (
          <div className="row" key={i}>
            <input aria-label={`Attribute ${i + 1} name`} placeholder="name" value={a.key} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <input aria-label={`Attribute ${i + 1} value`} placeholder="value" value={a.value} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button type="button" className="icon-btn sm" aria-label={`Remove attribute ${a.key || i + 1}`} onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}>
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttrs([...attrs, { key: "", value: "" }])}>
          <Icon name="plus" size={14} /> Add attribute
        </button>
      </fieldset>

      {save.isError && <ErrorNotice error={save.error} compact />}
      <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>
        {save.isPending ? "Saving…" : save.isSuccess ? "Saved" : "Save contact"}
      </button>
    </form>
  );
}
