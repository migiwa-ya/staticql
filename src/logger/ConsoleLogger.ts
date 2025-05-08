import { LoggerProvider, LogLevel } from "./LoggerProvider";

/**
 * ConsoleLogger: A default implementation of LoggerProvider that logs to the browser/Node.js console.
 *
 * Supports log level filtering via `setLevel()`.
 */
export class ConsoleLogger implements LoggerProvider {
  private levelOrder: Record<LogLevel, number> = {
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
    silent: 5,
  };

  constructor(private currentLevel: LogLevel = "info") {}

  /**
   * Updates the current log level.
   *
   * @param level - Minimum log level to display.
   */
  setLevel(level: LogLevel) {
    this.currentLevel = level;
  }

  /**
   * Determines whether a message at the given level should be logged.
   *
   * @param level - Level of the current log message.
   * @returns `true` if logging is enabled for the level.
   */
  private shouldLog(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.currentLevel];
  }

  /**
   * Logs debug messages to the console (prefixed with [staticql][debug]).
   */
  debug(...args: any[]) {
    if (this.shouldLog("debug")) {
      console.debug("[staticql][debug]", ...args);
    }
  }

  /**
   * Logs informational messages to the console (prefixed with [staticql]).
   */
  info(...args: any[]) {
    if (this.shouldLog("info")) {
      console.info("[staticql]", ...args);
    }
  }

  /**
   * Logs warning messages to the console (prefixed with [staticql][warn]).
   */
  warn(...args: any[]) {
    if (this.shouldLog("warn")) {
      console.warn("[staticql][warn]", ...args);
    }
  }

  /**
   * Logs error messages to the console (prefixed with [staticql][error]).
   */
  error(...args: any[]) {
    if (this.shouldLog("error")) {
      console.error("[staticql][error]", ...args);
    }
  }
}
