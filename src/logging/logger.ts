/**
 * Structured logger for Foreman.
 * Produces JSON-formatted log lines with context metadata.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private level: LogLevel;
  private component: string;
  private output: (entry: LogEntry) => void;

  constructor(
    level: LogLevel = "info",
    component = "foreman",
    output?: (entry: LogEntry) => void
  ) {
    this.level = level;
    this.component = component;
    this.output = output ?? this.defaultOutput;
  }

  /** Create a child logger with a sub-component name. */
  child(subComponent: string): Logger {
    return new Logger(this.level, `${this.component}:${subComponent}`, this.output);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      data: data ? this.sanitize(data) : undefined,
    };

    this.output(entry);
  }

  private defaultOutput(entry: LogEntry): void {
    const prefix = `[${entry.timestamp}] ${entry.level.toUpperCase().padEnd(5)} [${entry.component}]`;
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";

    switch (entry.level) {
      case "error":
        console.error(`${prefix} ${entry.message}${dataStr}`);
        break;
      case "warn":
        console.warn(`${prefix} ${entry.message}${dataStr}`);
        break;
      case "debug":
        console.debug(`${prefix} ${entry.message}${dataStr}`);
        break;
      default:
        console.log(`${prefix} ${entry.message}${dataStr}`);
    }
  }

  private sanitize(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value instanceof Error) {
        result[key] = { message: value.message, stack: value.stack };
      } else if (typeof value === "bigint") {
        result[key] = value.toString();
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
