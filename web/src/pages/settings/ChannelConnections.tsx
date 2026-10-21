import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, KeyRound, Mail, PlugZap, RefreshCw, Send, Smartphone, Unplug } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import type { ChannelConnection, ChannelConnections, ChannelEvent, ChannelStatus, TwilioNumberRow, VerifyResult } from "../../api/types";
import { ConfirmDialog } from "../../components/settings/ConfirmDialog";
import { CopyButton } from "../../components/settings/CopyButton";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { formatClock } from "../../lib/time";
import { keys } from "../../state/keys";
import { Badge, Button, ErrorNotice, Field, Input, Skeleton, toast } from "../../ui";

/** Connection status as a badge: the three states a stored connection can be in. */
function StatusBadge({ c, status }: { c: ChannelConnection | null; status: ChannelStatus | undefined }) {
  if (c) {
    if (c.status === "verified") return <Badge tone="success">Connected</Badge>;
    if (c.status === "error") return <Badge tone="danger">Needs attention</Badge>;
    return <Badge tone="warning">Not verified</Badge>;
  }
  if (status?.mode === "live") return <Badge tone="success">Connected (platform account)</Badge>;
  return <Badge tone="warning">Test mode</Badge>;
}

function useConnections() {
  return useQuery({ queryKey: keys.channelConnections, queryFn: () => api.get<ChannelConnections>("/channels/connections") });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: keys.channelConnections }), qc.invalidateQueries({ queryKey: keys.channelStatus }), qc.invalidateQueries({ queryKey: keys.smsNumbers }), qc.invalidateQueries({ queryKey: keys.senders })]);
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
}

function UrlRow({ label, url, hint }: { label: string; url: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[12px]" data-testid="webhook-url">{url}</code>
        <CopyButton text={url} />
      </div>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}

const OUTCOME_TONE = { processed: "success", duplicate: "neutral", ignored: "warning", rejected: "danger" } as const;

/** "Check webhook": the newest inbound events and what became of them. Polls only while open. */
function WebhookCheck({ channel }: { channel: "sms" | "email" }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: keys.channelEvents(channel),
    queryFn: async () => (await api.get<{ data: ChannelEvent[] }>(`/channels/${channel}/events`)).data,
    enabled: open,
    refetchInterval: open ? 4000 : false,
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <RefreshCw aria-hidden="true" /> {open ? "Hide webhook check" : "Check webhook"}
        </Button>
        <span className="text-xs text-subtle">Send a text or email to your number and watch it arrive here.</span>
      </div>
      {open && q.isPending && <Skeleton className="h-10" />}
      {open && q.isError && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} compact />}
      {open && q.data && q.data.length === 0 && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-muted-foreground" role="status">
          Nothing received yet. Paste the URL above into the provider and send yourself a message; this list refreshes every few seconds.
        </p>
      )}
      {open && !!q.data?.length && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label="Recent inbound events">
          {q.data.slice(0, 8).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
              <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome}</Badge>
              <span className="font-mono text-xs">{e.kind}</span>
              <time className="ml-auto text-xs text-subtle" dateTime={e.at}>{formatClock(e.at)}</time>
              {e.detail && <span className="basis-full text-xs text-muted-foreground">{e.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TestSend({ channel, disabled }: { channel: "sms" | "email"; disabled: boolean }) {
  const [to, setTo] = useState("");
  const send = useMutation({
    mutationFn: () => api.post<{ ok: true; to: string; from: string }>(`/channels/${channel}/test`, { to: to.trim() }),
    onSuccess: (r) => toast({ title: channel === "sms" ? `Test text sent to ${r.to}` : `Test email sent to ${r.to}`, description: `From ${r.from}. It can take a minute to arrive.`, tone: "success" }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={submit} aria-label={channel === "sms" ? "Send a test text" : "Send a test email"}>
      <Field label={channel === "sms" ? "Send a test text to" : "Send a test email to"} className="min-w-56 flex-1" hint={channel === "sms" ? "International format. On a Twilio trial account this must be a number you verified in Twilio." : undefined}>
        <Input type={channel === "sms" ? "tel" : "email"} value={to} placeholder={channel === "sms" ? "+14155550123" : "you@example.com"} onChange={(e) => setTo(e.target.value)} required />
      </Field>
      <Button type="submit" variant="outline" loading={send.isPending} disabled={disabled}>
        <Send aria-hidden="true" /> Send test
      </Button>
      {send.isError && <div className="basis-full"><ErrorNotice error={send.error} compact /></div>}
    </form>
  );
}

/* ------------------------------------------------------------------ Twilio */

function TwilioNumbers() {
  const refresh = useRefresh();
  const list = useMutation({ mutationFn: async () => (await api.get<{ data: TwilioNumberRow[] }>("/channels/sms/numbers")).data });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const imp = useMutation({
    mutationFn: () => api.post<{ imported: string[]; skipped: { e164: string; reason: string }[] }>("/channels/sms/numbers/import", { e164s: [...picked] }),
    onSuccess: async (r) => {
      toast({ title: `${r.imported.length} number${r.imported.length === 1 ? "" : "s"} imported`, description: r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped[0]!.reason}` : undefined, tone: r.imported.length ? "success" : "default" });
      setPicked(new Set());
      await refresh();
      list.mutate();
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => list.mutate()} loading={list.isPending}>
          <Smartphone aria-hidden="true" /> Import numbers from Twilio
        </Button>
        <span className="text-xs text-subtle">Or add a number by hand below; it must be on your Twilio account.</span>
      </div>
      {list.isError && <ErrorNotice error={list.error} compact />}
      {list.data && list.data.length === 0 && <p className="text-[13px] text-muted-foreground" role="status">Your Twilio account has no phone numbers yet. Buy one in the Twilio Console (Phone Numbers).</p>}
      {!!list.data?.length && (
        <fieldset className="flex flex-col gap-1 rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Numbers on your Twilio account</legend>
          {list.data.map((n) => (
            <label key={n.e164} className="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--color-primary)]" disabled={n.imported || !n.sms_capable} checked={n.imported || picked.has(n.e164)} onChange={(e) => setPicked((s) => { const next = new Set(s); if (e.target.checked) next.add(n.e164); else next.delete(n.e164); return next; })} />
              <span className="font-medium">{n.e164}</span>
              {n.label && <span className="text-muted-foreground">{n.label}</span>}
              {n.imported && <Badge tone="success">Added</Badge>}
              {!n.sms_capable && <Badge tone="neutral">No SMS</Badge>}
            </label>
          ))}
          <div className="pt-2">
            <Button size="sm" onClick={() => imp.mutate()} loading={imp.isPending} disabled={!picked.size}>Add {picked.size || ""} selected</Button>
          </div>
        </fieldset>
      )}
      {imp.isError && <ErrorNotice error={imp.error} compact />}
    </div>
  );
}

function TwilioConnect({ conn, status }: { conn: ChannelConnection | null; status: ChannelStatus | undefined }) {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [form, setForm] = useState({ account_sid: "", auth_token: "", api_key_sid: "", api_key_secret: "" });
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { account_sid: form.account_sid.trim(), auth_token: form.auth_token.trim() };
      if (form.api_key_sid.trim()) Object.assign(body, { api_key_sid: form.api_key_sid.trim(), api_key_secret: form.api_key_secret.trim() });
      await api.put("/channels/sms/connection", body);
      return await api.post<VerifyResult>("/channels/sms/verify");
    },
    onSuccess: async (r) => {
      setResult(r);
      setForm({ account_sid: "", auth_token: "", api_key_sid: "", api_key_secret: "" });
      setEditing(false);
      toast({ title: "Twilio connected", description: r.connection.account?.friendly_name, tone: "success" });
      await refresh();
    },
    onError: () => void refresh(),
  });
  const verify = useMutation({
    mutationFn: () => api.post<VerifyResult>("/channels/sms/verify"),
    onSuccess: async (r) => {
      setResult(r);
      toast({ title: "Credentials verified", tone: "success" });
      await refresh();
    },
    onError: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: () => api.delete("/channels/sms/connection"),
    onSuccess: async () => {
      setResult(null);
      toast({ title: "Twilio disconnected", description: "The credentials were deleted.", tone: "success" });
      await refresh();
    },
  });
  const form_ = !conn || editing;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <SettingsSection
      title="SMS: Twilio"
      description="Connect your own Twilio account. Texts are sent and received through it, and Twilio bills you directly."
      actions={<StatusBadge c={conn} status={status} />}
    >
      {conn && !editing && (
        <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2" aria-label="Twilio connection">
          <div><dt className="text-subtle">Account</dt><dd className="font-medium">{conn.account?.friendly_name ?? "Not verified yet"} {conn.account?.type && <Badge tone={/trial/i.test(conn.account.type) ? "warning" : "neutral"}>{conn.account.type}</Badge>}</dd></div>
          <div><dt className="text-subtle">Account SID</dt><dd><Mono>{conn.masked.account_sid}</Mono></dd></div>
          <div><dt className="text-subtle">Auth Token</dt><dd><Mono>{conn.masked.auth_token}</Mono> <span className="text-xs text-subtle">stored encrypted, never shown</span></dd></div>
          {conn.masked.api_key_sid && <div><dt className="text-subtle">API key</dt><dd><Mono>{conn.masked.api_key_sid}</Mono></dd></div>}
          {conn.verified_at && <div><dt className="text-subtle">Verified</dt><dd>{new Date(conn.verified_at).toLocaleString()}</dd></div>}
        </dl>
      )}
      {conn?.status === "error" && conn.last_error && <ErrorNotice error={new Error(conn.last_error)} />}
      {result?.warnings.map((w) => (
        <p key={w} className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-[13px] text-warning-text" role="status">{w}</p>
      ))}
      {form_ && (
        <form className="flex flex-col gap-4 rounded-lg border border-border-strong bg-surface-2/50 p-4" onSubmit={submit} aria-label="Connect Twilio">
          <p className="text-[13px] text-muted-foreground">
            Find these in the{" "}
            <a className="font-medium text-primary-text underline underline-offset-2" href="https://console.twilio.com/" target="_blank" rel="noreferrer">
              Twilio Console <ExternalLink className="inline size-3" aria-hidden="true" />
            </a>{" "}
            under Account Info. They are stored encrypted and never shown again.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account SID" hint="Starts with AC">
              <Input value={form.account_sid} onChange={(e) => setForm({ ...form, account_sid: e.target.value })} placeholder="AC…" autoComplete="off" spellCheck={false} required />
            </Field>
            <Field label="Auth Token" hint="Also verifies Twilio's webhook signatures">
              <Input type="password" value={form.auth_token} onChange={(e) => setForm({ ...form, auth_token: e.target.value })} autoComplete="new-password" spellCheck={false} required />
            </Field>
          </div>
          <div>
            <Button variant="link" className="whitespace-normal text-left" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              <KeyRound className="size-3.5" aria-hidden="true" /> {advanced ? "Hide API key" : "Send with an API key instead (optional)"}
            </Button>
            {advanced && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="API key SID" hint="Starts with SK">
                  <Input value={form.api_key_sid} onChange={(e) => setForm({ ...form, api_key_sid: e.target.value })} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="API key secret" hint="The Auth Token above is still needed for webhooks">
                  <Input type="password" value={form.api_key_secret} onChange={(e) => setForm({ ...form, api_key_secret: e.target.value })} autoComplete="new-password" spellCheck={false} />
                </Field>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={save.isPending}>
              <PlugZap aria-hidden="true" /> {conn ? "Replace and verify" : "Connect and verify"}
            </Button>
            {editing && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
          {save.isError && <ErrorNotice error={save.error} />}
        </form>
      )}
      {conn && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => verify.mutate()} loading={verify.isPending}>
            <CheckCircle2 aria-hidden="true" /> Verify credentials
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Replace credentials</Button>
          <Button variant="danger-ghost" size="sm" onClick={() => setConfirm(true)}>
            <Unplug aria-hidden="true" /> Disconnect
          </Button>
        </div>
      )}
      {verify.isError && <ErrorNotice error={verify.error} />}
      {remove.isError && <ErrorNotice error={remove.error} />}
      {conn?.status === "verified" && !editing && (
        <>
          <hr className="border-border" />
          <TwilioNumbers />
          <hr className="border-border" />
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Receive texts: webhooks</h3>
            <p className="text-[13px] text-muted-foreground">
              In the Twilio Console open Phone Numbers &gt; Manage &gt; Active numbers, pick the number, and under Messaging set <em>A message comes in</em> to Webhook (HTTP POST) with the first URL. Twilio's signature is checked with your Auth Token, so only your account can post here.
            </p>
            <UrlRow label="A message comes in (SMS webhook)" url={conn.webhooks.sms ?? ""} />
            <UrlRow label="Status callback (delivery receipts)" url={conn.webhooks.status ?? ""} hint="Sent automatically with every text; you only need it if you also want Twilio to call it for other senders." />
            <WebhookCheck channel="sms" />
          </div>
          <hr className="border-border" />
          <TestSend channel="sms" disabled={false} />
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="Disconnect Twilio"
          message="This deletes the saved credentials. Texts will not be sent or received until you connect again. Your numbers and conversations stay."
          confirmLabel="Disconnect"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            remove.mutate();
            setConfirm(false);
          }}
        />
      )}
    </SettingsSection>
  );
}

/* ---------------------------------------------------------------- SendGrid */

function SendGridConnect({ conn, status }: { conn: ChannelConnection | null; status: ChannelStatus | undefined }) {
  const refresh = useRefresh();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [pubKey, setPubKey] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      await api.put("/channels/email/connection", { api_key: apiKey.trim() });
      return await api.post<VerifyResult>("/channels/email/verify");
    },
    onSuccess: async (r) => {
      setResult(r);
      setApiKey("");
      setEditing(false);
      toast({ title: "SendGrid connected", tone: "success" });
      await refresh();
    },
    onError: () => void refresh(),
  });
  const verify = useMutation({
    mutationFn: () => api.post<VerifyResult>("/channels/email/verify"),
    onSuccess: async (r) => {
      setResult(r);
      toast({ title: "API key verified", tone: "success" });
      await refresh();
    },
    onError: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: () => api.delete("/channels/email/connection"),
    onSuccess: async () => {
      setResult(null);
      toast({ title: "SendGrid disconnected", description: "The API key was deleted.", tone: "success" });
      await refresh();
    },
  });
  const importSenders = useMutation({
    mutationFn: () => api.post<{ added: number; updated: number; total_verified: number }>("/channels/email/senders/import"),
    onSuccess: async (r) => {
      toast({ title: `${r.added + r.updated} sender${r.added + r.updated === 1 ? "" : "s"} imported`, description: `${r.total_verified} verified in SendGrid.`, tone: "success" });
      await refresh();
    },
  });
  const settings = useMutation({
    mutationFn: (b: { inbound_domain?: string | null; event_public_key?: string | null }) => api.patch("/channels/email/connection", b),
    onSuccess: async () => {
      toast({ title: "Saved", tone: "success" });
      setPubKey("");
      await refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: () => api.post("/channels/email/webhook-secret/rotate"),
    onSuccess: async () => {
      toast({ title: "New webhook secret", description: "Paste the new URLs into SendGrid; the old ones stopped working.", tone: "success" });
      await qc.invalidateQueries({ queryKey: keys.channelConnections });
    },
  });
  const form = !conn || editing;
  const shownDomain = domain ?? conn?.inbound_domain ?? "";
  return (
    <SettingsSection
      title="Email: SendGrid"
      description="Connect your own SendGrid account. Email is sent from your verified senders and replies arrive through Inbound Parse."
      actions={<StatusBadge c={conn} status={status} />}
    >
      {conn && !editing && (
        <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2" aria-label="SendGrid connection">
          <div><dt className="text-subtle">API key</dt><dd><Mono>{conn.masked.api_key}</Mono> <span className="text-xs text-subtle">stored encrypted, never shown</span></dd></div>
          {conn.account && <div><dt className="text-subtle">Verified senders in SendGrid</dt><dd className="font-medium">{conn.account.verified_senders ?? "unknown (key cannot read them)"}</dd></div>}
          {!!conn.account?.domains?.length && <div><dt className="text-subtle">Authenticated domains</dt><dd>{conn.account.domains.map((d) => <Badge key={d.domain} tone={d.valid ? "success" : "warning"} className="mr-1">{d.domain}{d.valid ? "" : " (DNS pending)"}</Badge>)}</dd></div>}
          {conn.verified_at && <div><dt className="text-subtle">Verified</dt><dd>{new Date(conn.verified_at).toLocaleString()}</dd></div>}
        </dl>
      )}
      {conn?.status === "error" && conn.last_error && <ErrorNotice error={new Error(conn.last_error)} />}
      {result?.warnings.map((w) => (
        <p key={w} className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-[13px] text-warning-text" role="status">{w}</p>
      ))}
      {form && (
        <form className="flex flex-col gap-4 rounded-lg border border-border-strong bg-surface-2/50 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} aria-label="Connect SendGrid">
          <p className="text-[13px] text-muted-foreground">
            Create an API key in{" "}
            <a className="font-medium text-primary-text underline underline-offset-2" href="https://app.sendgrid.com/settings/api_keys" target="_blank" rel="noreferrer">
              SendGrid &gt; Settings &gt; API Keys <ExternalLink className="inline size-3" aria-hidden="true" />
            </a>{" "}
            with Mail Send permission (add Sender Authentication read to import verified senders). It is stored encrypted and never shown again.
          </p>
          <Field label="API key" hint="Starts with SG.">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" spellCheck={false} placeholder="SG.…" required />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={save.isPending}>
              <PlugZap aria-hidden="true" /> {conn ? "Replace and verify" : "Connect and verify"}
            </Button>
            {editing && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
          {save.isError && <ErrorNotice error={save.error} />}
        </form>
      )}
      {conn && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => verify.mutate()} loading={verify.isPending}>
            <CheckCircle2 aria-hidden="true" /> Verify API key
          </Button>
          {conn.status === "verified" && (
            <Button variant="outline" size="sm" onClick={() => importSenders.mutate()} loading={importSenders.isPending}>
              <Mail aria-hidden="true" /> Import verified senders
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Replace API key</Button>
          <Button variant="danger-ghost" size="sm" onClick={() => setConfirm(true)}>
            <Unplug aria-hidden="true" /> Disconnect
          </Button>
        </div>
      )}
      {(verify.isError || importSenders.isError || remove.isError) && <ErrorNotice error={verify.error ?? importSenders.error ?? remove.error} />}
      {conn?.status === "verified" && !editing && (
        <>
          <hr className="border-border" />
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Receive replies: Inbound Parse</h3>
            <p className="text-[13px] text-muted-foreground">
              Point an MX record of a (sub)domain you own at <Mono>mx.sendgrid.net</Mono> (priority 10), then in SendGrid open Settings &gt; Inbound Parse &gt; Add Host &amp; URL, choose that domain, and paste the URL below. Add the address people write to under <em>Inbound addresses</em>. The URL contains this connection's secret; treat it like a password.
            </p>
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); settings.mutate({ inbound_domain: shownDomain.trim() || null }); }}>
              <Field label="Inbound domain (optional)" hint="Shown for your own reference, for example inbound.example.com" className="min-w-56 flex-1">
                <Input value={shownDomain} onChange={(e) => setDomain(e.target.value)} placeholder="inbound.example.com" />
              </Field>
              <Button type="submit" variant="outline" size="sm" loading={settings.isPending}>Save domain</Button>
            </form>
            <UrlRow label="Inbound Parse URL" url={conn.webhooks.inbound ?? ""} />
            <Button variant="ghost" size="sm" className="self-start" onClick={() => rotate.mutate()} loading={rotate.isPending}>
              <RefreshCw aria-hidden="true" /> Generate a new secret
            </Button>
          </div>
          <hr className="border-border" />
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Delivery events: Event Webhook</h3>
            <p className="text-[13px] text-muted-foreground">
              In SendGrid open Settings &gt; Mail Settings &gt; Event Webhook, paste this URL, tick Delivered, Bounced, Dropped and Opened, and turn on Signature Verification. Paste the verification key SendGrid shows into the field below so requests are checked against it.
            </p>
            <UrlRow label="Event Webhook URL" url={conn.webhooks.events ?? ""} />
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); settings.mutate({ event_public_key: pubKey.trim() || null }); }}>
              <Field label="Verification key" hint={conn.event_public_key_set ? "A key is saved. Paste a new one to replace it, or leave empty and save to remove it." : "Optional but recommended. Without it the secret in the URL is the only proof."} className="min-w-56 flex-1">
                <Input value={pubKey} onChange={(e) => setPubKey(e.target.value)} placeholder="MFkwEwYHKoZIzj0C…" spellCheck={false} />
              </Field>
              <Button type="submit" variant="outline" size="sm" loading={settings.isPending}>Save key</Button>
            </form>
            {settings.isError && <ErrorNotice error={settings.error} compact />}
            <WebhookCheck channel="email" />
          </div>
          <hr className="border-border" />
          <TestSend channel="email" disabled={false} />
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title="Disconnect SendGrid"
          message="This deletes the saved API key. Email will not be sent or received until you connect again. Your senders and conversations stay."
          confirmLabel="Disconnect"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            remove.mutate();
            setConfirm(false);
          }}
        />
      )}
    </SettingsSection>
  );
}

/** The two connection cards. Only workspace managers see them (the API enforces `channels:manage`). */
export function ChannelConnectionsPanel({ sms, email }: { sms?: ChannelStatus; email?: ChannelStatus }) {
  const q = useConnections();
  if (q.isPending) return <Skeleton className="mb-6 h-40" />;
  if (q.isError) return <div className="mb-6"><ErrorNotice error={q.error} onRetry={() => void q.refetch()} /></div>;
  return (
    <>
      <TwilioConnect conn={q.data.sms} status={sms} />
      <SendGridConnect conn={q.data.email} status={email} />
    </>
  );
}
