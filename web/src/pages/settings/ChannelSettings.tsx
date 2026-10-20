import { AtSign, Mail, Phone, Plus, Star, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import { useEmailSenders, useInboundAddresses, useSmsNumbers } from "../../api/hooks";
import { useListMutation } from "../../api/settingsHooks";
import type { EmailSender, SmsNumber } from "../../api/types";
import { ConfirmDialog } from "../../components/settings/ConfirmDialog";
import { ListRow, RowList, SettingsSection } from "../../components/settings/SettingsSection";
import { keys } from "../../state/keys";
import { Badge, Button, EmptyState, ErrorNotice, Field, Input, Skeleton, toast } from "../../ui";

function Loading() {
  return <Skeleton className="h-12" />;
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="danger-ghost" size="sm" aria-label={label} onClick={onClick}>
      <Trash2 aria-hidden="true" /> Remove
    </Button>
  );
}

function Avatarish({ children }: { children: ReactNode }) {
  return <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-text">{children}</span>;
}

function SmsNumbers() {
  const numbers = useSmsNumbers();
  const [form, setForm] = useState({ e164: "", label: "" });
  const [confirm, setConfirm] = useState<SmsNumber | null>(null);
  const add = useListMutation((b: typeof form) => api.post<SmsNumber>("/sms-numbers", { e164: b.e164.trim(), label: b.label.trim() || undefined }), keys.smsNumbers);
  const makeDefault = useListMutation((id: string) => api.post(`/sms-numbers/${id}/default`), keys.smsNumbers);
  const remove = useListMutation((id: string) => api.delete(`/sms-numbers/${id}`), keys.smsNumbers);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(form, { onSuccess: () => { setForm({ e164: "", label: "" }); toast({ title: "Number added", tone: "success" }); } });
  };
  return (
    <SettingsSection title="SMS numbers" description="Numbers your team texts from. Each number can hold one conversation per contact at a time.">
      {numbers.isPending && <Loading />}
      {numbers.isError && <ErrorNotice error={numbers.error} onRetry={() => void numbers.refetch()} />}
      {numbers.data?.length === 0 && <EmptyState icon={Phone} title="No SMS numbers yet" hint="Add a number to text customers from the inbox." className="py-6" />}
      {!!numbers.data?.length && (
        <RowList>
          {numbers.data.map((n) => (
            <ListRow
              key={n.id}
              actions={
                <>
                  {!n.is_default && (
                    <Button variant="ghost" size="sm" onClick={() => makeDefault.mutate(n.id)}>
                      <Star aria-hidden="true" /> Make default
                    </Button>
                  )}
                  <RemoveButton label={`Remove ${n.e164}`} onClick={() => setConfirm(n)} />
                </>
              }
            >
              <div className="flex items-center gap-3">
                <Avatarish>
                  <Phone className="size-[18px]" aria-hidden="true" />
                </Avatarish>
                <div className="min-w-0">
                  <strong className="text-sm">{n.e164}</strong> {n.is_default && <Badge tone="primary">Default</Badge>}
                  {n.label && <p className="text-[13px] text-muted-foreground">{n.label}</p>}
                </div>
              </div>
            </ListRow>
          ))}
        </RowList>
      )}
      <form className="flex flex-wrap items-end gap-3 border-t border-border pt-4" onSubmit={submit}>
        <Field label="Phone number" className="min-w-48 flex-1">
          <Input type="tel" value={form.e164} placeholder="+14155550123" onChange={(e) => setForm({ ...form, e164: e.target.value })} required />
        </Field>
        <Field label="Label" className="min-w-40 flex-1">
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <Button type="submit" loading={add.isPending}>
          <Plus aria-hidden="true" /> Add number
        </Button>
      </form>
      {(add.isError || makeDefault.isError || remove.isError) && <ErrorNotice error={add.error ?? makeDefault.error ?? remove.error} />}
      {confirm && <ConfirmDialog title="Remove number" message={`Remove ${confirm.e164}?`} confirmLabel="Remove" onCancel={() => setConfirm(null)} onConfirm={() => { remove.mutate(confirm.id); setConfirm(null); }} />}
    </SettingsSection>
  );
}

function EmailSenders() {
  const senders = useEmailSenders();
  const [form, setForm] = useState({ address: "", display_name: "" });
  const [confirm, setConfirm] = useState<EmailSender | null>(null);
  const add = useListMutation((b: typeof form) => api.post<EmailSender>("/email-senders", { address: b.address.trim(), display_name: b.display_name.trim() || undefined }), keys.senders);
  const patch = useListMutation(({ id, ...body }: { id: string; verified?: boolean; is_default?: boolean }) => api.patch(`/email-senders/${id}`, body), keys.senders);
  const remove = useListMutation((id: string) => api.delete(`/email-senders/${id}`), keys.senders);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(form, { onSuccess: () => { setForm({ address: "", display_name: "" }); toast({ title: "Sender added", tone: "success" }); } });
  };
  return (
    <SettingsSection title="Email senders" description="Addresses you can send from. Only verified senders can be used in the composer.">
      {senders.isPending && <Loading />}
      {senders.isError && <ErrorNotice error={senders.error} onRetry={() => void senders.refetch()} />}
      {senders.data?.length === 0 && <EmptyState icon={Mail} title="No senders yet" hint="Add and verify an address to send email from the inbox." className="py-6" />}
      {!!senders.data?.length && (
        <RowList>
          {senders.data.map((s) => (
            <ListRow
              key={s.id}
              actions={
                <>
                  {!s.verified && (
                    <Button variant="outline" size="sm" aria-label={`Verify ${s.address}`} onClick={() => patch.mutate({ id: s.id, verified: true })}>
                      Verify
                    </Button>
                  )}
                  {s.verified && !s.is_default && (
                    <Button variant="ghost" size="sm" onClick={() => patch.mutate({ id: s.id, is_default: true })}>
                      <Star aria-hidden="true" /> Make default
                    </Button>
                  )}
                  <RemoveButton label={`Remove ${s.address}`} onClick={() => setConfirm(s)} />
                </>
              }
            >
              <div className="flex items-center gap-3">
                <Avatarish>
                  <Mail className="size-[18px]" aria-hidden="true" />
                </Avatarish>
                <div className="min-w-0">
                  <strong className="break-all text-sm">{s.address}</strong>
                  <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
                    {s.display_name && <span>{s.display_name}</span>}
                    <Badge tone={s.verified ? "success" : "warning"}>{s.verified ? "Verified" : "Unverified"}</Badge>
                    {s.is_default && <Badge tone="primary">Default</Badge>}
                  </p>
                </div>
              </div>
            </ListRow>
          ))}
        </RowList>
      )}
      <form className="flex flex-wrap items-end gap-3 border-t border-border pt-4" onSubmit={submit}>
        <Field label="Address" className="min-w-48 flex-1">
          <Input type="email" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
        </Field>
        <Field label="Display name" className="min-w-40 flex-1">
          <Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        </Field>
        <Button type="submit" loading={add.isPending}>
          <Plus aria-hidden="true" /> Add sender
        </Button>
      </form>
      {(add.isError || patch.isError || remove.isError) && <ErrorNotice error={add.error ?? patch.error ?? remove.error} />}
      {confirm && <ConfirmDialog title="Remove sender" message={`Remove ${confirm.address}?`} confirmLabel="Remove" onCancel={() => setConfirm(null)} onConfirm={() => { remove.mutate(confirm.id); setConfirm(null); }} />}
    </SettingsSection>
  );
}

function InboundAddresses() {
  const addresses = useInboundAddresses();
  const [address, setAddress] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const add = useListMutation((a: string) => api.post("/inbound-addresses", { address: a.trim() }), keys.inbound);
  const remove = useListMutation((a: string) => api.delete(`/inbound-addresses/${encodeURIComponent(a)}`), keys.inbound);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(address, { onSuccess: () => { setAddress(""); toast({ title: "Address added", tone: "success" }); } });
  };
  return (
    <SettingsSection title="Inbound addresses" description="Emails sent to these addresses create conversations in your default email inbox.">
      {addresses.isPending && <Loading />}
      {addresses.isError && <ErrorNotice error={addresses.error} onRetry={() => void addresses.refetch()} />}
      {addresses.data?.length === 0 && <EmptyState icon={AtSign} title="No inbound addresses yet" hint="Forward a support address here to turn emails into conversations." className="py-6" />}
      {!!addresses.data?.length && (
        <RowList>
          {addresses.data.map((a) => (
            <ListRow key={a.address} actions={<RemoveButton label={`Remove ${a.address}`} onClick={() => setConfirm(a.address)} />}>
              <div className="flex items-center gap-3">
                <Avatarish>
                  <AtSign className="size-[18px]" aria-hidden="true" />
                </Avatarish>
                <strong className="break-all text-sm">{a.address}</strong>
              </div>
            </ListRow>
          ))}
        </RowList>
      )}
      <form className="flex flex-wrap items-end gap-3 border-t border-border pt-4" onSubmit={submit}>
        <Field label="Address" className="min-w-48 flex-1">
          <Input type="email" value={address} onChange={(e) => setAddress(e.target.value)} required />
        </Field>
        <Button type="submit" loading={add.isPending}>
          <Plus aria-hidden="true" /> Add address
        </Button>
      </form>
      {(add.isError || remove.isError) && <ErrorNotice error={add.error ?? remove.error} />}
      {confirm && <ConfirmDialog title="Remove address" message={`Remove ${confirm}?`} confirmLabel="Remove" onCancel={() => setConfirm(null)} onConfirm={() => { remove.mutate(confirm); setConfirm(null); }} />}
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
