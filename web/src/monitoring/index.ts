import { scrubEvent, scrubPath, shouldIgnore } from "./scrub";

/**
 * Optional browser error monitoring. The Sentry SDK is a separate lazy chunk that is only downloaded when the server's
 * `/runtime-config.json` carries a DSN, so an unconfigured install loads nothing extra and the initial bundle is unchanged.
 * No session replay, no breadcrumbs, no request data, no message text: events are rebuilt from an allow-list (see ./scrub).
 */
export interface RuntimeConfig {
  sentry: { dsn: string; environment: string; release: string | null; tracesSampleRate: number } | null;
}

type Sdk = typeof import("@sentry/react");
let sdk: Sdk | null = null;
const queue: unknown[] = [];

export async function loadRuntimeConfig(fetcher: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const r = await fetcher("/runtime-config.json", { cache: "no-store", credentials: "omit" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return { sentry: null };
    const body = (await r.json()) as RuntimeConfig;
    return body && typeof body === "object" && body.sentry && typeof body.sentry.dsn === "string" ? body : { sentry: null };
  } catch {
    return { sentry: null };
  }
}

export interface StartOptions {
  fetcher?: typeof fetch;
  /** tests swap the SDK loader and transport */
  load?: () => Promise<Sdk>;
  transport?: unknown;
}

export async function startMonitoring(o: StartOptions = {}): Promise<boolean> {
  if (sdk) return true;
  const cfg = (await loadRuntimeConfig(o.fetcher)).sentry;
  if (!cfg) return false;
  try {
    const Sentry = await (o.load ?? (() => import("@sentry/react")))();
    Sentry.init({
      dsn: cfg.dsn,
      environment: cfg.environment,
      release: cfg.release ?? undefined,
      tracesSampleRate: 0,
      ...({ sendDefaultPii: false } as object),
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false, frameContextLines: 0 },
      maxBreadcrumbs: 0,
      defaultIntegrations: false, // no breadcrumbs, no replay, no browser tracing: only global error and rejection handlers below
      integrations: [Sentry.dedupeIntegration(), Sentry.globalHandlersIntegration({ onerror: true, onunhandledrejection: true })],
      beforeSend: (event, hint) => {
        if (shouldIgnore(hint?.originalException)) return null;
        const out = scrubEvent(event as never) as Record<string, unknown> | null;
        if (out) out.transaction = scrubPath(window.location.pathname); // the screen, never ids or query strings
        return out as never;
      },
      beforeBreadcrumb: () => null,
      ...(o.transport ? { transport: o.transport as never } : {}),
    });
    sdk = Sentry;
    for (const e of queue.splice(0)) captureError(e);
    return true;
  } catch {
    return false;
  }
}

/** Report a caught error (error boundary). Before the SDK is ready it is queued; with monitoring off it is dropped. */
export function captureError(err: unknown, area = "react"): void {
  if (shouldIgnore(err)) return;
  if (!sdk) {
    if (queue.length < 20) queue.push(err);
    return;
  }
  try {
    sdk.withScope((scope) => {
      scope.setTag("area", area);
      sdk!.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch {
    /* never break the UI */
  }
}

export async function flushMonitoring(timeoutMs = 2000): Promise<boolean> {
  return sdk ? sdk.flush(timeoutMs).catch(() => false) : true;
}

/** tests */
export function resetMonitoringForTests(): void {
  sdk = null;
  queue.length = 0;
}
