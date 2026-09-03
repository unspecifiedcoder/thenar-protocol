/**
 * Structured JSON logging helper (T-031).
 *
 * Never logs request bodies or payload bytes. Logs level, message, and
 * structured fields as JSON.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Emit a structured JSON log line.
 * @param level Log level
 * @param msg Message
 * @param fields Structured fields (never request bodies or raw bytes)
 */
export function structuredLog(level: LogLevel, msg: string, fields: Record<string, any> = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  console.log(JSON.stringify(logEntry));
}

export const log = {
  debug: (msg: string, fields?: Record<string, any>) => structuredLog("debug", msg, fields),
  info: (msg: string, fields?: Record<string, any>) => structuredLog("info", msg, fields),
  warn: (msg: string, fields?: Record<string, any>) => structuredLog("warn", msg, fields),
  error: (msg: string, fields?: Record<string, any>) => structuredLog("error", msg, fields),
};
