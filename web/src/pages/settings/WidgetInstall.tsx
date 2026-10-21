import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Globe, Loader2, Play, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useListMutation, useTokens } from "../../api/settingsHooks";
import type { EmbedToken } from "../../api/types";
import { useSession } from "../../auth/AuthContext";
import { CopyButton } from "../../components/settings/CopyButton";
import { formatDateTime } from "../../lib/time";
import { MobileInstall } from "./MobileInstall";
import { keys } from "../../state/keys";
import { Badge, Button, cn, ErrorNotice, Field, Input, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, toast } from "../../ui";

export const embedTag = (publicUrl: string, token: string): string => `<script src="${publicUrl}/widget.js" data-token="${token}" async></script>`;

interface Platform {
  id: string;
  label: string;
  steps: string[];
  code: (url: string, token: string) => string;
  codeLabel: string;
}

/** Install instructions per platform. The snippet always carries the real address of this deployment and the chosen token. */
export const PLATFORMS: Platform[] = [
  {
    id: "html",
    label: "Plain HTML",
    steps: ["Open the HTML file (or template) shared by every page of your site.", "Paste the code just before the closing </body> tag.", "Publish. The chat button appears in the corner of every page."],
    codeLabel: "HTML",
    code: embedTag,
  },
  {
    id: "wordpress",
    label: "WordPress",
    steps: [
      "Easiest: install a header and footer scripts plugin (for example WPCode), add a new snippet of type HTML, paste the code, set the location to Site Wide Footer and activate it.",
      "Or add the PHP below to your child theme's functions.php (not the parent theme: updates overwrite it).",
    ],
    codeLabel: "functions.php",
    code: (url, token) => `add_action('wp_footer', function () {\n  echo '${embedTag(url, token)}';\n});`,
  },
  {
    id: "shopify",
    label: "Shopify",
    steps: [
      "In the Shopify admin open Online Store, then Themes.",
      "On your live theme choose the three dots, then Edit code.",
      "Open layout/theme.liquid and paste the code just before </body>. Save.",
    ],
    codeLabel: "theme.liquid",
    code: embedTag,
  },
  {
    id: "gtm",
    label: "Google Tag Manager",
    steps: ["In your container choose Tags, New, then the Custom HTML tag type.", "Paste the code. Under Triggering choose All Pages.", "Submit and publish the container. Preview mode in GTM does not publish it for visitors."],
    codeLabel: "Custom HTML tag",
    code: embedTag,
  },
  {
    id: "react",
    label: "React / Next.js",
    steps: [
      "Next.js (App Router): render the Script component once, in your root layout.",
      "Plain React: add the script once when the app mounts, as in the second snippet. Do not render it on every route change.",
    ],
    codeLabel: "layout.tsx / App.tsx",
    code: (url, token) =>
      `// Next.js: app/layout.tsx\nimport Script from "next/script";\n// inside <body>:\n<Script src="${url}/widget.js" data-token="${token}" strategy="afterInteractive" />\n\n// Plain React: App.tsx\nuseEffect(() => {\n  const s = document.createElement("script");\n  s.src = "${url}/widget.js";\n  s.async = true;\n  s.dataset.token = "${token}";\n  document.body.appendChild(s);\n  return () => { s.remove(); document.getElementById("conversations-widget-host")?.remove(); };\n}, []);`,
  },
];

function StepHeading({ n, title, done }: { n: number; title: string; done?: boolean }) {
  return (
    <h3 className="flex items-center gap-2.5 text-[15px] font-semibold">
      <span className={cn("grid size-6 place-items-center rounded-full text-xs font-bold", done ? "bg-success text-white" : "bg-primary-soft text-primary-text")} aria-hidden="true">
        {done ? <CheckCircle2 className="size-4" /> : n}
      </span>
      {title}
    </h3>
  );
}

/** Step 1: pick (or create inline) the token of the website the widget will live on. */
function ChooseSite({ tokens, selected, onSelect }: { tokens: EmbedToken[]; selected: string | null; onSelect: (id: string) => void }) {
  const [domain, setDomain] = useState("");
  const create = useListMutation((d: string) => api.post<EmbedToken>("/tokens", { domain: d }), keys.tokens);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(domain.trim(), {
      onSuccess: (t) => {
        setDomain("");
        onSelect((t as EmbedToken).id);
        toast({ title: "Token created", description: `The widget will work on ${(t as EmbedToken).domain}`, tone: "success" });
      },
    });
  };
  return (
    <div className="flex flex-col gap-3">
      {!!tokens.length && (
        <div role="radiogroup" aria-label="Website" className="flex flex-col gap-2">
          {tokens.map((t) => (
            <label key={t.id} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm", selected === t.id ? "border-primary bg-primary-soft/50" : "border-border hover:bg-surface-2")}>
              <input type="radio" name="site" className="size-4 accent-[var(--color-primary)]" checked={selected === t.id} onChange={() => onSelect(t.id)} />
              <Globe className="size-4 text-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium">{t.domain}</span>
              {t.last_seen_at ? <Badge tone="success">Seen live</Badge> : <Badge tone="neutral">Not seen yet</Badge>}
            </label>
          ))}
        </div>
      )}
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit} aria-label="Add a website">
        <Field
          label={tokens.length ? "Add another website" : "Your website's domain"}
          hint="The token only works on the domain you enter. Add www.example.com and example.com separately, or use *.example.com for every subdomain."
          className="min-w-64 max-w-lg flex-1"
        >
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.example.com" required />
        </Field>
        <Button type="submit" variant={tokens.length ? "outline" : "primary"} loading={create.isPending} disabled={!domain.trim()} className="mb-[22px]">
          <Plus aria-hidden="true" /> Create token
        </Button>
      </form>
      {create.isError && <ErrorNotice error={create.error} />}
    </div>
  );
}

function TryItNow({ token }: { token: EmbedToken }) {
  const [url, setUrl] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: async () => {
      // open the tab inside the click (popup blockers allow that), then point it at the signed link
      const tab = window.open("", "_blank");
      try {
        const r = await api.post<{ url: string }>(`/tokens/${token.id}/preview`);
        if (tab) tab.location.href = r.url;
        else setUrl(r.url);
        return r;
      } catch (e) {
        tab?.close();
        throw e;
      }
    },
  });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Not ready to edit your site? Try it here first.</p>
          <p className="text-[13px] text-muted-foreground">Opens a page of this app with your real widget. Chat as a visitor there, then reply as an agent in the Inbox tab.</p>
        </div>
        <Button variant="outline" onClick={() => open.mutate()} loading={open.isPending}>
          <Play aria-hidden="true" /> Try it now
        </Button>
      </div>
      {url && (
        <a className="text-[13px] font-medium text-primary-text underline underline-offset-2" href={url} target="_blank" rel="noreferrer">
          Your browser blocked the new tab: open the preview <ExternalLink className="inline size-3" aria-hidden="true" />
        </a>
      )}
      {open.isError && <ErrorNotice error={open.error} compact />}
    </div>
  );
}

/** Step 3: watch for the widget's first config request from the site. */
function Verify({ token }: { token: EmbedToken }) {
  const qc = useQueryClient();
  const seen = !!token.last_seen_at;
  const check = useQuery({
    queryKey: [...keys.tokens, "watch", token.id],
    queryFn: async () => {
      await qc.invalidateQueries({ queryKey: keys.tokens });
      return Date.now();
    },
    enabled: !seen,
    refetchInterval: seen ? false : 3000,
  });
  if (seen) {
    return (
      <div role="status" data-testid="install-verified" className="flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-success-soft px-4 py-3 text-sm text-success-text">
        <CheckCircle2 className="size-5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          <strong>Installed.</strong> The widget loaded on <strong>{token.last_seen_origin}</strong> at {formatDateTime(token.last_seen_at!)}.
        </p>
      </div>
    );
  }
  return (
    <div role="status" data-testid="install-waiting" className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-sm text-muted-foreground">
      <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Waiting for the widget to load on {token.domain.startsWith("*.") ? "a site under " : ""}
        <strong className="text-foreground">{token.domain}</strong>... Publish the change and open a page of your site; this turns green by itself.
      </p>
      <Button variant="ghost" size="sm" onClick={() => void check.refetch()}>
        Check now
      </Button>
    </div>
  );
}

export function WidgetInstall() {
  const { workspace } = useSession();
  const tokens = useTokens();
  const [picked, setPicked] = useState<string | null>(null);
  const publicUrl = workspace.public_url ?? window.location.origin;
  const list = tokens.data ?? [];
  const selected = list.find((t) => t.id === (picked ?? list[0]?.id)) ?? null;
  return (
    <div className="flex max-w-3xl flex-col gap-7">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Install the chat widget</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">Three steps: choose your website, add one line of code, and see it come alive.</p>
      </div>
      {tokens.isPending && <Skeleton className="h-40" />}
      {tokens.isError && <ErrorNotice error={tokens.error} onRetry={() => void tokens.refetch()} />}
      {tokens.data && (
        <>
          <section className="flex flex-col gap-3" aria-label="Step 1: choose your website">
            <StepHeading n={1} title="Choose your website" done={!!selected} />
            <ChooseSite tokens={list} selected={selected?.id ?? null} onSelect={setPicked} />
          </section>
          {selected && (
            <>
              <section className="flex flex-col gap-3" aria-label="Step 2: add the code">
                <StepHeading n={2} title="Add the code to your site" />
                <Tabs defaultValue="html">
                  <TabsList aria-label="Platform" className="flex-wrap">
                    {PLATFORMS.map((p) => (
                      <TabsTrigger key={p.id} value={p.id}>
                        {p.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {PLATFORMS.map((p) => {
                    const code = p.code(publicUrl, selected.token);
                    return (
                      <TabsContent key={p.id} value={p.id} className="mt-3 flex flex-col gap-3">
                        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
                          {p.steps.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ol>
                        <div className="overflow-hidden rounded-lg border border-border">
                          <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5">
                            <span className="text-xs font-medium text-muted-foreground">{p.codeLabel}</span>
                            <CopyButton text={code} label="Copy code" />
                          </div>
                          <pre className="overflow-x-auto whitespace-pre-wrap break-all bg-surface p-3 font-mono text-[12px] leading-relaxed" tabIndex={0} aria-label={`${p.label} code`}>
                            <code data-testid="snippet">{code}</code>
                          </pre>
                        </div>
                      </TabsContent>
                    );
                  })}
                </Tabs>
                <details className="rounded-lg border border-border px-4 py-3 text-[13px] text-muted-foreground">
                  <summary className="cursor-pointer font-medium text-foreground">Does your site use a Content-Security-Policy?</summary>
                  <p className="mt-2">
                    Allow this address in <code className="font-mono text-xs">script-src</code> (the widget script), <code className="font-mono text-xs">connect-src</code> (API and WebSocket: add both{" "}
                    <code className="font-mono text-xs">{publicUrl}</code> and <code className="font-mono text-xs">{publicUrl.replace(/^http/, "ws")}</code>), and nothing else is needed: the widget draws inside a shadow root and loads no fonts or images from elsewhere.
                  </p>
                </details>
              </section>
              <section className="flex flex-col gap-3" aria-label="Step 3: verify">
                <StepHeading n={3} title="Check that it works" done={!!selected.last_seen_at} />
                <Verify token={selected} />
                <TryItNow token={selected} />
              </section>
              <MobileInstall token={selected} publicUrl={publicUrl} />
            </>
          )}
        </>
      )}
    </div>
  );
}
