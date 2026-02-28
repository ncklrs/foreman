/**
 * Linear ticket watcher.
 * Polls for tickets matching criteria and emits them for processing.
 */

import type { AgentTask, LinearConfig } from "../types/index.js";
import { LinearClient } from "./client.js";

type TaskCallback = (task: AgentTask) => void;

export class LinearWatcher {
  private client: LinearClient;
  private pollIntervalMs: number;
  private callback: TaskCallback;
  private seenTickets: Set<string> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: LinearConfig,
    callback: TaskCallback,
    pollIntervalMs = 30000
  ) {
    this.client = new LinearClient(config);
    this.callback = callback;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** Start watching for new tickets. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Initial poll
    this.poll().catch(console.error);

    // Periodic polling
    this.timer = setInterval(() => {
      this.poll().catch(console.error);
    }, this.pollIntervalMs);
  }

  /** Stop watching. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get the underlying Linear client for status updates. */
  getClient(): LinearClient {
    return this.client;
  }

  private async poll(): Promise<void> {
    try {
      const tasks = await this.client.fetchReadyTickets();

      for (const task of tasks) {
        if (!this.seenTickets.has(task.id)) {
          this.seenTickets.add(task.id);
          this.callback(task);
        }
      }
    } catch (error) {
      console.error(
        "Linear poll error:",
        error instanceof Error ? error.message : error
      );
    }
  }
}
