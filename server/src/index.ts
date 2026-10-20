import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { closeContext, createContext } from "./app-context.js";
import { loadConfig } from "./config.js";
import { startOutbox } from "./events/outbox.js";
import { startScheduler } from "./jobs/scheduler.js";
import { createLogger } from "./logger.js";
import { startTelemetry } from "./telemetry.js";
import { SocketBus, attachSocketServer } from "./realtime/socket.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const stopTelemetry = await startTelemetry(log);
const bus = new SocketBus();
const ctx = await createContext(config, { log, bus });
const app = createApp(ctx);
if (config.RATE_LIMIT_SCALE !== 1) log.warn("RATE_LIMIT_SCALE is not 1: every rate limit is multiplied. Load testing only.", { scale: config.RATE_LIMIT_SCALE });

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  log.info("conversations server listening", {
    port: info.port,
    node: ctx.nodeId,
    env: config.NODE_ENV,
    db: ctx.db.dialect,
    redis: !!ctx.redis,
    queue: ctx.queue.kind,
    sms: ctx.sms.name,
    email: ctx.email.name,
    ai: ctx.ai.name,
  });
});
// keep-alive above typical load-balancer idle timeouts so the proxy, not this node, decides when to close idle connections
(server as import("node:http").Server).keepAliveTimeout = 65_000;
(server as import("node:http").Server).headersTimeout = 66_000;
const sockets = await attachSocketServer(server as never, ctx, bus);
const stopScheduler = config.SCHEDULER_ENABLED ? await startScheduler(ctx) : () => {};
const outbox = config.SCHEDULER_ENABLED ? await startOutbox(ctx) : null;

let closing = false;
/**
 * Graceful shutdown: flip readiness to 503 (the load balancer stops routing here), stop accepting new sockets, tell connected clients to
 * reconnect with jitter, let in-flight requests finish, flush coalesced events and background work, then close dependencies.
 */
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info("draining", { signal, node: ctx.nodeId, ...sockets.stats() });
  ctx.state.draining = true;
  stopScheduler();
  await outbox?.stop();
  await sockets.drain(config.WS_DRAIN_MS);
  await new Promise<void>((resolve) => (server as import("node:http").Server).close(() => resolve()));
  await sockets.close();
  await closeContext(ctx);
  await stopTelemetry().catch(() => {});
  log.info("shutdown complete", { node: ctx.nodeId });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// force-exit if something hangs, so orchestrators never wait for the kill timeout
process.on("SIGTERM", () => setTimeout(() => process.exit(1), config.WS_DRAIN_MS + 15_000).unref());
