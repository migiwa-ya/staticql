export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LoggerProvider {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}
