/**
 * Foreman Orchestrator.
 * Central coordinator tying together all layers:
 * - Provider registry & model router
 * - Sandbox manager
 * - Agent loops with approval flow
 * - Task source watchers (Linear, GitHub, Slack)
 * - Typed event bus
 * - Historical performance tracking
 * - Session persistence
 */

import type {
  AgentSession,
  AgentTask,
  ForemanConfig,
  ForemanEvent,
  PolicyEvaluation,
  ProviderHealth,
} from "./types/index.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ModelRouter } from "./router/router.js";
import { SandboxManager } from "./sandbox/manager.js";
import { AgentLoop } from "./runtime/loop.js";
import { PolicyEngine } from "./policy/engine.js";
import { EventBus } from "./events/bus.js";
import { Logger } from "./logging/logger.js";
import { LinearWatcher } from "./linear/watcher.js";
import { LinearClient } from "./linear/client.js";
import { GitHubWatcher, GitHubClient } from "./integrations/github.js";
import { SlackWatcher, SlackClient } from "./integrations/slack.js";
import { SessionStore } from "./storage/sessions.js";
import { PerformanceTracker } from "./router/performance.js";

type ApprovalHandler = (evaluation: PolicyEvaluation, session: AgentSession) => Promise<boolean>;

export class Orchestrator {
  private config: ForemanConfig;
  private registry: ProviderRegistry;
  private router: ModelRouter;
  private sandboxManager: SandboxManager;
  private policyEngine: PolicyEngine;
  private eventBus: EventBus;
  private logger: Logger;
  private sessionStore: SessionStore;
  private performanceTracker: PerformanceTracker;

  private linearWatcher: LinearWatcher | null = null;
  private linearClient: LinearClient | null = null;
  private githubWatcher: GitHubWatcher | null = null;
  private githubClient: GitHubClient | null = null;
  private slackWatcher: SlackWatcher | null = null;
  private slackClient: SlackClient | null = null;

  private sessions: Map<string, AgentSession> = new Map();
  private activeLoops: Map<string, AgentLoop> = new Map();
  private taskQueue: AgentTask[] = [];
  private providerHealth: Map<string, ProviderHealth> = new Map();
  private running = false;
  private approvalHandler: ApprovalHandler | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: ForemanConfig) {
    this.config = config;
    this.registry = ProviderRegistry.fromConfig(config);
    this.performanceTracker = new PerformanceTracker();
    this.router = new ModelRouter({
      config: config.routing,
      models: config.models,
      registry: this.registry,
      performanceTracker: this.performanceTracker,
    });
    this.sandboxManager = new SandboxManager(config.sandbox);
    this.policyEngine = new PolicyEngine(config.policy);
    this.eventBus = new EventBus(2000);
    this.logger = new Logger(config.foreman.logLevel, config.foreman.name);
    this.sessionStore = new SessionStore();
  }

  async initialize(): Promise<void> {
    this.logger.info("Initializing Foreman...");

    try {
      await this.sandboxManager.initialize();
      this.logger.info("Sandbox manager initialized", this.sandboxManager.getStatus());
    } catch (error) {
      this.logger.warn("Sandbox init failed, using local fallback", {
        error: error instanceof Error ? error.message : error,
      });
    }

    this.providerHealth = await this.registry.healthCheckAll();
    for (const [key, health] of this.providerHealth) {
      this.logger.info(`Provider "${key}": ${health.healthy ? "healthy" : "unhealthy"}`, {
        latencyMs: health.latencyMs,
      });
    }

    if (this.config.linear) {
      this.linearClient = new LinearClient(this.config.linear);
      this.linearWatcher = new LinearWatcher(
        this.config.linear,
        (task) => this.enqueueTask(task, "linear")
      );
      this.logger.info("Linear watcher configured", { team: this.config.linear.team });
    }

    if (this.config.github) {
      this.githubClient = new GitHubClient(this.config.github);
      this.githubWatcher = new GitHubWatcher(
        this.config.github,
        (task) => this.enqueueTask(task, "github")
      );
      this.logger.info("GitHub watcher configured", {
        repo: `${this.config.github.owner}/${this.config.github.repo}`,
      });
    }

    if (this.config.slack) {
      this.slackClient = new SlackClient(this.config.slack);
      this.slackWatcher = new SlackWatcher(
        this.config.slack,
        (task) => this.enqueueTask(task, "slack")
      );
      this.logger.info("Slack watcher configured", {
        channels: this.config.slack.watchChannels,
      });
    }

    const restored = await this.sessionStore.loadAll();
    if (restored.length > 0) {
      this.logger.info(`Restored ${restored.length} session(s) from disk`);
      for (const session of restored) {
        this.sessions.set(session.id, session);
      }
    }

    this.logger.info("Foreman initialized");
  }

  start(): void {
    this.running = true;
    this.linearWatcher?.start();
    this.githubWatcher?.start();
    this.slackWatcher?.start();

    this.healthCheckInterval = setInterval(async () => {
      this.providerHealth = await this.registry.healthCheckAll();
      for (const [key, health] of this.providerHealth) {
        this.eventBus.emit({ type: "provider:health_changed", providerName: key, health });
      }
    }, 5 * 60 * 1000);

    this.processQueue();
    this.logger.info("Foreman started");
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping Foreman...");
    this.running = false;

    this.linearWatcher?.stop();
    this.githubWatcher?.stop();
    this.slackWatcher?.stop();

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    for (const [id, loop] of this.activeLoops) {
      this.logger.info(`Aborting agent ${id}`);
      loop.abort();
    }

    for (const session of this.sessions.values()) {
      await this.sessionStore.save(session);
    }

    await this.sandboxManager.destroyAll();
    this.logger.info("Foreman stopped");
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  enqueueTask(task: AgentTask, source?: string): void {
    this.taskQueue.push(task);
    this.logger.info(`Task queued: ${task.title}`, { source, id: task.id });
    this.eventBus.emit({ type: "task:queued", task });
    this.processQueue();
  }

  getEventBus(): EventBus { return this.eventBus; }
  getSessions(): AgentSession[] { return Array.from(this.sessions.values()); }
  getEvents(): ForemanEvent[] { return this.eventBus.getHistory(); }
  getProviderHealth(): Map<string, ProviderHealth> { return new Map(this.providerHealth); }
  getConfig(): ForemanConfig { return this.config; }
  getPerformanceStats() { return this.performanceTracker.getStats(); }
  getLogger(): Logger { return this.logger; }

  private processQueue(): void {
    if (!this.running) return;

    const activeCount = Array.from(this.sessions.values()).filter(
      (s) => s.status === "running"
    ).length;

    const available = this.config.foreman.maxConcurrentAgents - activeCount;

    for (let i = 0; i < available && this.taskQueue.length > 0; i++) {
      const task = this.taskQueue.shift()!;
      this.executeTask(task).catch((error) => {
        this.logger.error(`Failed to execute task ${task.id}`, { error });
      });
    }
  }

  private async executeTask(task: AgentTask): Promise<void> {
    const decision = this.router.route(task);
    task.assignedModel = decision.modelKey;

    this.logger.info(`Task "${task.title}" → model "${decision.modelKey}"`, {
      reason: decision.reason,
    });
    this.eventBus.emit({ type: "task:assigned", task, modelKey: decision.modelKey });

    const provider = this.registry.getOrThrow(decision.modelKey);

    const sandbox = await this.sandboxManager.acquire({
      taskId: task.id,
      repository: task.repository,
      branch: task.branch,
    });

    if (task.linearTicketId && this.linearClient) {
      await this.linearClient.updateStatus(task.linearTicketId, "In Progress").catch(() => {});
    }

    const summarizationProvider = this.registry.get("fast") ?? undefined;

    const approvalHandler = this.approvalHandler;
    let loopRef: AgentLoop | null = null;

    const loop: AgentLoop = new AgentLoop({
      task,
      provider,
      config: this.config,
      workingDir: sandbox.workingDir,
      summarizationProvider,
      onEvent: (event) => this.eventBus.emit(event),
      onApprovalRequired: approvalHandler
        ? async (evaluation) => approvalHandler(evaluation, loopRef!.getSession())
        : undefined,
    });
    loopRef = loop;

    const sessionId = loop.getSession().id;
    this.activeLoops.set(sessionId, loop);
    this.sessions.set(sessionId, loop.getSession());

    const startTime = Date.now();

    try {
      const session = await loop.run();
      this.sessions.set(session.id, session);

      // Calculate cost from provider cost profile
      const costProfile = provider.costProfile();
      const costUsd =
        (session.tokenUsage.inputTokens / 1_000_000) * costProfile.inputTokenCostPer1M +
        (session.tokenUsage.outputTokens / 1_000_000) * costProfile.outputTokenCostPer1M;

      this.performanceTracker.record({
        modelKey: decision.modelKey,
        taskId: task.id,
        success: session.status === "completed",
        durationMs: Date.now() - startTime,
        iterations: session.iterations,
        tokenUsage: session.tokenUsage,
        costUsd,
        labels: task.labels,
      });

      // Update router with running spend for budget-aware routing
      this.router.updateSpend(this.performanceTracker.getTotalSpend());

      const artifacts = await this.sandboxManager.release(sandbox.id, true);
      session.artifacts.push(...artifacts);

      await this.sessionStore.save(session);
      await this.notifyCompletion(task, session);

      this.logger.info(`Task "${task.title}" ${session.status}`, {
        model: session.modelName,
        iterations: session.iterations,
        tokens: session.tokenUsage.inputTokens + session.tokenUsage.outputTokens,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      this.logger.error(`Agent loop error for task ${task.id}`, { error });
    } finally {
      this.activeLoops.delete(sessionId);
      this.processQueue();
    }
  }

  private async notifyCompletion(task: AgentTask, session: AgentSession): Promise<void> {
    const tokens = session.tokenUsage.inputTokens + session.tokenUsage.outputTokens;
    const summary = `Foreman agent ${session.status}.\nModel: ${session.modelName}\nIterations: ${session.iterations}\nTokens: ${tokens}`;

    if (task.linearTicketId && this.linearClient) {
      if (session.status === "completed") {
        await this.linearClient.updateStatus(task.linearTicketId, "In Review").catch(() => {});
        await this.linearClient.addComment(task.linearTicketId, summary).catch(() => {});
      } else if (session.status === "failed") {
        await this.linearClient.addComment(
          task.linearTicketId, `${summary}\nError: ${session.error}`
        ).catch(() => {});
      }
    }

    if (task.id.startsWith("gh_") && this.githubClient) {
      const issueNumber = parseInt(task.title.match(/#(\d+)/)?.[1] ?? "0");
      if (issueNumber > 0) {
        await this.githubClient.addComment(issueNumber, summary).catch(() => {});
        if (session.status === "completed") {
          await this.githubClient.addLabels(issueNumber, ["agent-completed"]).catch(() => {});
        }
      }
    }

    if (task.id.startsWith("slack_") && this.slackClient) {
      const channel = task.id.split("_")[1];
      if (channel) {
        await this.slackClient.postMessage(channel, summary).catch(() => {});
      }
    }
  }
}
