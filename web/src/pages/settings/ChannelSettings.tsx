import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useEmailSenders, useInboundAddresses, useSmsNumbers } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { EmailSender, SmsNumber } from "../../api/types";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";
import { keys } from "../../state/keys";

function SmsNumbers() {
  const numbers = useSmsNumbers();
  const [form, setForm] = useState({ e164: "", label: "" });
  const add = useListMutation((b: typeof form) => api.post<SmsNumber>("/sms-numbers", { e164: b.e164.trim(), label: b.label.trim() || undefined }), keys.smsNumbers);
  const makeDefault = useListMutation((id: string) => api.post(`/sms-numbers/${id}/default`), keys.smsNumbers);
  const remove = useListMutation((id: string) => api.delete(`/sms-numbers/${id}`), keys.smsNumbers);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(form, { onSuccess: () => setForm({ e164: "", label: "" }) });
  };
  return (
    <SettingsSection title="SMS numbers" description="Numbers your team texts from. Each number can hold one conversation per contact at a time.">
      <ul className="card-list compact">
        {numbers.data?.map((n) => (
          <li key={n.id} className="card">
            <span>
              <strong>{n.e164}</strong> {n.label && <span className="muted">{n.label}</span>} {n.is_default && <span className="tag">Default</span>}
            </span>
            <span className="row">
              {!n.is_default && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => makeDefault.mutate(n.id)}>
                  Make default
                </button>
              )}
              <button type="button" className="btn btn-danger-ghost btn-sm" aria-label={`Remove ${n.e164}`} onClick={() => window.confirm(`Remove ${n.e164}?`) && remove.mutate(n.id)}>
                Remove
              </button>
            </span>
          </li>
        ))}
        {numbers.data?.length === 0 && <li className="muted">No SMS numbers yet.</li>}
      </ul>
      <form className="row end" onSubmit={submit}>
        <Field label="Phone number">
          <input type="tel" value={form.e164} placeholder="+14155550123" onChange={(e) => setForm({ ...form, e164: e.target.value })} required />
        </Field>
        <Field label="Label">
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={add.isPending}>
          Add number
        </button>
      </form>
      {(add.isError || makeDefault.isError || remove.isError) && <ErrorNotice error={add.error ?? makeDefault.error ?? remove.error} />}
    </SettingsSection>
  );
}

function EmailSenders() {
  const senders = useEmailSenders();
  const [form, setForm] = useState({ address: "", display_name: "" });
  const add = useListMutation((b: typeof form) => api.post<EmailSender>("/email-senders", { address: b.address.trim(), display_name: b.display_name.trim() || undefined }), keys.senders);
  const patch = useListMutation(({ id, ...body }: { id: string; verified?: boolean; is_default?: boolean }) => api.patch(`/email-senders/${id}`, body), keys.senders);
  const remove = useListMutation((id: string) => api.delete(`/email-senders/${id}`), keys.senders);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(form, { onSuccess: () => setForm({ address: "", display_name: "" }) });
  };
  return (
    <SettingsSection title="Email senders" description="Addresses you can send from. Only verified senders can be used in the composer.">
      <ul className="card-list compact">
        {senders.data?.map((s) => (
          <li key={s.id} className="card">
            <span>
              <strong>{s.address}</strong> {s.display_name && <span className="muted">{s.display_name}</span>}{" "}
              <span className={`tag${s.verified ? "" : " tag-warn"}`}>{s.verified ? "Verified" : "Unverified"}</span> {s.is_default && <span className="tag">Default</span>}
            </span>
            <span className="row">
              {!s.verified && (
                <button type="button" className="btn btn-outline btn-sm" aria-label={`Verify ${s.address}`} onClick={() => patch.mutate({ id: s.id, verified: true })}>
                  Verify
                </button>
              )}
              {s.verified && !s.is_default && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => patch.mutate({ id: s.id, is_default: true })}>
                  Make default
                </button>
              )}
              <button type="button" className="btn btn-danger-ghost btn-sm" aria-label={`Remove ${s.address}`} onClick={() => window.confirm(`Remove ${s.address}?`) && remove.mutate(s.id)}>
                Remove
              </button>
            </span>
          </li>
        ))}
        {senders.data?.length === 0 && <li className="muted">No senders yet.</li>}
      </ul>
      <form className="row end" onSubmit={submit}>
        <Field label="Address">
          <input type="email" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
        </Field>
        <Field label="Display name">
          <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={add.isPending}>
          Add sender
        </button>
      </form>
      {(add.isError || patch.isError || remove.isError) && <ErrorNotice error={add.error ?? patch.error ?? remove.error} />}
    </SettingsSection>
  );
}

function InboundAddresses() {
  const addresses = useInboundAddresses();
  const [address, setAddress] = useState("");
  const add = useListMutation((a: string) => api.post("/inbound-addresses", { address: a.trim() }), keys.inbound);
  const remove = useListMutation((a: string) => api.delete(`/inbound-addresses/${encodeURIComponent(a)}`), keys.inbound);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(address, { onSuccess: () => setAddress("") });
  };
  return (
    <SettingsSection title="Inbound addresses" description="Emails sent to these addresses create conversations in your default email inbox.">
      <ul className="card-list compact">
        {addresses.data?.map((a) => (
          <li key={a.address} className="card">
            <strong>{a.address}</strong>
            <button type="button" className="btn btn-danger-ghost btn-sm" aria-label={`Remove ${a.address}`} onClick={() => window.confirm(`Remove ${a.address}?`) && remove.mutate(a.address)}>
              Remove
            </button>
          </li>
        ))}
        {addresses.data?.length === 0 && <li className="muted">No inbound addresses yet.</li>}
      </ul>
      <form className="row end" onSubmit={submit}>
        <Field label="Address">
          <input type="email" value={address} onChange={(e) => setAddress(e.target.value)} required />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={add.isPending}>
          Add address
        </button>
      </form>
      {(add.isError || remove.isError) && <ErrorNotice error={add.error ?? remove.error} />}
    </SettingsSection>
  );
}

export function ChannelSettings() {
  return (
    <>
      <SmsNumbers />
      <EmailSenders />
      <InboundAddresses />
    </>
  );
}
