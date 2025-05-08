/**
 * LogLevel: Defines the supported log verbosity levels.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/**
 * LoggerProvider: Abstract interface for pluggable loggers.
 *
 * Used to provide custom logging behavior (e.g., console, file, remote logger).
 */
export interface LoggerProvider {
  /**
   * Logs low-level debug information.
   *
   * @param args - Arbitrary arguments to log.
   */
  debug(...args: any[]): void;

  /**
   * Logs general informational messages.
   *
   * @param args - Arbitrary arguments to log.
   */
  info(...args: any[]): void;

  /**
   * Logs warnings (non-fatal issues).
   *
   * @param args - Arbitrary arguments to log.
   */
  warn(...args: any[]): void;

  /**
   * Logs errors or critical failures.
   *
   * @param args - Arbitrary arguments to log.
   */
  error(...args: any[]): void;
}
