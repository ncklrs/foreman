/**
 * Multi-Agent Executor.
 *
 * Executes a TaskGraph by dispatching subtasks to agents in parallel,
 * respecting dependency ordering. Key behaviors:
 *
 * - Extracts parallel batches from the DAG
 * - Runs independent subtasks concurrently (up to concurrency limit)
 * - Skips downstream subtasks when a dependency fails
 * - Aggregates results and produces a final summary
 * - Emits events for each subtask lifecycle stage
 */

import type {
  AgentTask,
  ForemanConfig,
  ForemanEvent,
} from "../types/index.js";
import type { ModelProvider } from "../providers/base.js";
import { ProviderRegistry } from "../providers/registry.js";
import { AgentLoop } from "../runtime/loop.js";
import type { EventBus } from "../events/bus.js";
import type { Logger } from "../logging/logger.js";
import { TaskGraph, type SubTask } from "./graph.js";

export interface ExecutorOptions {
  /** Foreman configuration. */
  config: ForemanConfig;
  /** Provider registry for model selection. */
  registry: ProviderRegistry;
  /** Event bus for publishing lifecycle events. */
  eventBus: EventBus;
  /** Logger instance. */
  logger: Logger;
  /** Working directory for agents. */
  workingDir: string;
  /** Maximum concurrent subtask agents. */
  maxConcurrent?: number;
  /** Maximum iterations per subtask agent. */
  maxIterationsPerSubtask?: number;
  /** The parent task for context. */
  parentTask: AgentTask;
  /** Callback for each subtask event. */
  onEvent?: (event: ForemanEvent) => void;
}

export interface ExecutionResult {
  /** Whether all subtasks completed successfully. */
  success: boolean;
  /** The completed task graph with results. */
  graph: TaskGraph;
  /** Aggregated summary. */
  summary: string;
  /** All files changed across all subtasks. */
  filesChanged: string[];
  /** Total token usage. */
  totalTokens: { inputTokens: number; outputTokens: number };
  /** Total execution time in ms. */
  durationMs: number;
  /** Per-subtask results. */
  subtaskResults: Map<string, SubTaskResult>;
}

export interface SubTaskResult {
  subtaskId: string;
  success: boolean;
  summary: string;
  filesChanged: string[];
  tokenUsage: { inputTokens: number; outputTokens: number };
  iterations: number;
  durationMs: number;
  error?: string;
}

export class MultiAgentExecutor {
  private options: ExecutorOptions;
  private activeAgents: Map<string, AgentLoop> = new Map();
  private aborted = false;
  private waitResolvers: Array<() => void> = [];

  constructor(options: ExecutorOptions) {
    this.options = {
      maxConcurrent: options.config.foreman.maxConcurrentAgents,
      maxIterationsPerSubtask: 30,
      ...options,
    };
  }

  /**
   * Execute all subtasks in a TaskGraph, respecting dependencies.
   * Returns when all subtasks are done (completed, failed, or skipped).
   */
  async execute(graph: TaskGraph): Promise<ExecutionResult> {
    const startTime = Date.now();
    const subtaskResults = new Map<string, SubTaskResult>();
    const allFilesChanged = new Set<string>();
    let totalInput = 0;
    let totalOutput = 0;

    const { logger } = this.options;

    // Validate graph first
    const validation = graph.validate();
    if (!validation.valid) {
      throw new Error(`Invalid task graph: ${validation.errors.join("; ")}`);
    }

    logger.info(`Executing task graph: ${graph.size()} subtasks`, {
      parentTask: this.options.parentTask.title,
    });

    // Main execution loop
    while (!graph.isComplete() && !this.aborted) {
      // Skip tasks whose dependencies failed
      const skippable = graph.getSkippableTasks();
      for (const task of skippable) {
        graph.setStatus(task.id, "skipped");
        logger.info(`Skipping subtask "${task.title}" — dependency failed`);
      }

      // Get ready tasks
      const ready = graph.getReadyTasks();
      if (ready.length === 0) {
        // If nothing is ready but graph isn't complete, we're waiting for running tasks
        if (this.activeAgents.size > 0) {
          await this.waitForAny();
          continue;
        }
        break; // Deadlock or all done
      }

      // Dispatch ready tasks up to concurrency limit
      const maxConcurrent = this.options.maxConcurrent!;
      const available = maxConcurrent - this.activeAgents.size;
      const batch = ready.slice(0, Math.max(1, available));

      logger.info(`Dispatching ${batch.length} subtask(s) in parallel`, {
        subtasks: batch.map((t) => t.title),
        active: this.activeAgents.size,
      });

      // Start subtasks in parallel
      const promises = batch.map((subtask) =>
        this.executeSubtask(graph, subtask, subtaskResults, allFilesChanged)
          .then((result) => {
            totalInput += result.tokenUsage.inputTokens;
            totalOutput += result.tokenUsage.outputTokens;
          })
      );

      // Wait for at least one to complete before checking for new ready tasks
      await Promise.race(promises);

      // Let remaining promises continue but don't block
      // They'll be picked up in the next iteration via activeAgents check
    }

    // Wait for any remaining agents
    while (this.activeAgents.size > 0) {
      await this.waitForAny();
    }

    // Build summary
    const stats = graph.getStats();
    const summary = this.buildSummary(graph, subtaskResults);
    const durationMs = Date.now() - startTime;

    logger.info(`Task graph execution complete`, {
      ...stats,
      durationMs,
      filesChanged: allFilesChanged.size,
    });

    return {
      success: stats.failed === 0 && stats.skipped === 0,
      graph,
      summary,
      filesChanged: Array.from(allFilesChanged),
      totalTokens: { inputTokens: totalInput, outputTokens: totalOutput },
      durationMs,
      subtaskResults,
    };
  }

  /** Abort all running subtasks. */
  abort(): void {
    this.aborted = true;
    for (const [id, agent] of this.activeAgents) {
      agent.abort();
    }
    this.activeAgents.clear();
  }

  private async executeSubtask(
    graph: TaskGraph,
    subtask: SubTask,
    results: Map<string, SubTaskResult>,
    allFiles: Set<string>
  ): Promise<SubTaskResult> {
    const { config, registry, logger, workingDir, onEvent } = this.options;
    const startTime = Date.now();

    graph.setStatus(subtask.id, "running");

    // Select provider based on subtask's model role
    const modelRole = subtask.modelRole ?? "coder";
    const provider = registry.get(modelRole) ?? registry.get("coder");

    if (!provider) {
      const result: SubTaskResult = {
        subtaskId: subtask.id,
        success: false,
        summary: `No provider available for role: ${modelRole}`,
        filesChanged: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        iterations: 0,
        durationMs: Date.now() - startTime,
        error: `No provider for role: ${modelRole}`,
      };

      graph.setStatus(subtask.id, "failed");
      graph.setError(subtask.id, result.error!);
      results.set(subtask.id, result);
      return result;
    }

    // Build context from dependency results
    const depContext = this.buildDependencyContext(graph, subtask);

    const task: AgentTask = {
      id: `${this.options.parentTask.id}_${subtask.id}`,
      title: subtask.title,
      description: `${subtask.description}${depContext}`,
      labels: subtask.labels,
      assignedModel: modelRole,
    };

    const loop = new AgentLoop({
      task,
      provider,
      config,
      workingDir,
      maxIterations: this.options.maxIterationsPerSubtask,
      onEvent: onEvent ?? ((event) => this.options.eventBus.emit(event)),
    });

    this.activeAgents.set(subtask.id, loop);

    try {
      const session = await loop.run();

      const filesChanged = this.extractFilesChanged(session);
      const summary = this.extractSummary(session);

      for (const f of filesChanged) allFiles.add(f);

      const result: SubTaskResult = {
        subtaskId: subtask.id,
        success: session.status === "completed",
        summary,
        filesChanged,
        tokenUsage: session.tokenUsage,
        iterations: session.iterations,
        durationMs: Date.now() - startTime,
        error: session.error,
      };

      if (session.status === "completed") {
        graph.setStatus(subtask.id, "completed");
        graph.setResult(subtask.id, summary, filesChanged, result.durationMs);
        logger.info(`Subtask completed: "${subtask.title}"`, {
          iterations: session.iterations,
          filesChanged: filesChanged.length,
        });
      } else {
        graph.setStatus(subtask.id, "failed");
        graph.setError(subtask.id, session.error ?? "Agent failed");
        logger.warn(`Subtask failed: "${subtask.title}"`, {
          error: session.error,
        });
      }

      results.set(subtask.id, result);
      return result;
    } catch (error) {
      const result: SubTaskResult = {
        subtaskId: subtask.id,
        success: false,
        summary: `Error: ${error instanceof Error ? error.message : String(error)}`,
        filesChanged: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        iterations: 0,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };

      graph.setStatus(subtask.id, "failed");
      graph.setError(subtask.id, result.error!);
      results.set(subtask.id, result);
      return result;
    } finally {
      this.activeAgents.delete(subtask.id);
      this.notifyWaiters();
    }
  }

  /**
   * Build context from completed dependencies to inject into the subtask prompt.
   */
  private buildDependencyContext(graph: TaskGraph, subtask: SubTask): string {
    if (subtask.dependsOn.length === 0) return "";

    const sections: string[] = ["\n\n---\nContext from previous steps:"];

    for (const depId of subtask.dependsOn) {
      const dep = graph.getTask(depId);
      if (!dep || dep.status !== "completed") continue;

      sections.push(`\n## ${dep.title}`);
      if (dep.result) sections.push(dep.result);
      if (dep.filesChanged?.length) {
        sections.push(`Files changed: ${dep.filesChanged.join(", ")}`);
      }
    }

    return sections.length > 1 ? sections.join("\n") : "";
  }

  /** Wait for any active agent to complete. */
  private waitForAny(): Promise<void> {
    if (this.activeAgents.size === 0 || this.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitResolvers.push(resolve);
    });
  }

  /** Notify waiters that an agent slot has freed up. */
  private notifyWaiters(): void {
    const resolvers = this.waitResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private extractFilesChanged(session: {
    messages: Array<{ role: string; content: string | Array<{ type: string; name?: string; input?: Record<string, unknown> }> }>;
  }): string[] {
    const files = new Set<string>();
    for (const msg of session.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown> | undefined;
            if (
              (block.name === "write_file" || block.name === "edit_file") &&
              input?.path
            ) {
              files.add(String(input.path));
            }
          }
        }
      }
    }
    return Array.from(files);
  }

  private extractSummary(session: {
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    artifacts: Array<{ type: string; content: string }>;
    error?: string;
  }): string {
    const doneArtifact = session.artifacts.find(
      (a) => a.type === "log" && a.content !== "Task completed"
    );
    if (doneArtifact) return doneArtifact.content;

    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") return msg.content.slice(0, 500);
        if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find(
            (b): b is { type: "text"; text: string } => b.type === "text" && !!b.text
          );
          if (textBlock) return textBlock.text.slice(0, 500);
        }
      }
    }

    return session.error ?? "Subtask completed";
  }

  private buildSummary(graph: TaskGraph, results: Map<string, SubTaskResult>): string {
    const stats = graph.getStats();
    const lines: string[] = [
      `## Task Decomposition Results`,
      ``,
      `**${stats.completed}/${stats.total}** subtasks completed`,
    ];

    if (stats.failed > 0) lines.push(`**${stats.failed}** failed`);
    if (stats.skipped > 0) lines.push(`**${stats.skipped}** skipped`);

    lines.push("");

    for (const task of graph.getAllTasks()) {
      const icon = task.status === "completed" ? "[OK]" : task.status === "failed" ? "[FAIL]" : "[SKIP]";
      lines.push(`${icon} ${task.title}`);

      const result = results.get(task.id);
      if (result?.summary) {
        lines.push(`    ${result.summary.slice(0, 200)}`);
      }
      if (result?.error) {
        lines.push(`    Error: ${result.error}`);
      }
    }

    return lines.join("\n");
  }
}
