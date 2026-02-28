/**
 * Autopilot Scheduler.
 * Parses cron expressions and manages scheduled execution of autopilot runs.
 * Uses a lightweight cron parser — no external dependencies.
 */

export interface ScheduleEntry {
  id: string;
  expression: string;
  timezone: string;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
}

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export class AutopilotScheduler {
  private schedules: Map<string, ScheduleEntry> = new Map();
  private callbacks: Map<string, () => void | Promise<void>> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private checkIntervalMs: number;

  constructor(checkIntervalMs = 30_000) {
    this.checkIntervalMs = checkIntervalMs;
  }

  /** Add a schedule. */
  addSchedule(
    id: string,
    expression: string,
    callback: () => void | Promise<void>,
    timezone = "UTC"
  ): void {
    // Validate expression
    parseCron(expression);

    const entry: ScheduleEntry = {
      id,
      expression,
      timezone,
      enabled: true,
      nextRun: getNextRun(expression),
    };

    this.schedules.set(id, entry);
    this.callbacks.set(id, callback);
  }

  /** Remove a schedule. */
  removeSchedule(id: string): void {
    this.schedules.delete(id);
    this.callbacks.delete(id);
  }

  /** Enable or disable a schedule. */
  setEnabled(id: string, enabled: boolean): void {
    const entry = this.schedules.get(id);
    if (entry) entry.enabled = enabled;
  }

  /** Start the scheduler loop. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      this.tick().catch(console.error);
    }, this.checkIntervalMs);

    // Initial tick
    this.tick().catch(console.error);
  }

  /** Stop the scheduler. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get all schedule entries. */
  getSchedules(): ScheduleEntry[] {
    return Array.from(this.schedules.values());
  }

  /** Check if a schedule should run now. Exposed for testing. */
  shouldRunNow(expression: string, now?: Date): boolean {
    return matchesCron(expression, now ?? new Date());
  }

  /** Check if scheduler is running. */
  isRunning(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    const now = new Date();

    for (const [id, entry] of this.schedules) {
      if (!entry.enabled) continue;

      if (matchesCron(entry.expression, now)) {
        // Don't run twice in the same minute
        if (entry.lastRun) {
          const elapsed = now.getTime() - entry.lastRun.getTime();
          if (elapsed < 60_000) continue;
        }

        entry.lastRun = now;
        entry.nextRun = getNextRun(entry.expression);

        const callback = this.callbacks.get(id);
        if (callback) {
          try {
            await callback();
          } catch (error) {
            console.error(`Schedule ${id} failed:`, error);
          }
        }
      }
    }
  }
}

/**
 * Parse a standard 5-field cron expression.
 * Format: minute hour day-of-month month day-of-week
 *
 * Supports: numbers, ranges (1-5), lists (1,3,5), steps (star/2), wildcards (star)
 */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expression}" — must have 5 fields`);
  }

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 7), // 0 and 7 = Sunday
  };
}

/** Check if a cron expression matches a given time. */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = parseCron(expression);

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // 1-indexed
  let dayOfWeek = date.getDay(); // 0 = Sunday

  // Normalize: 7 -> 0 (both mean Sunday)
  const normalizedDow = fields.dayOfWeek.map((d) => (d === 7 ? 0 : d));

  return (
    fields.minute.includes(minute) &&
    fields.hour.includes(hour) &&
    fields.dayOfMonth.includes(dayOfMonth) &&
    fields.month.includes(month) &&
    normalizedDow.includes(dayOfWeek)
  );
}

/** Calculate the next run time for a cron expression. */
export function getNextRun(expression: string, from?: Date): Date {
  const start = from ?? new Date();
  // Start from the next minute
  const candidate = new Date(start);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Check up to 366 days ahead
  const maxAttempts = 366 * 24 * 60;
  for (let i = 0; i < maxAttempts; i++) {
    if (matchesCron(expression, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`Could not find next run time for: ${expression}`);
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);

      let start = min;
      let end = max;

      if (range !== "*") {
        if (range.includes("-")) {
          const [s, e] = range.split("-").map(Number);
          start = s;
          end = e;
        } else {
          start = parseInt(range, 10);
        }
      }

      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
    } else if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const num = parseInt(part, 10);
      if (isNaN(num)) throw new Error(`Invalid cron field value: ${part}`);
      values.add(num);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}
