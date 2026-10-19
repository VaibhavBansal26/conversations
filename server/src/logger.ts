export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = "info", write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const emit = (lvl: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = createLogger("silent");
