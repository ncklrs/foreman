/**
 * Cron Schedule Manager.
 * Wraps AutopilotScheduler to manage user-defined scheduled tasks.
 * Converts ScheduledTaskConfig entries into cron-scheduled callbacks
 * that create AgentTasks and enqueue them for execution.
 */

import { AutopilotScheduler } from "../autopilot/scheduler.js";
import { EventBus } from "../events/bus.js";
import { Logger } from "../logging/logger.js";
import type { ScheduledTaskConfig, AgentTask } from "../types/index.js";

export interface CronScheduleManagerOptions {
  scheduler: AutopilotScheduler;
  eventBus: EventBus;
  logger: Logger;
  onEnqueueTask: (task: AgentTask) => void;
}

export class CronScheduleManager {
  private configs: Map<string, ScheduledTaskConfig> = new Map();
  private scheduler: AutopilotScheduler;
  private eventBus: EventBus;
  private logger: Logger;
  private onEnqueueTask: (task: AgentTask) => void;

  constructor(options: CronScheduleManagerOptions) {
    this.scheduler = options.scheduler;
    this.eventBus = options.eventBus;
    this.logger = options.logger.child("scheduler");
    this.onEnqueueTask = options.onEnqueueTask;
  }

  /** Load multiple schedules from configuration. */
  loadFromConfig(schedules: ScheduledTaskConfig[]): void {
    for (const config of schedules) {
      this.addSchedule(config);
    }
  }

  /** Add a single schedule. */
  addSchedule(config: ScheduledTaskConfig): void {
    this.configs.set(config.id, config);

    const callback = async () => {
      const taskId = `sched-${config.id}-${Date.now()}`;
      const task: AgentTask = {
        id: taskId,
        title: config.description,
        description: config.prompt,
        branch: config.branch,
        labels: config.labels,
        assignedModel: config.model,
      };
      this.onEnqueueTask(task);
      this.eventBus.emit({ type: "schedule:fired", scheduleId: config.id, taskId });
      this.logger.info(`Schedule "${config.id}" fired, created task ${taskId}`);
    };

    this.scheduler.addSchedule(
      config.id,
      config.schedule,
      callback,
      config.timezone
    );

    if (config.enabled === false) {
      this.scheduler.setEnabled(config.id, false);
    }

    this.eventBus.emit({ type: "schedule:added", scheduleId: config.id });
    this.logger.info(`Schedule "${config.id}" added`, {
      schedule: config.schedule,
      enabled: config.enabled !== false,
    });
  }

  /** Remove a schedule by ID. */
  removeSchedule(id: string): void {
    this.configs.delete(id);
    this.scheduler.removeSchedule(id);
    this.eventBus.emit({ type: "schedule:removed", scheduleId: id });
    this.logger.info(`Schedule "${id}" removed`);
  }

  /** Enable or disable a schedule. */
  setEnabled(id: string, enabled: boolean): void {
    const config = this.configs.get(id);
    if (config) {
      config.enabled = enabled;
    }
    this.scheduler.setEnabled(id, enabled);
    this.eventBus.emit({ type: "schedule:toggled", scheduleId: id, enabled });
    this.logger.info(`Schedule "${id}" ${enabled ? "enabled" : "disabled"}`);
  }

  /** Get all registered schedule configs. */
  getSchedules(): ScheduledTaskConfig[] {
    return Array.from(this.configs.values());
  }

  /** Start the underlying scheduler if not already running. */
  start(): void {
    if (!this.scheduler.isRunning()) {
      this.scheduler.start();
    }
  }

  /** Stop the underlying scheduler. */
  stop(): void {
    this.scheduler.stop();
  }
}
