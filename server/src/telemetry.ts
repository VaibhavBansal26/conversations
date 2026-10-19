import type { Logger } from "./logger.js";

/**
 * Optional OpenTelemetry. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set AND the SDK packages are installed
 * (they are deliberately not dependencies: `npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`).
 * Auto-instrumentation covers HTTP, pg and ioredis spans; request ids in logs already carry the trace-correlation key.
 */
export async function startTelemetry(log: Logger): Promise<() => Promise<void>> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => {};
  try {
    const load = (name: string) => import(/* @vite-ignore */ name) as Promise<any>;
    const [{ NodeSDK }, { getNodeAutoInstrumentations }] = await Promise.all([load("@opentelemetry/sdk-node"), load("@opentelemetry/auto-instrumentations-node")]);
    const sdk = new NodeSDK({ serviceName: process.env.OTEL_SERVICE_NAME ?? "conversations", instrumentations: [getNodeAutoInstrumentations()] });
    sdk.start();
    log.info("opentelemetry started", { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT });
    return () => sdk.shutdown();
  } catch (e) {
    log.warn("OTEL_EXPORTER_OTLP_ENDPOINT is set but the OpenTelemetry packages are not installed; tracing disabled", { error: String(e) });
    return async () => {};
  }
}
