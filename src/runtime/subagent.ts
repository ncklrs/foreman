/**
 * Sub-agent spawner.
 * Allows an agent to delegate subtasks to a new agent with a different model.
 * The parent agent can spawn a child agent, wait for its result, and incorporate
 * the output into its own context.
 */

import type {
  AgentTask,
  AgentSession,
  ForemanConfig,
  ForemanEvent,
  ToolDefinition,
} from "../types/index.js";
import type { ModelProvider } from "../providers/base.js";
import { ProviderRegistry } from "../providers/registry.js";
import { AgentLoop } from "./loop.js";

export interface SubAgentRequest {
  /** Brief title for the subtask. */
  title: string;
  /** Detailed description of what the sub-agent should accomplish. */
  description: string;
  /** Which model role to use (e.g., "fast", "coder", "architect"). */
  modelRole?: string;
  /** Maximum iterations for the sub-agent. */
  maxIterations?: number;
  /** Working directory (inherits from parent if not specified). */
  workingDir?: string;
}

export interface SubAgentResult {
  success: boolean;
  summary: string;
  filesChanged: string[];
  tokenUsage: { inputTokens: number; outputTokens: number };
  iterations: number;
  error?: string;
}

export class SubAgentSpawner {
  private config: ForemanConfig;
  private registry: ProviderRegistry;
  private parentWorkingDir: string;
  private onEvent: (event: ForemanEvent) => void;
  private activeSubAgents: Map<string, AgentLoop> = new Map();

  constructor(
    config: ForemanConfig,
    registry: ProviderRegistry,
    parentWorkingDir: string,
    onEvent?: (event: ForemanEvent) => void
  ) {
    this.config = config;
    this.registry = registry;
    this.parentWorkingDir = parentWorkingDir;
    this.onEvent = onEvent ?? (() => {});
  }

  /**
   * Spawn a sub-agent to handle a subtask.
   * Returns the result when the sub-agent completes.
   */
  async spawn(request: SubAgentRequest): Promise<SubAgentResult> {
    const modelRole = request.modelRole ?? "fast";
    const provider = this.registry.get(modelRole);

    if (!provider) {
      return {
        success: false,
        summary: `No provider available for role: ${modelRole}`,
        filesChanged: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        iterations: 0,
        error: `No provider for role: ${modelRole}`,
      };
    }

    const task: AgentTask = {
      id: `subtask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: request.title,
      description: request.description,
      assignedModel: modelRole,
    };

    const loop = new AgentLoop({
      task,
      provider,
      config: this.config,
      workingDir: request.workingDir ?? this.parentWorkingDir,
      maxIterations: request.maxIterations ?? 20,
      onEvent: this.onEvent,
    });

    this.activeSubAgents.set(task.id, loop);

    try {
      const session = await loop.run();

      const filesChanged = this.extractFilesChanged(session);
      const summary = this.extractSummary(session);

      return {
        success: session.status === "completed",
        summary,
        filesChanged,
        tokenUsage: session.tokenUsage,
        iterations: session.iterations,
        error: session.error,
      };
    } finally {
      this.activeSubAgents.delete(task.id);
    }
  }

  /** Abort all active sub-agents. */
  abortAll(): void {
    for (const [, loop] of this.activeSubAgents) {
      loop.abort();
    }
    this.activeSubAgents.clear();
  }

  /** Get the number of active sub-agents. */
  getActiveCount(): number {
    return this.activeSubAgents.size;
  }

  /**
   * Create a tool definition that allows the parent agent to spawn sub-agents.
   * This can be added to the parent's tool set.
   */
  static getToolDefinition(): ToolDefinition {
    return {
      name: "spawn_subagent",
      description:
        "Delegate a subtask to a separate agent that can work independently. " +
        "Use this for tasks that are clearly separable and can be handled by a different model. " +
        "For example, delegating a code review to a fast model while the main agent continues implementation, " +
        "or having a specialized model handle a complex algorithmic subtask.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Brief title for the subtask",
          },
          description: {
            type: "string",
            description: "Detailed description of what the sub-agent should accomplish",
          },
          model_role: {
            type: "string",
            description: "Which model role to use (e.g., 'fast', 'coder', 'architect', 'reviewer')",
          },
          max_iterations: {
            type: "number",
            description: "Maximum iterations for the sub-agent (default: 20)",
          },
        },
        required: ["title", "description"],
      },
    };
  }

  private extractFilesChanged(session: AgentSession): string[] {
    const files = new Set<string>();

    for (const msg of session.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            if (
              (block.name === "write_file" || block.name === "edit_file") &&
              input.path
            ) {
              files.add(String(input.path));
            }
          }
        }
      }
    }

    return Array.from(files);
  }

  private extractSummary(session: AgentSession): string {
    // Look for task_done summary in artifacts
    const doneArtifact = session.artifacts.find(
      (a) => a.type === "log" && a.content !== "Task completed"
    );
    if (doneArtifact) return doneArtifact.content;

    // Fall back to last assistant text message
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") return msg.content.slice(0, 500);
        if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find(
            (b): b is { type: "text"; text: string } => b.type === "text"
          );
          if (textBlock) return textBlock.text.slice(0, 500);
        }
      }
    }

    return session.error ?? "Sub-agent completed without summary";
  }
}
