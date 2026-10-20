import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import type { Contact } from "../../api/types";
import { fieldErrors } from "../../lib/apiError";
import { keys } from "../../state/keys";
import { Plus, X } from "lucide-react";
import { Button, ErrorNotice, Field, Input, Switch, toast } from "../../ui";

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
      toast({ title: "Contact saved", tone: "success" });
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
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name" error={errors.name}>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Email" error={errors.email}>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Phone" hint="International format, e.g. +14155550123" error={errors.phone}>
        <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Switch label="Opted out of SMS" hint="Set when the contact replies STOP. Texts are blocked while on." checked={optOut} onChange={setOptOut} />

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium">Tags</legend>
        {tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <li key={t} className="flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary-text">
                {t}
                <button type="button" className="grid size-4 place-items-center rounded-full hover:bg-primary/15" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="tag-draft">
            Add tag
          </label>
          <Input
            id="tag-draft"
            value={tagDraft}
            placeholder="Add tag"
            className="h-8"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <Button variant="outline" size="sm" onClick={addTag}>
            Add
          </Button>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium">Custom attributes</legend>
        {attrs.map((a, i) => (
          <div className="flex gap-1.5" key={i}>
            <Input className="h-8" aria-label={`Attribute ${i + 1} name`} placeholder="name" value={a.key} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <Input className="h-8" aria-label={`Attribute ${i + 1} value`} placeholder="value" value={a.value} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <Button variant="ghost" size="icon-sm" aria-label={`Remove attribute ${a.key || i + 1}`} onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}>
              <X />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => setAttrs([...attrs, { key: "", value: "" }])}>
          <Plus aria-hidden="true" /> Add attribute
        </Button>
      </fieldset>

      {save.isError && <ErrorNotice error={save.error} compact />}
      <Button type="submit" size="sm" loading={save.isPending}>
        {save.isPending ? "Saving…" : save.isSuccess ? "Saved" : "Save contact"}
      </Button>
    </form>
  );
}
