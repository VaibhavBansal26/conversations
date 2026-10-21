import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { ALLOWED_TAGS, hashId, scrubEvent, shouldIgnore } from "./scrub.js";

export interface CaptureTags {
  route?: string;
  method?: string;
  status?: number;
  request_id?: string;
  socket_id?: string;
  /** raw workspace id: hashed here, never sent as is */
  workspace_id?: string;
  plan?: string;
  event?: string;
  job_type?: string;
  area?: "http" | "socket" | "job" | "background" | "process" | "test";
}

/** What the rest of the server sees. The no-op implementation is the default, so unconfigured installs pay nothing. */
export interface Monitor {
  readonly enabled: boolean;
  capture(err: unknown, tags?: CaptureTags): void;
  /** wait for queued events to be delivered (graceful shutdown); resolves false on timeout */
  flush(timeoutMs?: number): Promise<boolean>;
  /** start a sampled performance transaction for one request; `finish` names it by route PATTERN. No-op unless tracing is on. */
  beginRequest(method: string): { finish(route: string, status: number): void };
  /** resolves once initialisation finished (tests) */
  ready(): Promise<void>;
}

const NOOP_SPAN = { finish: () => {} };

export const noopMonitor: Monitor = {
  enabled: false,
  capture: () => {},
  flush: async () => true,
  beginRequest: () => NOOP_SPAN,
  ready: async () => {},
};

export interface MonitorOptions {
  /** tests inject a fake Sentry transport so nothing touches the network */
  transport?: unknown;
}

/** Sentry DSNs look like https://<key>@<host>/<project>. Anything else is rejected before the SDK sees it. */
export function validDsn(dsn: string | undefined): dsn is string {
  if (!dsn) return false;
  try {
    const u = new URL(dsn);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.username && /^\/(?:.+\/)?\d+$/.test(u.pathname);
  } catch {
    return false;
  }
}

export function resolveRelease(config: Pick<Config, "SENTRY_RELEASE">): string | undefined {
  return config.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || undefined;
}

/**
 * Create the monitor. With no (or an invalid) SENTRY_DSN this returns the no-op and `@sentry/node` is never even imported.
 * Initialisation is asynchronous (dynamic import) but `capture` is safe to call at any time: events raised before it finishes are queued.
 */
export function createMonitor(config: Config, log: Logger, opts: MonitorOptions = {}): Monitor {
  if (!config.SENTRY_DSN) return noopMonitor;
  if (!validDsn(config.SENTRY_DSN)) {
    log.warn("SENTRY_DSN is set but is not a valid DSN; error monitoring is disabled");
    return noopMonitor;
  }
  let sdk: typeof import("@sentry/node") | null = null;
  const queue: [unknown, CaptureTags | undefined][] = [];
  const salt = config.JWT_SECRET;
  const send = (err: unknown, t?: CaptureTags) => {
    if (!sdk) return;
    try {
      sdk.withScope((scope) => {
        const tags: Record<string, string> = {};
        if (t?.route) tags.route = t.route;
        if (t?.method) tags.method = t.method;
        if (t?.status) tags.status = String(t.status);
        if (t?.request_id) tags.request_id = t.request_id;
        if (t?.socket_id) tags.socket_id = t.socket_id;
        if (t?.workspace_id) tags.workspace = hashId(salt, t.workspace_id);
        if (t?.plan) tags.plan = t.plan;
        if (t?.event) tags.event = t.event;
        if (t?.job_type) tags.job_type = t.job_type;
        if (t?.area) tags.area = t.area;
        for (const k of Object.keys(tags)) if (!ALLOWED_TAGS.has(k)) delete tags[k];
        scope.setTags(tags);
        sdk!.captureException(err instanceof Error ? err : new Error(String(err)));
      });
    } catch {
      /* monitoring must never break the request path */
    }
  };
  const initialised = (async () => {
    try {
      const Sentry = await import("@sentry/node");
      Sentry.init({
        dsn: config.SENTRY_DSN,
        environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV,
        release: resolveRelease(config),
        tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
        // belt and braces: the allow-list scrubber below is the real guarantee, these stop the SDK collecting in the first place
        ...({ sendDefaultPii: false } as object),
        dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false } },
        traceLifecycle: "static", // transactions go through beforeSendTransaction (the default "stream" lifecycle would bypass it)
        maxBreadcrumbs: 0,
        attachStacktrace: true,
        defaultIntegrations: false, // only what is listed below: no http/console/breadcrumb integrations that observe request data
        integrations: [Sentry.dedupeIntegration(), Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false }), Sentry.onUnhandledRejectionIntegration({ mode: "warn" })],
        beforeSend: (event, hint) => (shouldIgnore(hint?.originalException) ? null : (scrubEvent(event as never) as never)),
        beforeSendTransaction: (event) => scrubEvent(event as never) as never,
        beforeBreadcrumb: () => null,
        ...(opts.transport ? { transport: opts.transport as never } : {}),
      });
      sdk = Sentry;
      log.info("error monitoring enabled", { environment: config.SENTRY_ENVIRONMENT || config.NODE_ENV, release: resolveRelease(config) ?? null });
      for (const [e, t] of queue.splice(0)) send(e, t);
    } catch (e) {
      log.warn("error monitoring failed to start and is disabled", { error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return {
    enabled: true,
    capture(err, t) {
      if (shouldIgnore(err)) return;
      if (sdk) send(err, t);
      else if (queue.length < 50) queue.push([err, t]);
    },
    async flush(timeoutMs = 2000) {
      await initialised;
      if (!sdk) return true;
      try {
        return await sdk.flush(timeoutMs);
      } catch {
        return false;
      }
    },
    beginRequest(method) {
      if (!sdk || config.SENTRY_TRACES_SAMPLE_RATE <= 0) return NOOP_SPAN;
      try {
        const span = sdk.startInactiveSpan({ name: `${method} (pending)`, op: "http.server", forceTransaction: true });
        return {
          finish(route, status) {
            try {
              span.updateName(`${method} ${route}`);
              span.setAttribute("http.response.status_code", status);
              span.end();
            } catch {
              /* ignore */
            }
          },
        };
      } catch {
        return NOOP_SPAN;
      }
    },
    ready: () => initialised,
  };
}
