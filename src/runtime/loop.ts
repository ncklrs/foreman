/**
 * Core agentic execution loop.
 * Sends messages to the model, processes tool-use responses,
 * executes tools, and feeds results back until task completion.
 */

import { EventEmitter } from "node:events";
import type {
  AgentSession,
  AgentTask,
  ChatMessage,
  ChatResponse,
  ContentBlock,
  ForemanConfig,
  ForemanEvent,
  PolicyEvaluation,
  StreamEvent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  TokenUsage,
} from "../types/index.js";
import type { ModelProvider } from "../providers/base.js";
import { ToolExecutor } from "../tools/executor.js";
import { CORE_TOOLS } from "../tools/definitions.js";
import { buildSystemPrompt, buildCodebaseContext } from "./prompt.js";
import { PolicyEngine } from "../policy/engine.js";

interface AgentLoopOptions {
  task: AgentTask;
  provider: ModelProvider;
  config: ForemanConfig;
  workingDir: string;
  maxIterations?: number;
  onEvent?: (event: ForemanEvent) => void;
  onApprovalRequired?: (evaluation: PolicyEvaluation) => Promise<boolean>;
}

export class AgentLoop extends EventEmitter {
  private session: AgentSession;
  private provider: ModelProvider;
  private toolExecutor: ToolExecutor;
  private policyEngine: PolicyEngine;
  private config: ForemanConfig;
  private workingDir: string;
  private onEvent: (event: ForemanEvent) => void;
  private onApprovalRequired?: (evaluation: PolicyEvaluation) => Promise<boolean>;
  private aborted = false;

  constructor(options: AgentLoopOptions) {
    super();
    this.provider = options.provider;
    this.config = options.config;
    this.workingDir = options.workingDir;
    this.toolExecutor = new ToolExecutor(options.workingDir);
    this.policyEngine = new PolicyEngine(options.config.policy);
    this.onEvent = options.onEvent ?? (() => {});
    this.onApprovalRequired = options.onApprovalRequired;

    this.session = {
      id: generateId(),
      task: options.task,
      status: "idle",
      modelName: options.provider.modelId,
      messages: [],
      iterations: 0,
      maxIterations: options.maxIterations ?? 50,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      startedAt: new Date(),
      artifacts: [],
    };
  }

  getSession(): AgentSession {
    return { ...this.session };
  }

  abort(): void {
    this.aborted = true;
    this.session.status = "failed";
    this.session.error = "Aborted by user";
  }

  async run(): Promise<AgentSession> {
    this.session.status = "running";
    this.onEvent({ type: "agent:started", session: this.getSession() });

    try {
      // Build system prompt with codebase context
      const codebaseContext = await this.gatherCodebaseContext();
      const systemPrompt = buildSystemPrompt(
        this.session.task,
        codebaseContext,
        this.config.policy
      );

      // Initial user message with the task
      this.session.messages.push({
        role: "user",
        content: `Please complete the following task:\n\n${this.session.task.title}\n\n${this.session.task.description}`,
      });

      // Main agentic loop
      while (
        this.session.iterations < this.session.maxIterations &&
        this.session.status === "running" &&
        !this.aborted
      ) {
        this.session.iterations++;
        this.onEvent({
          type: "agent:iteration",
          session: this.getSession(),
          iteration: this.session.iterations,
        });

        // Call the model
        const response = await this.provider.chat({
          messages: this.session.messages,
          tools: CORE_TOOLS,
          systemPrompt,
          maxTokens: this.config.models[this.session.task.assignedModel ?? "coder"]?.maxTokens ?? 4096,
          temperature: this.config.models[this.session.task.assignedModel ?? "coder"]?.temperature ?? 0.2,
        });

        // Track token usage
        this.session.tokenUsage.inputTokens += response.usage.inputTokens;
        this.session.tokenUsage.outputTokens += response.usage.outputTokens;

        // Add assistant response to conversation
        this.session.messages.push({
          role: "assistant",
          content: response.content,
        });

        // Emit text content for streaming display
        for (const block of response.content) {
          if (block.type === "text") {
            this.onEvent({
              type: "agent:stream",
              sessionId: this.session.id,
              event: { type: "text_delta", text: block.text },
            });
          }
        }

        // Check if the model wants to use tools
        const toolUseBlocks = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use"
        );

        if (toolUseBlocks.length === 0) {
          // No tool use — check if the model signaled completion
          if (response.stopReason === "end_turn") {
            // Model finished without calling task_done.
            // This could mean it's stuck or it considers the task done.
            this.session.status = "completed";
            this.session.completedAt = new Date();
            break;
          }
          continue;
        }

        // Process tool calls
        const toolResults: ChatMessage[] = [];

        for (const toolCall of toolUseBlocks) {
          // Check if task_done was called
          if (toolCall.name === "task_done") {
            this.session.status = "completed";
            this.session.completedAt = new Date();
            this.session.artifacts.push({
              type: "log",
              content: (toolCall.input.summary as string) ?? "Task completed",
              createdAt: new Date(),
            });

            this.onEvent({
              type: "agent:completed",
              session: this.getSession(),
            });

            // Add final tool result
            toolResults.push({
              role: "tool",
              content: "Task marked as complete.",
              toolCallId: toolCall.id,
            });
            break;
          }

          // Policy check
          const policyEval = this.policyEngine.evaluate(
            toolCall.name,
            toolCall.input
          );

          this.onEvent({
            type: "agent:tool_call",
            sessionId: this.session.id,
            toolName: toolCall.name,
            input: toolCall.input,
          });

          if (policyEval.decision === "deny") {
            toolResults.push({
              role: "tool",
              content: `Tool call denied by policy: ${policyEval.reason}`,
              toolCallId: toolCall.id,
            });
            continue;
          }

          if (policyEval.decision === "require_approval") {
            this.onEvent({
              type: "agent:approval_required",
              session: this.getSession(),
              evaluation: policyEval,
            });

            if (this.onApprovalRequired) {
              const approved = await this.onApprovalRequired(policyEval);
              if (!approved) {
                toolResults.push({
                  role: "tool",
                  content: `Tool call rejected by human reviewer: ${policyEval.reason}`,
                  toolCallId: toolCall.id,
                });
                continue;
              }
            } else {
              // No approval handler — deny by default
              toolResults.push({
                role: "tool",
                content: `Tool call requires approval but no approval handler configured: ${policyEval.reason}`,
                toolCallId: toolCall.id,
              });
              continue;
            }
          }

          // Execute the tool
          const result = await this.toolExecutor.execute(
            toolCall.name,
            toolCall.input
          );

          this.onEvent({
            type: "agent:tool_result",
            sessionId: this.session.id,
            toolName: toolCall.name,
            result,
          });

          toolResults.push({
            role: "tool",
            content: result.output,
            toolCallId: toolCall.id,
          });
        }

        // Add tool results to conversation
        this.session.messages.push(...toolResults);

        // If task was completed via task_done, exit the loop
        if (this.session.status === "completed") {
          break;
        }
      }

      // Check if we hit the iteration limit
      if (
        this.session.iterations >= this.session.maxIterations &&
        this.session.status === "running"
      ) {
        this.session.status = "failed";
        this.session.error = `Reached maximum iteration limit (${this.session.maxIterations})`;
        this.onEvent({
          type: "agent:failed",
          session: this.getSession(),
          error: this.session.error,
        });
      }
    } catch (error) {
      this.session.status = "failed";
      this.session.error =
        error instanceof Error ? error.message : String(error);
      this.onEvent({
        type: "agent:failed",
        session: this.getSession(),
        error: this.session.error,
      });
    }

    this.session.completedAt = this.session.completedAt ?? new Date();
    return this.getSession();
  }

  private async gatherCodebaseContext(): Promise<string> {
    try {
      // Get project structure (limited depth)
      const treeResult = await this.toolExecutor.execute("run_command", {
        command:
          "find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -100 | sort",
        timeout: 5000,
      });

      // Try to read package.json for project info
      let packageInfo: Record<string, unknown> | undefined;
      try {
        const pkgResult = await this.toolExecutor.execute("read_file", {
          path: "package.json",
        });
        if (!pkgResult.isError) {
          // Strip line numbers from the read_file output
          const rawContent = pkgResult.output
            .split("\n")
            .map((line) => line.replace(/^\d+\t/, ""))
            .join("\n");
          packageInfo = JSON.parse(rawContent) as Record<string, unknown>;
        }
      } catch {
        // No package.json — that's fine
      }

      // Get recent git commits
      let recentCommits: string | undefined;
      try {
        const gitResult = await this.toolExecutor.execute("run_command", {
          command: "git log --oneline -10 2>/dev/null",
          timeout: 5000,
        });
        if (!gitResult.isError && gitResult.output.trim()) {
          recentCommits = gitResult.output;
        }
      } catch {
        // Not a git repo or git not available
      }

      return buildCodebaseContext(
        treeResult.isError ? "" : treeResult.output,
        recentCommits,
        packageInfo
      );
    } catch {
      return "";
    }
  }
}

function generateId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
