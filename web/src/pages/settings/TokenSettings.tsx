import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useListMutation, useTokens } from "../../api/settingsHooks";
import { CopyButton } from "../../components/settings/CopyButton";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";
import { LoadingBlock } from "../../components/ui/Spinner";
import { formatDateTime } from "../../lib/time";
import { keys } from "../../state/keys";

export const embedSnippet = (origin: string, token: string): string => `<script src="${origin}/widget.js" data-token="${token}" async></script>`;

export function TokenSettings() {
  const tokens = useTokens();
  const [domain, setDomain] = useState("");
  const create = useListMutation((d: string) => api.post("/tokens", { domain: d }), keys.tokens);
  const rotate = useListMutation((id: string) => api.post(`/tokens/${id}/rotate`), keys.tokens);
  const revoke = useListMutation((id: string) => api.delete(`/tokens/${id}`), keys.tokens);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(domain.trim(), { onSuccess: () => setDomain("") });
  };

  return (
    <SettingsSection title="Embed tokens" description="One token per website. The widget only works on the domain its token was issued for.">
      <form className="row end" onSubmit={submit}>
        <Field label="Website domain" hint="For example www.example.com">
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.example.com" required />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !domain.trim()}>
          Create token
        </button>
      </form>
      {(create.isError || rotate.isError || revoke.isError) && <ErrorNotice error={create.error ?? rotate.error ?? revoke.error} />}
      {tokens.isPending && <LoadingBlock label="Loading tokens" />}
      {tokens.isError && <ErrorNotice error={tokens.error} onRetry={() => void tokens.refetch()} />}
      {tokens.data?.length === 0 && <EmptyState title="No tokens yet" hint="Create a token to embed the chat widget on a website." />}
      <ul className="card-list">
        {tokens.data?.map((t) => {
          const snippet = embedSnippet(window.location.origin, t.token);
          return (
            <li key={t.id} className="card column">
              <div className="row between">
                <div>
                  <strong>{t.domain}</strong>
                  <p className="muted">
                    {t.status} · created {formatDateTime(t.created_at)}
                    {t.last_used_at ? ` · last used ${formatDateTime(t.last_used_at)}` : " · never used"}
                  </p>
                </div>
                <div className="row">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => window.confirm("Rotate this token? The old one stops working immediately.") && rotate.mutate(t.id)}>
                    Rotate
                  </button>
                  <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => window.confirm(`Revoke the token for ${t.domain}?`) && revoke.mutate(t.id)}>
                    Revoke
                  </button>
                </div>
              </div>
              <label className="sr-only" htmlFor={`snippet-${t.id}`}>
                Embed snippet for {t.domain}
              </label>
              <textarea id={`snippet-${t.id}`} className="code" readOnly rows={2} value={snippet} onFocus={(e) => e.currentTarget.select()} />
              <div className="row">
                <CopyButton text={snippet} label="Copy snippet" />
                <a className="btn btn-ghost btn-sm" href="/widget-demo.html" target="_blank" rel="noopener noreferrer">
                  Open widget demo
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
