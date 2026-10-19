import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createContext } from "./app-context.js";
import { loadConfig } from "./config.js";
import { startScheduler } from "./jobs/scheduler.js";
import { createLogger } from "./logger.js";
import { SocketBus, attachSocketServer } from "./realtime/socket.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const bus = new SocketBus();
const ctx = createContext(config, { log, bus });
const app = createApp(ctx);

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  log.info("conversations server listening", { port: info.port, env: config.NODE_ENV, sms: ctx.sms.name, email: ctx.email.name, ai: ctx.ai.name });
});
const sockets = await attachSocketServer(server as never, ctx, bus);
const stopScheduler = config.SCHEDULER_ENABLED ? startScheduler(ctx) : () => {};

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info("shutting down", { signal });
  stopScheduler();
  await sockets.close();
  await ctx.background.settle();
  ctx.db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
