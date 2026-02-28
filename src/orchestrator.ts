/**
 * Foreman Orchestrator.
 * The central coordinator that ties together all layers:
 * - Provider registry
 * - Model router
 * - Sandbox manager
 * - Agent loops
 * - Linear watcher
 * - Event system
 */

import type {
  AgentSession,
  AgentTask,
  ForemanConfig,
  ForemanEvent,
  ProviderHealth,
} from "./types/index.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ModelRouter } from "./router/router.js";
import { SandboxManager } from "./sandbox/manager.js";
import { AgentLoop } from "./runtime/loop.js";
import { PolicyEngine } from "./policy/engine.js";
import { LinearWatcher } from "./linear/watcher.js";
import { LinearClient } from "./linear/client.js";

export class Orchestrator {
  private config: ForemanConfig;
  private registry: ProviderRegistry;
  private router: ModelRouter;
  private sandboxManager: SandboxManager;
  private policyEngine: PolicyEngine;
  private linearWatcher: LinearWatcher | null = null;
  private linearClient: LinearClient | null = null;

  private sessions: Map<string, AgentSession> = new Map();
  private activeLoops: Map<string, AgentLoop> = new Map();
  private taskQueue: AgentTask[] = [];
  private events: ForemanEvent[] = [];
  private eventListeners: Array<(event: ForemanEvent) => void> = [];
  private providerHealth: Map<string, ProviderHealth> = new Map();
  private running = false;

  constructor(config: ForemanConfig) {
    this.config = config;
    this.registry = ProviderRegistry.fromConfig(config);
    this.router = new ModelRouter(config.routing, config.models, this.registry);
    this.sandboxManager = new SandboxManager(config.sandbox);
    this.policyEngine = new PolicyEngine(config.policy);
  }

  /** Initialize all subsystems. */
  async initialize(): Promise<void> {
    // Initialize sandbox warm pool
    await this.sandboxManager.initialize();

    // Run initial health checks
    this.providerHealth = await this.registry.healthCheckAll();

    // Set up Linear watcher if configured
    if (this.config.linear) {
      this.linearClient = new LinearClient(this.config.linear);
      this.linearWatcher = new LinearWatcher(
        this.config.linear,
        (task) => this.enqueueTask(task)
      );
    }
  }

  /** Start the orchestrator — begins watching for tasks and processing queue. */
  start(): void {
    this.running = true;
    this.linearWatcher?.start();
    this.processQueue();
  }

  /** Stop the orchestrator gracefully. */
  async stop(): Promise<void> {
    this.running = false;
    this.linearWatcher?.stop();

    // Abort all active agent loops
    for (const [, loop] of this.activeLoops) {
      loop.abort();
    }

    // Destroy all sandboxes
    await this.sandboxManager.destroyAll();
  }

  /** Manually enqueue a task. */
  enqueueTask(task: AgentTask): void {
    this.taskQueue.push(task);
    this.emitEvent({ type: "task:queued", task });
    this.processQueue();
  }

  /** Subscribe to events. */
  onEvent(listener: (event: ForemanEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /** Get all sessions. */
  getSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  /** Get all events. */
  getEvents(): ForemanEvent[] {
    return [...this.events];
  }

  /** Get provider health status. */
  getProviderHealth(): Map<string, ProviderHealth> {
    return new Map(this.providerHealth);
  }

  /** Get the config. */
  getConfig(): ForemanConfig {
    return this.config;
  }

  private processQueue(): void {
    if (!this.running) return;

    const activeCount = Array.from(this.sessions.values()).filter(
      (s) => s.status === "running"
    ).length;

    const availableSlots = this.config.foreman.maxConcurrentAgents - activeCount;

    for (let i = 0; i < availableSlots && this.taskQueue.length > 0; i++) {
      const task = this.taskQueue.shift()!;
      this.executeTask(task).catch((error) => {
        console.error(`Failed to execute task ${task.id}:`, error);
      });
    }
  }

  private async executeTask(task: AgentTask): Promise<void> {
    // Route to best model
    const decision = this.router.route(task);
    task.assignedModel = decision.modelKey;

    this.emitEvent({ type: "task:assigned", task, modelKey: decision.modelKey });

    // Get the provider
    const provider = this.registry.getOrThrow(decision.modelKey);

    // Acquire a sandbox
    const sandbox = await this.sandboxManager.acquire({
      taskId: task.id,
      repository: task.repository,
      branch: task.branch,
    });

    // Update Linear status
    if (task.linearTicketId && this.linearClient) {
      await this.linearClient.updateStatus(task.linearTicketId, "In Progress").catch(() => {});
    }

    // Create and run the agent loop
    const loop = new AgentLoop({
      task,
      provider,
      config: this.config,
      workingDir: sandbox.workingDir,
      onEvent: (event) => this.emitEvent(event),
    });

    this.activeLoops.set(loop.getSession().id, loop);
    this.sessions.set(loop.getSession().id, loop.getSession());

    try {
      const session = await loop.run();
      this.sessions.set(session.id, session);

      // Collect artifacts
      const artifacts = await this.sandboxManager.release(sandbox.id, true);
      session.artifacts.push(...artifacts);

      // Update Linear on completion
      if (task.linearTicketId && this.linearClient) {
        if (session.status === "completed") {
          await this.linearClient.updateStatus(task.linearTicketId, "In Review").catch(() => {});
          await this.linearClient.addComment(
            task.linearTicketId,
            `Foreman agent completed task.\nModel: ${session.modelName}\nIterations: ${session.iterations}\nTokens: ${session.tokenUsage.inputTokens + session.tokenUsage.outputTokens}`
          ).catch(() => {});
        } else if (session.status === "failed") {
          await this.linearClient.addComment(
            task.linearTicketId,
            `Foreman agent failed: ${session.error}`
          ).catch(() => {});
        }
      }
    } catch (error) {
      console.error(`Agent loop error for task ${task.id}:`, error);
    } finally {
      this.activeLoops.delete(loop.getSession().id);
      // Process more tasks from the queue
      this.processQueue();
    }
  }

  private emitEvent(event: ForemanEvent): void {
    this.events.push(event);
    // Keep last 1000 events
    if (this.events.length > 1000) {
      this.events = this.events.slice(-1000);
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Event listener error:", error);
      }
    }
  }
}
