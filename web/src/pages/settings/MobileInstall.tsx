import { useQuery } from "@tanstack/react-query";
import { KeyRound, Smartphone } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useListMutation } from "../../api/settingsHooks";
import type { EmbedToken, IdentityStatus } from "../../api/types";
import { CopyButton } from "../../components/settings/CopyButton";
import { formatDateTime } from "../../lib/time";
import { keys } from "../../state/keys";
import { Badge, Button, ErrorNotice, Skeleton, Switch } from "../../ui";

/** The address a native app opens in its web view (or an iframe on a site): the hosted full-page chat for one token. */
export const hostedChatUrl = (publicUrl: string, token: string): string => `${publicUrl.replace(/\/$/, "")}/chat?token=${token}`;

/** Mobile and web-view install: switch the hosted chat on for the chosen token, copy its URL, and manage identity verification. */
export function MobileInstall({ token, publicUrl }: { token: EmbedToken; publicUrl: string }) {
  const enabled = !!token.hosted_chat_enabled;
  const toggle = useListMutation((on: boolean) => api.patch<EmbedToken>(`/tokens/${token.id}`, { hosted_chat_enabled: on }), keys.tokens);
  const url = hostedChatUrl(publicUrl, token.token);
  return (
    <section className="flex flex-col gap-3" aria-label="Mobile apps and web views">
      <h3 className="flex items-center gap-2.5 text-[15px] font-semibold">
        <Smartphone className="size-5 text-subtle" aria-hidden="true" /> Mobile apps and web views
      </h3>
      <p className="text-[13px] text-muted-foreground">
        Open the hosted chat in an in-app web view (iOS, Android, React Native, Flutter) or an iframe. It uses the same settings as the widget and is switched off until you turn it on for this token.
      </p>
      <Switch
        label="Hosted chat for this token"
        hint="Lets the chat page served by this app (not another site) use the token. The website domain rule above is not changed."
        checked={enabled}
        disabled={toggle.isPending}
        onChange={(on) => toggle.mutate(on)}
      />
      {toggle.isError && <ErrorNotice error={toggle.error} compact />}
      {enabled && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">Chat URL</span>
            <CopyButton text={url} label="Copy URL" />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all bg-surface p-3 font-mono text-[12px] leading-relaxed" tabIndex={0} aria-label="Hosted chat URL">
            <code data-testid="hosted-url">{url}</code>
          </pre>
        </div>
      )}
      <p className="text-[13px] text-muted-foreground">
        Optional parameters: <code className="font-mono text-xs">name, email, phone, external_id, identity_hash, locale, theme, primary_color, bridge, safe_area</code>. Guide: <code className="font-mono text-xs">docs/MOBILE-BRIDGE.md</code>. Test the bridge at{" "}
        <a className="font-medium text-primary-text underline underline-offset-2" href={`${publicUrl.replace(/\/$/, "")}/chat/bridge-test?token=${token.token}`} target="_blank" rel="noreferrer">
          /chat/bridge-test
        </a>
        .
      </p>
      <IdentityVerification />
    </section>
  );
}

function IdentityVerification() {
  const status = useQuery({ queryKey: keys.identity, queryFn: () => api.get<IdentityStatus>("/identity") });
  const [secret, setSecret] = useState<string | null>(null);
  const rotate = useListMutation(() => api.post<{ secret: string }>("/identity/rotate"), keys.identity);
  const enforce = useListMutation((on: boolean) => api.patch<IdentityStatus>("/identity", { enforce: on }), keys.identity);
  if (status.isPending) return <Skeleton className="h-24" />;
  if (status.isError) return <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound className="size-5 text-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Identity verification {s.configured ? <Badge tone="success">Secret set</Badge> : <Badge tone="neutral">Not set up</Badge>}</p>
          <p className="text-[13px] text-muted-foreground">
            Your backend signs the signed-in user's id and email with a secret; visitors without a valid signature cannot take over a known customer's history.
            {s.rotated_at ? ` Created ${formatDateTime(s.rotated_at)}.` : ""}
          </p>
        </div>
        <Button
          variant="outline"
          loading={rotate.isPending}
          onClick={() =>
            rotate.mutate(undefined, {
              onSuccess: (r) => setSecret((r as { secret: string }).secret),
            })
          }
        >
          {s.configured ? "Replace secret" : "Create secret"}
        </Button>
      </div>
      {secret && (
        <div role="status" className="rounded-lg border border-warning-border bg-warning-soft p-3 text-[13px] text-warning-text">
          <p className="font-medium">Copy the secret now. It is shown once and cannot be read again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all font-mono text-xs" data-testid="identity-secret">
              {secret}
            </code>
            <CopyButton text={secret} label="Copy secret" />
          </div>
          <p className="mt-2">Keep it on your server. Never put it in an app or web page.</p>
        </div>
      )}
      {s.configured && (
        <Switch
          label="Ignore unsigned identity"
          hint="When on, names, emails and phone numbers that arrive without a valid signature are ignored and the visitor stays anonymous."
          checked={s.enforce}
          disabled={enforce.isPending}
          onChange={(on) => enforce.mutate(on)}
        />
      )}
      {(rotate.isError || enforce.isError) && <ErrorNotice error={(rotate.error ?? enforce.error)!} compact />}
    </div>
  );
}
