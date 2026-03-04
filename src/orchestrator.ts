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
import { ClaudeCodeRunner } from "./runtime/adapters/claude-code.js";
import { PolicyEngine } from "./policy/engine.js";
import { EventBus } from "./events/bus.js";
import { Logger } from "./logging/logger.js";
import { LinearWatcher } from "./linear/watcher.js";
import { LinearClient } from "./linear/client.js";
import { GitHubWatcher, GitHubClient } from "./integrations/github.js";
import { SlackWatcher, SlackClient } from "./integrations/slack.js";
import { SessionStore } from "./storage/sessions.js";
import { PerformanceTracker } from "./router/performance.js";
import { AutopilotEngine } from "./autopilot/engine.js";
import { CronScheduleManager } from "./scheduling/manager.js";
import { KnowledgeStore } from "./learning/knowledge.js";
import { AgentsMdManager } from "./learning/agents-md.js";
import { SkillsRegistry } from "./skills/registry.js";
import type { PromptEnrichment } from "./runtime/prompt.js";
import { TaskDecomposer } from "./orchestration/decomposer.js";
import { MultiAgentExecutor } from "./orchestration/executor.js";

type ApprovalHandler = (evaluation: PolicyEvaluation, session: AgentSession) => Promise<boolean>;

/** Best-effort async call — logs warning on failure instead of silently swallowing. */
function bestEffort(promise: Promise<unknown>, logger: Logger, context: string): Promise<void> {
  return promise.catch((err: unknown) => {
    logger.warn(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }) as Promise<void>;
}

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
  private autopilotEngine: AutopilotEngine | null = null;
  private scheduleManager?: CronScheduleManager;
  private knowledgeStore: KnowledgeStore;
  private agentsMdManager: AgentsMdManager | null = null;
  private skillsRegistry: SkillsRegistry;

  private sessions: Map<string, AgentSession> = new Map();
  private activeLoops: Map<string, AgentLoop> = new Map();
  private taskQueue: AgentTask[] = [];
  private providerHealth: Map<string, ProviderHealth> = new Map();
  private runningCount = 0;
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
    this.knowledgeStore = new KnowledgeStore();
    this.skillsRegistry = new SkillsRegistry();
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

    // Load learning system
    await this.knowledgeStore.load();
    this.agentsMdManager = new AgentsMdManager(process.cwd());
    const skillsLoaded = await this.skillsRegistry.loadFromDirectory(process.cwd());
    if (skillsLoaded > 0) {
      this.logger.info(`Loaded ${skillsLoaded} custom skill(s)`);
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

    if (this.config.autopilot?.enabled) {
      this.autopilotEngine = new AutopilotEngine({
        config: this.config,
        autopilotConfig: this.config.autopilot,
        registry: this.registry,
        eventBus: this.eventBus,
        logger: this.logger,
        githubClient: this.githubClient,
        linearClient: this.linearClient,
        onEnqueueTask: (task) => this.enqueueTask(task, "autopilot"),
        knowledgeStore: this.knowledgeStore,
      });
      this.logger.info("Autopilot configured", {
        schedule: this.config.autopilot.schedule,
        scanners: this.config.autopilot.scanners,
        autoResolve: this.config.autopilot.autoResolve,
      });
    }

    if (this.config.schedules?.length) {
      const { AutopilotScheduler } = await import("./autopilot/scheduler.js");
      const scheduler = new AutopilotScheduler();
      this.scheduleManager = new CronScheduleManager({
        scheduler,
        eventBus: this.eventBus,
        logger: this.logger,
        onEnqueueTask: (task) => this.enqueueTask(task, "schedule"),
      });
      this.scheduleManager.loadFromConfig(this.config.schedules);
      this.logger.info("Schedule manager configured", {
        schedules: this.config.schedules.length,
      });
    }

    const restored = await this.sessionStore.loadAll();
    // Only restore running sessions (others are historical and stay on disk)
    const active = restored.filter((s) => s.status === "running");
    if (active.length > 0) {
      this.logger.info(`Restored ${active.length} active session(s) from disk (${restored.length} total on disk)`);
      for (const session of active) {
        this.sessions.set(session.id, session);
      }
    }
    // Auto-prune old sessions on startup
    await this.sessionStore.prune(50);

    this.logger.info("Foreman initialized");
  }

  start(): void {
    this.running = true;
    this.linearWatcher?.start();
    this.githubWatcher?.start();
    this.slackWatcher?.start();
    this.autopilotEngine?.start();
    this.scheduleManager?.start();

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
    this.autopilotEngine?.stop();
    this.scheduleManager?.stop();

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

    await this.knowledgeStore.save();
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
  getAutopilotEngine(): AutopilotEngine | null { return this.autopilotEngine; }
  getScheduleManager(): CronScheduleManager | undefined { return this.scheduleManager; }
  getKnowledgeStore(): KnowledgeStore { return this.knowledgeStore; }
  getSkillsRegistry(): SkillsRegistry { return this.skillsRegistry; }

  private processQueue(): void {
    if (!this.running) return;

    const available = this.config.foreman.maxConcurrentAgents - this.runningCount;

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

    // Check if task should be decomposed into subtasks
    const shouldDecompose = this.config.foreman.decompose ?? false;
    const decomposeThreshold = this.config.foreman.decomposeThreshold ?? 7;
    const complexity = this.router.scoreComplexity(task);

    if (shouldDecompose && complexity.score >= decomposeThreshold) {
      this.logger.info(`Task complexity ${complexity.score} >= threshold ${decomposeThreshold}, decomposing`, {
        reasoning: complexity.reasoning,
      });
      await this.executeDecomposed(task);
      return;
    }

    const provider = this.registry.getOrThrow(decision.modelKey);

    const sandbox = await this.sandboxManager.acquire({
      taskId: task.id,
      repository: task.repository,
      branch: task.branch,
    });

    if (task.linearTicketId && this.linearClient) {
      await bestEffort(
        this.linearClient.updateStatus(task.linearTicketId, "In Progress"),
        this.logger, "Linear status update"
      );
    }

    // Mark GitHub issue as in-progress
    if (task.id.startsWith("gh_") && this.githubClient) {
      const issueNumber = parseInt(task.title.match(/#(\d+)/)?.[1] ?? "0");
      if (issueNumber > 0) {
        await bestEffort(this.githubClient.addLabels(issueNumber, ["agent-working"]), this.logger, "GitHub add label");
        await bestEffort(this.githubClient.removeLabel(issueNumber, "agent-ready"), this.logger, "GitHub remove label");
      }
    }

    // Acknowledge Slack message with reaction
    if (task.id.startsWith("slack_") && this.slackClient) {
      const parts = task.id.split("_");
      const channel = parts[1];
      const ts = parts[2];
      if (channel && ts) {
        await bestEffort(this.slackClient.addReaction(channel, ts, "eyes"), this.logger, "Slack reaction");
      }
    }

    const summarizationProvider = this.registry.get("fast") ?? undefined;

    // Build prompt enrichment from learning system
    const enrichment = await this.buildEnrichment(task);

    // Choose runtime: Claude Code CLI or built-in AgentLoop
    const useClaudeCode = this.config.foreman.runtime === "claude-code";
    let runner: { getSession(): AgentSession; run(): Promise<AgentSession>; abort(): void };

    if (useClaudeCode) {
      const modelConfig = this.config.models[decision.modelKey];
      const ccRunner = new ClaudeCodeRunner({
        task,
        config: this.config,
        workingDir: sandbox.workingDir,
        model: modelConfig?.model,
        maxTurns: 50,
        promptEnrichment: enrichment,
        onEvent: (event) => this.eventBus.emit(event),
        dangerouslyAutoApprove: true,
      });
      runner = ccRunner;
    } else {
      const approvalHandler = this.approvalHandler;
      let loopRef: AgentLoop | null = null;
      const loop = new AgentLoop({
        task,
        provider,
        config: this.config,
        workingDir: sandbox.workingDir,
        summarizationProvider,
        registry: this.registry,
        useStreaming: true,
        onEvent: (event) => this.eventBus.emit(event),
        onApprovalRequired: approvalHandler
          ? async (evaluation) => approvalHandler(evaluation, loopRef!.getSession())
          : undefined,
        promptEnrichment: enrichment,
      });
      loopRef = loop;
      runner = loop;
    }

    const sessionId = runner.getSession().id;
    this.activeLoops.set(sessionId, runner as AgentLoop);
    this.sessions.set(sessionId, runner.getSession());
    this.runningCount++;

    const startTime = Date.now();

    try {
      const session = await runner.run();
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

      // Learn from completed session
      this.knowledgeStore.learnFromSession(session);
      await this.knowledgeStore.save();

      // Evict completed session from memory (persisted to disk)
      this.sessions.delete(session.id);

      this.logger.info(`Task "${task.title}" ${session.status}`, {
        model: session.modelName,
        iterations: session.iterations,
        tokens: session.tokenUsage.inputTokens + session.tokenUsage.outputTokens,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      this.logger.error(`Agent loop error for task ${task.id}`, { error });
    } finally {
      this.runningCount--;
      this.activeLoops.delete(sessionId);
      this.processQueue();
    }
  }

  private async buildEnrichment(task: AgentTask): Promise<PromptEnrichment> {
    const enrichment: PromptEnrichment = {};

    // Lessons from KnowledgeStore
    const lessonsSection = this.knowledgeStore.buildPromptSection(task.labels ?? []);
    if (lessonsSection) {
      enrichment.lessonsSection = lessonsSection;
    }

    // AGENTS.md project conventions
    if (this.agentsMdManager) {
      const agentsMd = await this.agentsMdManager.load();
      if (agentsMd) {
        enrichment.agentsMdSection = this.agentsMdManager.buildPromptSection(agentsMd);
      }
    }

    // Matched skills
    const matchedSkills = this.skillsRegistry.matchSkills(task.title, task.labels);
    if (matchedSkills.length > 0) {
      enrichment.skillsSection = this.skillsRegistry.buildPromptSection(matchedSkills);
    }

    return enrichment;
  }

  /**
   * Execute a complex task by decomposing it into subtasks and running them
   * via the MultiAgentExecutor with parallel batching.
   */
  private async executeDecomposed(task: AgentTask): Promise<void> {
    const sandbox = await this.sandboxManager.acquire({
      taskId: task.id,
      repository: task.repository,
      branch: task.branch,
    });

    try {
      // Use architect model for decomposition if available
      const architectProvider = this.registry.get("architect") ?? undefined;
      const architectConfig = this.config.models["architect"] ?? undefined;

      const decomposer = new TaskDecomposer({
        provider: architectProvider,
        modelConfig: architectConfig,
        heuristicFallback: true,
      });

      const { graph, strategy, reasoning } = await decomposer.decompose(task);

      this.logger.info(`Task decomposed: ${graph.size()} subtasks via ${strategy}`, {
        reasoning,
      });

      this.eventBus.emit({
        type: "task:decomposed",
        task,
        subtaskCount: graph.size(),
        strategy,
      });

      // Execute the task graph
      const executor = new MultiAgentExecutor({
        config: this.config,
        registry: this.registry,
        eventBus: this.eventBus,
        logger: this.logger,
        workingDir: sandbox.workingDir,
        parentTask: task,
        onEvent: (event) => this.eventBus.emit(event),
      });

      const result = await executor.execute(graph);

      const stats = result.graph.getStats();
      this.eventBus.emit({
        type: "task:graph_completed",
        parentTaskId: task.id,
        completed: stats.completed,
        failed: stats.failed,
        skipped: stats.skipped,
      });

      // Create a synthetic session for the decomposed task
      const session: AgentSession = {
        id: `decomposed_${task.id}`,
        task,
        status: result.success ? "completed" : "failed",
        modelName: "multi-agent",
        messages: [],
        iterations: stats.total,
        maxIterations: stats.total,
        tokenUsage: result.totalTokens,
        startedAt: new Date(Date.now() - result.durationMs),
        completedAt: new Date(),
        artifacts: [
          { type: "log", content: result.summary, createdAt: new Date() },
        ],
        error: result.success ? undefined : `${stats.failed} subtask(s) failed`,
      };

      await this.sessionStore.save(session);
      await this.notifyCompletion(task, session);
      this.knowledgeStore.learnFromSession(session);
      await this.knowledgeStore.save();

      this.logger.info(`Decomposed task "${task.title}" ${result.success ? "completed" : "failed"}`, {
        subtasks: stats.total,
        completed: stats.completed,
        failed: stats.failed,
        durationMs: result.durationMs,
      });
    } catch (error) {
      this.logger.error(`Decomposed task execution error for ${task.id}`, { error });
    } finally {
      await this.sandboxManager.release(sandbox.id, true);
    }
  }

  private async notifyCompletion(task: AgentTask, session: AgentSession): Promise<void> {
    const tokens = session.tokenUsage.inputTokens + session.tokenUsage.outputTokens;
    const summary = `Foreman agent ${session.status}.\nModel: ${session.modelName}\nIterations: ${session.iterations}\nTokens: ${tokens}`;

    if (task.linearTicketId && this.linearClient) {
      if (session.status === "completed") {
        await bestEffort(this.linearClient.updateStatus(task.linearTicketId, "In Review"), this.logger, "Linear status update");
        await bestEffort(this.linearClient.addComment(task.linearTicketId, summary), this.logger, "Linear comment");
      } else if (session.status === "failed") {
        await bestEffort(
          this.linearClient.addComment(task.linearTicketId, `${summary}\nError: ${session.error}`),
          this.logger, "Linear comment"
        );
      }
    }

    if (task.id.startsWith("gh_") && this.githubClient) {
      const issueNumber = parseInt(task.title.match(/#(\d+)/)?.[1] ?? "0");
      if (issueNumber > 0) {
        await bestEffort(this.githubClient.addComment(issueNumber, summary), this.logger, "GitHub comment");
        await bestEffort(this.githubClient.removeLabel(issueNumber, "agent-working"), this.logger, "GitHub remove label");
        if (session.status === "completed") {
          await bestEffort(this.githubClient.addLabels(issueNumber, ["agent-completed"]), this.logger, "GitHub add label");
        } else if (session.status === "failed") {
          await bestEffort(this.githubClient.addLabels(issueNumber, ["agent-failed"]), this.logger, "GitHub add label");
        }
      }
    }

    if (task.id.startsWith("slack_") && this.slackClient) {
      const parts = task.id.split("_");
      const channel = parts[1];
      const ts = parts[2];
      if (channel) {
        await bestEffort(this.slackClient.postMessage(channel, summary, ts), this.logger, "Slack message");
        if (ts) {
          const emoji = session.status === "completed" ? "white_check_mark" : "x";
          await bestEffort(this.slackClient.addReaction(channel, ts, emoji), this.logger, "Slack reaction");
        }
      }
    }
  }
}
