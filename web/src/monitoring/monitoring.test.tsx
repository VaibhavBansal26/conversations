import { render, screen } from "@testing-library/react";
import { ApiError } from "../lib/apiError";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { captureError, loadRuntimeConfig, resetMonitoringForTests, startMonitoring } from "./index";
import { scrubEvent, scrubString, shouldIgnore } from "./scrub";

const json = (body: unknown, ok = true) => vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

function fakeSdk() {
  const events: any[] = [];
  let beforeSend: any;
  const sdk = {
    init: vi.fn((o: any) => {
      beforeSend = o.beforeSend;
    }),
    dedupeIntegration: () => ({}),
    globalHandlersIntegration: () => ({}),
    withScope: (fn: any) => fn({ setTag: () => {} }),
    captureException: (e: Error) => {
      const out = beforeSend?.({ exception: { values: [{ type: e.name, value: e.message }] }, user: { email: "a@b.co" }, request: { url: "https://x/y?token=abc", headers: { cookie: "c" } }, breadcrumbs: [{ message: "m" }] }, { originalException: e });
      if (out) events.push(out);
    },
    flush: async () => true,
  };
  return { sdk: sdk as never, events };
}

describe("runtime config", () => {
  it("is null when the endpoint says so, fails, or is not JSON", async () => {
    expect(await loadRuntimeConfig(json({ sentry: null }))).toEqual({ sentry: null });
    expect(await loadRuntimeConfig(json({}, false))).toEqual({ sentry: null });
    expect(await loadRuntimeConfig(vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as never)).toEqual({ sentry: null });
    expect(await loadRuntimeConfig(vi.fn(async () => { throw new Error("offline"); }) as never)).toEqual({ sentry: null });
  });
});

describe("startMonitoring", () => {
  beforeEach(() => resetMonitoringForTests());

  it("does not even load the SDK when there is no DSN", async () => {
    const load = vi.fn();
    expect(await startMonitoring({ fetcher: json({ sentry: null }), load: load as never })).toBe(false);
    expect(load).not.toHaveBeenCalled();
    captureError(new Error("dropped")); // queued at most, never sent
  });

  it("loads the SDK with a DSN, reports scrubbed events and ignores expected errors", async () => {
    const { sdk, events } = fakeSdk();
    const ok = await startMonitoring({ fetcher: json({ sentry: { dsn: "https://k@o0.ingest.invalid/1", environment: "t", release: "r", tracesSampleRate: 0.05 } }), load: async () => sdk });
    expect(ok).toBe(true);
    const init = (sdk as any).init.mock.calls[0][0];
    expect(init).toMatchObject({ dsn: "https://k@o0.ingest.invalid/1", maxBreadcrumbs: 0, tracesSampleRate: 0, defaultIntegrations: false });
    expect(JSON.stringify(init)).not.toMatch(/replay/i);
    captureError(new Error("render crash for sam@example.com"));
    captureError(new ApiError(404, "NOT_FOUND", "missing"));
    captureError(new ApiError(0, "NETWORK_ERROR", "offline"));
    captureError(new TypeError("Failed to fetch"));
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events[0]);
    expect(text).not.toMatch(/sam@example\.com|a@b\.co|token=abc|cookie|breadcrumbs/);
    expect(events[0].exception.values[0].value).toContain("render crash");
  });
});

describe("scrubber", () => {
  it("redacts the same patterns as the server", () => {
    const out = scrubString("sam@example.com +14155552671 Bearer abcdefghijklmnop1234 ses_abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123_-");
    expect(out).not.toMatch(/sam@|4155552671|abcdefghijklmnop|eyJhbGci/);
  });
  it("rebuilds events from an allow-list", () => {
    const e = scrubEvent({ user: { email: "a@b.co" }, extra: { content: "hello" }, request: { url: "https://x/y?t=1", data: "secret", method: "GET" }, contexts: { device: {}, runtime: { name: "browser" } }, tags: { area: "react", email: "a@b.co" } } as never) as any;
    expect(e).toEqual({ tags: { area: "react" }, contexts: { runtime: { name: "browser" } }, request: { method: "GET" } });
  });
  it("ignores client errors and network noise", () => {
    expect(shouldIgnore(new ApiError(429, "RATE_LIMITED", "x"))).toBe(true);
    expect(shouldIgnore(new ApiError(500, "INTERNAL", "x"))).toBe(false);
    expect(shouldIgnore(new Error("ResizeObserver loop completed"))).toBe(true);
  });
});

describe("ErrorBoundary", () => {
  it("shows a calm message instead of a blank page", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const Bomb = () => {
      throw new Error("render failed");
    };
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    spy.mockRestore();
  });
});
