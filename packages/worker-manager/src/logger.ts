import type { Logger } from "./types";

function prefixMessage(prefix: string, message: string): string {
  return `[${prefix}] ${message}`;
}

/**
 * Adds a stable component prefix to every log message.
 */
export function withLoggerPrefix(logger: Logger | null, prefix: string): Logger | null {
  if (!logger) return null;

  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) return logger;

  const wrap = (method: (msg: string, data?: Record<string, unknown>) => void) => {
    return (msg: string, data?: Record<string, unknown>): void => {
      if (data === undefined) {
        method(prefixMessage(normalizedPrefix, msg));
        return;
      }

      method(prefixMessage(normalizedPrefix, msg), data);
    };
  };

  return {
    debug: wrap(logger.debug.bind(logger)),
    info: wrap(logger.info.bind(logger)),
    warn: wrap(logger.warn.bind(logger)),
    error: wrap(logger.error.bind(logger)),
  };
}

/**
 * Creates a console → Logger adapter.
 * Wraps each console method to match the Logger interface signature.
 */
export function createConsoleLogger(): Logger {
  return {
    debug: (msg, data) => console.debug(data ? `${msg} ${JSON.stringify(data)}` : msg),
    info: (msg, data) => console.info(data ? `${msg} ${JSON.stringify(data)}` : msg),
    warn: (msg, data) => console.warn(data ? `${msg} ${JSON.stringify(data)}` : msg),
    error: (msg, data) => console.error(data ? `${msg} ${JSON.stringify(data)}` : msg),
  };
}
