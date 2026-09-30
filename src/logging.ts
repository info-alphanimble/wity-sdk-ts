// Optional logging.
// Levels from most to least chatty: debug, info, warn, error, off. The default is warn.
// Nothing here ever logs the API key or the `state` text.

import { WityError } from "./errors";

export type LogLevel = "debug" | "info" | "warn" | "error" | "off";

/** Anything with these four methods works, for example `console`, pino or winston. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error", "off"];
export const DEFAULT_LOG_LEVEL: LogLevel = "warn";

/** Check a level from the `logLevel` option or WITY_LOG_LEVEL. */
export const parseLogLevel = (value: string, source: string): LogLevel => {
  const level = value.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(level)) return level as LogLevel;
  throw new WityError(`${source} must be one of: ${LOG_LEVELS.join(", ")}.`);
};

const PREFIX = "[wity]";

/** The default logger: the console, with a `[wity]` prefix. */
export const consoleLogger: Logger = {
  debug: (message, ...args) => console.debug(`${PREFIX} ${message}`, ...args),
  info: (message, ...args) => console.info(`${PREFIX} ${message}`, ...args),
  warn: (message, ...args) => console.warn(`${PREFIX} ${message}`, ...args),
  error: (message, ...args) => console.error(`${PREFIX} ${message}`, ...args),
};

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };
const drop = (): void => {};

/** Pass on only messages at `level` or above. */
export const withLevel = (sink: Logger, level: LogLevel): Logger => {
  const on = (at: LogLevel): boolean => RANK[at] >= RANK[level];
  return {
    debug: on("debug") ? (message, ...args) => sink.debug(message, ...args) : drop,
    info: on("info") ? (message, ...args) => sink.info(message, ...args) : drop,
    warn: on("warn") ? (message, ...args) => sink.warn(message, ...args) : drop,
    error: on("error") ? (message, ...args) => sink.error(message, ...args) : drop,
  };
};
