import { resolve } from "node:path";
import { createAiProvider, type AiProvider } from "./ai/provider.js";
import type { Config } from "./config.js";
import { BackgroundTracker, type AppContext } from "./context.js";
import { migrate, openDb } from "./db/index.js";
import { createLogger, type Logger } from "./logger.js";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "./providers/fake.js";
import { LocalDiskStorage } from "./providers/storage.js";
import { SendGridEmailProvider } from "./providers/sendgrid.js";
import { TwilioSmsProvider } from "./providers/twilio.js";
import type { EmailProvider, SmsProvider, Storage } from "./providers/types.js";
import { RecordingBus, type RealtimeBus } from "./realtime/bus.js";
import { Presence } from "./realtime/presence.js";
import { memberScope } from "./services/members.js";

export interface ContextOverrides {
  log?: Logger;
  bus?: RealtimeBus;
  sms?: SmsProvider;
  email?: EmailProvider;
  storage?: Storage;
  ai?: AiProvider;
  clock?: () => Date;
  presence?: Presence;
}

/** Wires config -> concrete providers. Anything can be overridden (tests inject fakes; index.ts injects the SocketBus). */
export function createContext(config: Config, o: ContextOverrides = {}): AppContext {
  const log = o.log ?? createLogger(config.LOG_LEVEL);
  const db = openDb(config.DATABASE_PATH);
  migrate(db);
  const bus = o.bus ?? new RecordingBus();
  const ctx: AppContext = {
    config,
    db,
    log,
    clock: o.clock ?? (() => new Date()),
    bus,
    presence: undefined as never,
    sms: o.sms ?? (config.SMS_PROVIDER === "twilio" ? new TwilioSmsProvider(config.TWILIO_ACCOUNT_SID!, config.TWILIO_AUTH_TOKEN!) : new ConsoleSmsProvider(log)),
    email: o.email ?? (config.EMAIL_PROVIDER === "sendgrid" ? new SendGridEmailProvider(config.SENDGRID_API_KEY!) : new ConsoleEmailProvider(log)),
    storage: o.storage ?? new LocalDiskStorage(resolve(config.DATA_DIR, "uploads"), config.PUBLIC_URL, config.JWT_SECRET, () => ctx.clock().getTime()),
    ai: o.ai ?? createAiProvider(config),
    limiters: new Map(),
    background: new BackgroundTracker((e) => log.error("background task failed", { error: e instanceof Error ? e.message : String(e) })),
  };
  ctx.presence =
    o.presence ??
    new Presence(config.PRESENCE_GRACE_MS, (scope, idv, online) => {
      const [ws] = scope.split(":");
      if (!ws) return;
      if (scope === memberScope(ws)) {
        ctx.bus.toWorkspace(ws, "presence:update", { member_id: idv, online });
      } else {
        const rooms = ctx.db.all<{ id: string }>("SELECT id FROM rooms WHERE workspace_id = ? AND contact_id = ? AND archived = 0", ws, idv);
        for (const r of rooms) ctx.bus.toRoom(ws, r.id, "visitor:presence", { room_id: r.id, contact_id: idv, online });
      }
    });
  return ctx;
}
