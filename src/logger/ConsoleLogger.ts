import { LoggerProvider, LogLevel } from "./LoggerProvider";

export class ConsoleLogger implements LoggerProvider {
  private levelOrder: Record<LogLevel, number> = {
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
    silent: 5,
  };

  constructor(private currentLevel: LogLevel = "info") {}

  setLevel(level: LogLevel) {
    this.currentLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.currentLevel];
  }

  debug(...args: any[]) {
    if (this.shouldLog("debug")) {
      console.debug("[staticql][debug]", ...args);
    }
  }

  info(...args: any[]) {
    if (this.shouldLog("info")) {
      console.info("[staticql]", ...args);
    }
  }

  warn(...args: any[]) {
    if (this.shouldLog("warn")) {
      console.warn("[staticql][warn]", ...args);
    }
  }

  error(...args: any[]) {
    if (this.shouldLog("error")) {
      console.error("[staticql][error]", ...args);
    }
  }
}
