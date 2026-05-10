type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  const line = `${ts} [${level}] ${message}${metaStr}`;
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>): void => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>): void => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>): void => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>): void => emit("error", msg, meta),
};
