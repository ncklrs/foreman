/**
 * Core agentic execution loop.
 * Sends messages to the model, processes tool-use responses,
 * executes tools, and feeds results back until task completion.
 *
 * Integrates:
 * - Context window management (auto-summarization)
 * - Multi-turn recovery (error/loop/stall detection)
 * - Tool result caching (avoid re-reading unchanged files)
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
import { ContextManager } from "./context.js";
import { RecoveryManager } from "./recovery.js";
import { ToolResultCache } from "./cache.js";

interface AgentLoopOptions {
  task: AgentTask;
  provider: ModelProvider;
  config: ForemanConfig;
  workingDir: string;
  maxIterations?: number;
  /** Optional provider for summarization (use a fast/cheap model). */
  summarizationProvider?: ModelProvider;
  onEvent?: (event: ForemanEvent) => void;
  onApprovalRequired?: (evaluation: PolicyEvaluation) => Promise<boolean>;
}

export class AgentLoop extends EventEmitter {
  private session: AgentSession;
  private provider: ModelProvider;
  private toolExecutor: ToolExecutor;
  private policyEngine: PolicyEngine;
  private contextManager: ContextManager;
  private recoveryManager: RecoveryManager;
  private toolCache: ToolResultCache;
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

    // Initialize context manager with model's context window
    const capabilities = options.provider.capabilities();
    this.contextManager = new ContextManager({
      maxContextTokens: capabilities.maxContextWindow,
      summarizationThreshold: 0.75,
      preserveRecentMessages: 12,
      summarizationProvider: options.summarizationProvider,
    });

    // Initialize recovery manager with known tool names
    this.recoveryManager = new RecoveryManager({
      knownTools: new Set(CORE_TOOLS.map((t) => t.name)),
      maxConsecutiveErrors: 3,
      maxRepeatedToolCalls: 3,
      maxStallIterations: 15,
    });

    // Initialize tool result cache
    this.toolCache = new ToolResultCache();

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

      const systemPromptTokens = Math.ceil(systemPrompt.length / 4);

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

        // Context window management: summarize old messages if needed
        this.session.messages = await this.contextManager.manage(
          this.session.messages,
          systemPromptTokens
        );

        // Call the model
        let response: ChatResponse;
        try {
          response = await this.provider.chat({
            messages: this.session.messages,
            tools: CORE_TOOLS,
            systemPrompt,
            maxTokens: this.config.models[this.session.task.assignedModel ?? "coder"]?.maxTokens ?? 4096,
            temperature: this.config.models[this.session.task.assignedModel ?? "coder"]?.temperature ?? 0.2,
          });
        } catch (error) {
          // Model error — attempt recovery
          const recovery = this.recoveryManager.recordError(
            error instanceof Error ? error.message : String(error)
          );

          if (recovery.type === "abort") {
            this.session.status = "failed";
            this.session.error = recovery.reason;
            this.onEvent({
              type: "agent:failed",
              session: this.getSession(),
              error: recovery.reason,
            });
            break;
          }

          if (recovery.type === "inject_message") {
            this.session.messages.push(recovery.message);
          }
          continue;
        }

        // Track token usage
        this.session.tokenUsage.inputTokens += response.usage.inputTokens;
        this.session.tokenUsage.outputTokens += response.usage.outputTokens;

        // Recovery analysis: check for hallucinated tools, loops, stalls
        const recovery = this.recoveryManager.analyze(response);
        if (recovery.type === "abort") {
          this.session.status = "failed";
          this.session.error = recovery.reason;
          this.onEvent({
            type: "agent:failed",
            session: this.getSession(),
            error: recovery.reason,
          });
          break;
        }

        // Add assistant response to conversation
        this.session.messages.push({
          role: "assistant",
          content: response.content,
        });

        // If recovery injected a corrective message, add it and continue
        if (recovery.type === "inject_message") {
          this.session.messages.push(recovery.message);
          continue;
        }

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
              toolResults.push({
                role: "tool",
                content: `Tool call requires approval but no approval handler configured: ${policyEval.reason}`,
                toolCallId: toolCall.id,
              });
              continue;
            }
          }

          // Check tool result cache (for read-only operations)
          const cached = this.toolCache.get(toolCall.name, toolCall.input);
          if (cached !== null) {
            this.onEvent({
              type: "agent:tool_result",
              sessionId: this.session.id,
              toolName: toolCall.name,
              result: { output: cached, isError: false, duration: 0 },
            });

            toolResults.push({
              role: "tool",
              content: cached,
              toolCallId: toolCall.id,
            });
            continue;
          }

          // Execute the tool
          const result = await this.toolExecutor.execute(
            toolCall.name,
            toolCall.input
          );

          // Cache the result and track writes
          if (!result.isError) {
            this.toolCache.set(toolCall.name, toolCall.input, result.output);
          }
          if (toolCall.name === "write_file" || toolCall.name === "edit_file" || toolCall.name === "run_command") {
            this.toolCache.recordWrite(toolCall.name, toolCall.input);
          }

          // Record tool errors for recovery tracking
          if (result.isError) {
            this.recoveryManager.recordToolError(toolCall.name, result.output);
          }

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
      const treeResult = await this.toolExecutor.execute("run_command", {
        command:
          "find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -100 | sort",
        timeout: 5000,
      });

      let packageInfo: Record<string, unknown> | undefined;
      try {
        const pkgResult = await this.toolExecutor.execute("read_file", {
          path: "package.json",
        });
        if (!pkgResult.isError) {
          const rawContent = pkgResult.output
            .split("\n")
            .map((line) => line.replace(/^\d+\t/, ""))
            .join("\n");
          packageInfo = JSON.parse(rawContent) as Record<string, unknown>;
        }
      } catch {
        // No package.json
      }

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
        // Not a git repo
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
