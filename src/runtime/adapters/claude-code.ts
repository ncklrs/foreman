/**
 * Claude Code Adapter.
 *
 * Uses the `claude` CLI as the agent execution runtime instead of
 * Foreman's built-in AgentLoop. This lets users harness Claude Code's
 * native coding capabilities (file editing, terminal, search, etc.)
 * while Foreman provides the surrounding infrastructure:
 *
 * - Task orchestration & scheduling
 * - Cross-session learning (KnowledgeStore)
 * - AGENTS.md project conventions
 * - Skills registry
 * - Autopilot cron scanning
 * - Policy/approval governance
 * - HTTP API & WebSocket streaming
 * - Multi-agent coordination
 * - Cost tracking & metrics
 *
 * The adapter spawns `claude` as a subprocess with --print mode,
 * captures its streaming JSON output, and translates it into
 * ForemanEvents for the TUI/API/event bus.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  AgentSession,
  AgentTask,
  ForemanConfig,
  ForemanEvent,
  TokenUsage,
} from "../../types/index.js";
import type { PromptEnrichment } from "../prompt.js";
import { generateId } from "../../utils/id.js";

export interface ClaudeCodeRunnerOptions {
  task: AgentTask;
  config: ForemanConfig;
  workingDir: string;
  /** Max turns (--max-turns flag). */
  maxTurns?: number;
  /** Model override (e.g., "claude-sonnet-4-5-20250929"). */
  model?: string;
  /** Additional system prompt to prepend (lessons, AGENTS.md, skills). */
  promptEnrichment?: PromptEnrichment;
  /** Environment variables to set for the claude process. */
  env?: Record<string, string>;
  /** Callback for Foreman events. */
  onEvent?: (event: ForemanEvent) => void;
  /** Allowed tools pattern (--allowedTools flag). */
  allowedTools?: string[];
  /** Disallowed tools pattern (--disallowedTools flag). */
  disallowedTools?: string[];
  /** Permission mode: auto-accept tool calls. */
  dangerouslyAutoApprove?: boolean;
}

/** Parsed line from claude --print --output-format stream-json. */
interface ClaudeStreamMessage {
  type: "system" | "result" | "assistant" | "user";
  subtype?: "init" | "tool_use" | "tool_result" | "text";
  session_id?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
    model?: string;
  };
  result?: {
    text?: string;
    cost_usd?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    num_turns?: number;
    session_id?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  tool_use?: {
    name: string;
    input: Record<string, unknown>;
  };
  tool_result?: {
    content: string;
    is_error?: boolean;
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export class ClaudeCodeRunner extends EventEmitter {
  private options: ClaudeCodeRunnerOptions;
  private session: AgentSession;
  private process: ChildProcess | null = null;
  private aborted = false;
  private onEvent: (event: ForemanEvent) => void;

  constructor(options: ClaudeCodeRunnerOptions) {
    super();
    this.options = options;
    this.onEvent = options.onEvent ?? (() => {});

    this.session = {
      id: generateId("cc"),
      task: options.task,
      status: "idle",
      modelName: options.model ?? "claude-sonnet-4-5-20250929",
      messages: [],
      iterations: 0,
      maxIterations: options.maxTurns ?? 50,
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
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
  }

  /**
   * Run the Claude Code CLI and capture its output.
   * Uses `claude --print --output-format stream-json` for structured streaming.
   */
  async run(): Promise<AgentSession> {
    this.session.status = "running";
    this.onEvent({ type: "agent:started", session: this.getSession() });

    try {
      const prompt = this.buildPrompt();
      const args = this.buildArgs(prompt);

      const result = await this.spawnClaude(args);

      this.session.tokenUsage = result.tokenUsage;
      this.session.iterations = result.turns;

      if (this.aborted) {
        this.session.status = "failed";
        this.session.error = "Aborted by user";
      } else if (result.exitCode === 0) {
        this.session.status = "completed";
      } else {
        this.session.status = "failed";
        this.session.error = result.error ?? `Claude Code exited with code ${result.exitCode}`;
      }

      if (result.summary) {
        this.session.artifacts.push({
          type: "log",
          content: result.summary,
          createdAt: new Date(),
        });
      }

      this.session.completedAt = new Date();
    } catch (error) {
      this.session.status = "failed";
      this.session.error = error instanceof Error ? error.message : String(error);
      this.session.completedAt = new Date();
    }

    const eventType = this.session.status === "completed" ? "agent:completed" : "agent:failed";
    if (eventType === "agent:failed") {
      this.onEvent({ type: "agent:failed", session: this.getSession(), error: this.session.error ?? "Unknown error" });
    } else {
      this.onEvent({ type: "agent:completed", session: this.getSession() });
    }

    return this.getSession();
  }

  /** Build the task prompt, injecting enrichment from Foreman's learning system. */
  private buildPrompt(): string {
    const sections: string[] = [];

    // Core task
    sections.push(`Task: ${this.options.task.title}\n\n${this.options.task.description}`);

    // Repository/branch context
    if (this.options.task.repository) {
      sections.push(`Repository: ${this.options.task.repository}`);
    }
    if (this.options.task.branch) {
      sections.push(`Branch: ${this.options.task.branch}`);
    }

    // Inject lessons from KnowledgeStore
    if (this.options.promptEnrichment?.lessonsSection) {
      sections.push(this.options.promptEnrichment.lessonsSection);
    }

    // Inject AGENTS.md conventions
    if (this.options.promptEnrichment?.agentsMdSection) {
      sections.push(this.options.promptEnrichment.agentsMdSection);
    }

    // Inject active skills
    if (this.options.promptEnrichment?.skillsSection) {
      sections.push(this.options.promptEnrichment.skillsSection);
    }

    return sections.join("\n\n");
  }

  /** Build CLI arguments for the claude command. */
  private buildArgs(prompt: string): string[] {
    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
    ];

    // Model override
    if (this.options.model) {
      args.push("--model", this.options.model);
    }

    // Max turns
    if (this.options.maxTurns) {
      args.push("--max-turns", String(this.options.maxTurns));
    }

    // Permission mode
    if (this.options.dangerouslyAutoApprove) {
      args.push("--dangerously-skip-permissions");
    }

    // Allowed/disallowed tools
    if (this.options.allowedTools?.length) {
      args.push("--allowedTools", this.options.allowedTools.join(","));
    }
    if (this.options.disallowedTools?.length) {
      args.push("--disallowedTools", this.options.disallowedTools.join(","));
    }

    // Prompt as the final positional argument
    args.push("--", prompt);

    return args;
  }

  /** Spawn the claude CLI process and stream its output. */
  private spawnClaude(args: string[]): Promise<{
    exitCode: number;
    tokenUsage: TokenUsage;
    turns: number;
    summary: string;
    error?: string;
  }> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ...this.options.env,
      };

      this.process = spawn("claude", args, {
        cwd: this.options.workingDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let turns = 0;
      let summary = "";
      let errorOutput = "";
      let lineBuffer = "";

      this.process.stdout?.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString("utf-8");

        // Process complete lines
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          this.processStreamLine(line.trim(), (msg) => {
            // Track token usage from result messages
            if (msg.type === "result" && msg.result) {
              if (msg.result.usage) {
                tokenUsage = {
                  inputTokens: msg.result.usage.input_tokens ?? 0,
                  outputTokens: msg.result.usage.output_tokens ?? 0,
                };
              }
              turns = msg.result.num_turns ?? turns;
              summary = msg.result.text ?? "";

              if (msg.result.session_id) {
                this.session.modelName = msg.result.session_id;
              }
            }

            // Track turns from assistant messages
            if (msg.type === "assistant") {
              turns++;
              this.session.iterations = turns;
              this.onEvent({
                type: "agent:iteration",
                session: this.getSession(),
                iteration: turns,
              });
            }

            // Emit tool calls
            if (msg.subtype === "tool_use" && msg.tool_use) {
              this.onEvent({
                type: "agent:tool_call",
                sessionId: this.session.id,
                toolName: msg.tool_use.name,
                input: msg.tool_use.input,
              });
            }

            // Emit text deltas
            if (msg.type === "assistant" && msg.message?.content) {
              const text = typeof msg.message.content === "string"
                ? msg.message.content
                : msg.message.content
                    .filter((b): b is { type: "text"; text: string } => b.type === "text")
                    .map((b) => b.text)
                    .join("");
              if (text) {
                this.onEvent({
                  type: "agent:stream",
                  sessionId: this.session.id,
                  event: { type: "text_delta", text },
                });
              }
            }
          });
        }
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        errorOutput += chunk.toString("utf-8");
      });

      this.process.on("error", (err) => {
        if (err.message.includes("ENOENT")) {
          reject(new Error(
            "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
          ));
        } else {
          reject(err);
        }
      });

      this.process.on("close", (code) => {
        // Process any remaining buffer
        if (lineBuffer.trim()) {
          this.processStreamLine(lineBuffer.trim(), (msg) => {
            if (msg.type === "result" && msg.result) {
              if (msg.result.usage) {
                tokenUsage = {
                  inputTokens: msg.result.usage.input_tokens ?? 0,
                  outputTokens: msg.result.usage.output_tokens ?? 0,
                };
              }
              turns = msg.result.num_turns ?? turns;
              summary = msg.result.text ?? "";
            }
          });
        }

        resolve({
          exitCode: code ?? 1,
          tokenUsage,
          turns,
          summary,
          error: code !== 0 ? errorOutput.slice(0, 500) || undefined : undefined,
        });
      });
    });
  }

  /** Parse a single stream-json line from claude --print. */
  private processStreamLine(
    line: string,
    handler: (msg: ClaudeStreamMessage) => void
  ): void {
    try {
      const msg = JSON.parse(line) as ClaudeStreamMessage;
      handler(msg);
    } catch {
      // Non-JSON output — emit as raw text
      this.onEvent({
        type: "agent:stream",
        sessionId: this.session.id,
        event: { type: "text_delta", text: line + "\n" },
      });
    }
  }
}
