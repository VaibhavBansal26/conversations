// Adapted from the legacy UI (see docs/PROVENANCE.md): per-domain embed tokens with regenerate/delete and a copyable snippet.
import { Eye, EyeOff, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useListMutation, useTokens } from "../../api/settingsHooks";
import { CopyButton } from "../../components/settings/CopyButton";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { formatDateTime } from "../../lib/time";
import { keys } from "../../state/keys";
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Input, Skeleton, Textarea, toast } from "../../ui";
import { ConfirmDialog } from "./ConfirmDialog";

export const embedSnippet = (origin: string, token: string): string => `<script src="${origin}/widget.js" data-token="${token}" async></script>`;

const mask = (token: string) => `${token.slice(0, 4)}${"•".repeat(12)}${token.slice(-3)}`;

export function TokenSettings() {
  const tokens = useTokens();
  const [domain, setDomain] = useState("");
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<{ kind: "rotate" | "revoke"; id: string; domain: string } | null>(null);
  const create = useListMutation((d: string) => api.post("/tokens", { domain: d }), keys.tokens);
  const rotate = useListMutation((id: string) => api.post(`/tokens/${id}/rotate`), keys.tokens);
  const revoke = useListMutation((id: string) => api.delete(`/tokens/${id}`), keys.tokens);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(domain.trim(), {
      onSuccess: () => {
        setDomain("");
        toast({ title: "Token created", tone: "success" });
      },
    });
  };
  const toggle = (id: string) =>
    setRevealed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <SettingsSection title="Embed tokens" description="One token per website. The widget only works on the domain its token was issued for.">
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <Field label="Website domain" hint="For example www.example.com" className="min-w-56 max-w-md flex-1">
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.example.com" required />
        </Field>
        <Button type="submit" loading={create.isPending} disabled={!domain.trim()} className="mb-[22px]">
          <Plus aria-hidden="true" /> Create token
        </Button>
      </form>
      {(create.isError || rotate.isError || revoke.isError) && <ErrorNotice error={create.error ?? rotate.error ?? revoke.error} />}
      {tokens.isPending && (
        <div role="status" aria-label="Loading tokens">
          <Skeleton className="h-32" />
        </div>
      )}
      {tokens.isError && <ErrorNotice error={tokens.error} onRetry={() => void tokens.refetch()} />}
      {tokens.data?.length === 0 && <EmptyState icon={KeyRound} title="No tokens yet" hint="Create a token to embed the chat widget on a website." />}
      <ul className="flex flex-col gap-3">
        {tokens.data?.map((t) => {
          const shown = revealed.has(t.id);
          const snippet = embedSnippet(window.location.origin, t.token);
          return (
            <li key={t.id}>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <strong>{t.domain}</strong>
                      <Badge tone={t.status === "active" ? "success" : "neutral"}>{t.status}</Badge>
                    </div>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      created {formatDateTime(t.created_at)}
                      {t.last_used_at ? ` · last used ${formatDateTime(t.last_used_at)}` : " · never used"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setConfirm({ kind: "rotate", id: t.id, domain: t.domain })}>
                      <RefreshCw aria-hidden="true" /> Rotate
                    </Button>
                    <Button variant="danger-ghost" size="sm" onClick={() => setConfirm({ kind: "revoke", id: t.id, domain: t.domain })}>
                      <Trash2 aria-hidden="true" /> Revoke
                    </Button>
                  </div>
                </div>
                <div>
                  <label className="sr-only" htmlFor={`snippet-${t.id}`}>
                    Embed snippet for {t.domain}
                  </label>
                  <Textarea
                    id={`snippet-${t.id}`}
                    className="min-h-0 resize-none bg-surface-2 font-mono text-xs"
                    readOnly
                    rows={2}
                    value={shown ? snippet : embedSnippet(window.location.origin, mask(t.token))}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <CopyButton text={snippet} label="Copy snippet" />
                  <Button variant="ghost" size="sm" aria-pressed={shown} onClick={() => toggle(t.id)}>
                    {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />} {shown ? "Hide token" : "Reveal token"}
                  </Button>
                  <a className="ml-auto text-[13px] font-medium text-primary-text hover:underline" href="/settings/widget?tab=install">
                    Install guide and preview
                  </a>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "rotate" ? "Rotate this token?" : `Revoke the token for ${confirm.domain}?`}
          description={confirm.kind === "rotate" ? "The old token stops working immediately. Update the snippet on your site with the new one." : "The widget stops loading on that site immediately."}
          confirmLabel={confirm.kind === "rotate" ? "Rotate token" : "Revoke token"}
          onConfirm={() => (confirm.kind === "rotate" ? rotate : revoke).mutate(confirm.id, { onSuccess: () => toast({ title: confirm.kind === "rotate" ? "Token rotated" : "Token revoked", tone: "success" }) })}
          onClose={() => setConfirm(null)}
        />
      )}
    </SettingsSection>
  );
}
