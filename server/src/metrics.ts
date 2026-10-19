import { monitorEventLoopDelay } from "node:perf_hooks";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { AppContext } from "./context.js";

const BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

/**
 * Prometheus metrics. Label cardinality is bounded by construction: HTTP uses the matched route pattern (never the raw path),
 * socket events use the fixed protocol event names, results are a closed set. Ids never become labels.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly http = new Histogram({ name: "conv_http_request_duration_seconds", help: "HTTP request latency", labelNames: ["method", "route", "status"], buckets: BUCKETS, registers: [this.registry] });
  readonly wsConnections = new Gauge({ name: "conv_ws_connections", help: "Open Socket.IO connections on this node", labelNames: ["kind"], registers: [this.registry] });
  readonly wsConnects = new Counter({ name: "conv_ws_connect_total", help: "Connection attempts by outcome", labelNames: ["kind", "result"], registers: [this.registry] });
  readonly wsEvents = new Counter({ name: "conv_ws_events_total", help: "Client events handled", labelNames: ["event", "result"], registers: [this.registry] });
  readonly wsAck = new Histogram({ name: "conv_ws_ack_duration_seconds", help: "Time from event receipt to ack", labelNames: ["event"], buckets: BUCKETS, registers: [this.registry] });
  readonly wsFanout = new Histogram({ name: "conv_ws_fanout_duration_seconds", help: "Time spent handing a broadcast to the adapter", buckets: BUCKETS, registers: [this.registry] });
  readonly wsEmits = new Counter({ name: "conv_ws_emits_total", help: "Broadcasts issued by the server", labelNames: ["event"], registers: [this.registry] });
  readonly slowConsumers = new Counter({ name: "conv_ws_slow_consumer_disconnects_total", help: "Sockets dropped because their outbound queue overflowed", registers: [this.registry] });
  readonly wsWriteBufferMax = new Gauge({ name: "conv_ws_write_buffer_max", help: "Largest per-socket outbound queue at the last sweep", registers: [this.registry] });
  readonly queueDepth = new Gauge({ name: "conv_queue_depth", help: "Background jobs by state", labelNames: ["state"], registers: [this.registry] });
  readonly eventLoopP99 = new Gauge({ name: "conv_event_loop_lag_p99_seconds", help: "Event loop delay p99 over the last scrape window", registers: [this.registry] });
  readonly dbStatements = new Gauge({ name: "conv_db_statements_total", help: "SQL statements executed by this node", registers: [this.registry] });
  readonly background = new Gauge({ name: "conv_background_tasks", help: "Fire-and-forget tasks in flight", registers: [this.registry] });
  readonly rateLimited = new Counter({ name: "conv_rate_limited_total", help: "Requests/events rejected by a rate limit", labelNames: ["scope"], registers: [this.registry] });
  readonly rlDecisions = new Counter({ name: "conv_ratelimit_decisions_total", help: "Rate-limit decisions by policy and outcome", labelNames: ["policy", "outcome"], registers: [this.registry] });
  readonly rlRedis = new Histogram({ name: "conv_ratelimit_redis_duration_seconds", help: "Latency of rate-limit Redis calls", labelNames: ["ok"], buckets: [0.0002, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.03], registers: [this.registry] });
  readonly rlLease = new Counter({ name: "conv_ratelimit_lease_total", help: "Local lease tier results (hit = served without Redis)", labelNames: ["result"], registers: [this.registry] });
  readonly rlBreaker = new Gauge({ name: "conv_ratelimit_breaker_open", help: "1 while the rate-limit Redis circuit breaker is open", registers: [this.registry] });
  readonly rlPenaltyBox = new Gauge({ name: "conv_ratelimit_penalty_box_size", help: "Keys currently blocked by an escalating penalty", registers: [this.registry] });
  readonly wsShed = new Counter({ name: "conv_ws_shed_total", help: "Handshakes refused by admission control", labelNames: ["reason"], registers: [this.registry] });
  readonly wsStrikes = new Counter({ name: "conv_ws_strikes_total", help: "Socket events dropped for rate and strikes issued", labelNames: ["result"], registers: [this.registry] });
  private readonly loop = monitorEventLoopDelay({ resolution: 10 });

  constructor(defaults = true) {
    if (defaults) collectDefaultMetrics({ register: this.registry });
    this.loop.enable();
  }

  /** Wire gauges that need the live context; called by the /metrics handler before rendering. */
  async refresh(ctx: AppContext): Promise<void> {
    this.eventLoopP99.set(this.loop.percentile(99) / 1e9);
    this.loop.reset();
    this.dbStatements.set(ctx.db.statements);
    this.background.set(ctx.background.size);
    if (ctx.config.NODE_ENV !== "test") void ctx.ratelimit.shared.penaltyBoxSize().then((n) => this.rlPenaltyBox.set(n), () => {});
    const d = await ctx.queue.depth().catch(() => null);
    if (d) for (const [k, v] of Object.entries(d)) this.queueDepth.set({ state: k }, v);
  }

  async render(ctx: AppContext): Promise<string> {
    await this.refresh(ctx);
    return this.registry.metrics();
  }

  close() {
    this.loop.disable();
    this.registry.clear();
  }
}
