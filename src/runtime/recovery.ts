/**
 * Multi-turn recovery system.
 * Detects and recovers from:
 * - Model errors and malformed responses
 * - Hallucinated tool calls (non-existent tools, invalid arguments)
 * - Infinite loops (repeated identical tool calls)
 * - Stuck agents (no progress over N iterations)
 */

import type { ChatMessage, ChatResponse, ContentBlock, ToolUseBlock } from "../types/index.js";

export interface RecoveryOptions {
  /** Max consecutive errors before aborting. */
  maxConsecutiveErrors: number;
  /** Max identical tool calls before detecting a loop. */
  maxRepeatedToolCalls: number;
  /** Max iterations without file writes before detecting stall. */
  maxStallIterations: number;
  /** Known tool names for hallucination detection. */
  knownTools: Set<string>;
}

export type RecoveryAction =
  | { type: "continue" }
  | { type: "inject_message"; message: ChatMessage }
  | { type: "abort"; reason: string };

interface ToolCallSignature {
  name: string;
  inputHash: string;
}

export class RecoveryManager {
  private options: RecoveryOptions;
  private consecutiveErrors = 0;
  private recentToolCalls: ToolCallSignature[] = [];
  private iterationsSinceWrite = 0;
  private totalErrors = 0;

  constructor(options: Partial<RecoveryOptions> & { knownTools: Set<string> }) {
    this.options = {
      maxConsecutiveErrors: options.maxConsecutiveErrors ?? 3,
      maxRepeatedToolCalls: options.maxRepeatedToolCalls ?? 3,
      maxStallIterations: options.maxStallIterations ?? 10,
      knownTools: options.knownTools,
    };
  }

  /**
   * Analyze a model response and determine recovery action.
   */
  analyze(response: ChatResponse): RecoveryAction {
    // Reset error counter on successful response
    this.consecutiveErrors = 0;

    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );

    // Check for hallucinated tools
    for (const block of toolUseBlocks) {
      if (!this.options.knownTools.has(block.name)) {
        this.totalErrors++;
        return {
          type: "inject_message",
          message: {
            role: "user",
            content: `Error: "${block.name}" is not a valid tool. Available tools are: ${Array.from(this.options.knownTools).join(", ")}. Please use only the provided tools.`,
          },
        };
      }
    }

    // Check for infinite loops (repeated identical tool calls)
    if (toolUseBlocks.length > 0) {
      const signatures = toolUseBlocks.map((b) => ({
        name: b.name,
        inputHash: hashObject(b.input),
      }));

      // Check if we're repeating
      const loopDetected = this.detectLoop(signatures);
      if (loopDetected) {
        return {
          type: "inject_message",
          message: {
            role: "user",
            content: `You appear to be repeating the same tool calls. This suggests you may be stuck in a loop. Please take a different approach or, if the task is complete, call the task_done tool.`,
          },
        };
      }

      // Track writes for stall detection
      const hasWrite = toolUseBlocks.some(
        (b) => b.name === "write_file" || b.name === "edit_file"
      );
      if (hasWrite) {
        this.iterationsSinceWrite = 0;
      } else {
        this.iterationsSinceWrite++;
      }
    } else {
      this.iterationsSinceWrite++;
    }

    // Check for stalled agent (too many iterations without writes)
    if (this.iterationsSinceWrite >= this.options.maxStallIterations) {
      return {
        type: "inject_message",
        message: {
          role: "user",
          content: `You have gone ${this.iterationsSinceWrite} iterations without making any file changes. If you are analyzing the codebase, please proceed with implementation. If the task is complete, call the task_done tool. If you are blocked, explain the issue.`,
        },
      };
    }

    // Check for empty responses
    const hasContent = response.content.some(
      (b) => (b.type === "text" && b.text.trim()) || b.type === "tool_use"
    );
    if (!hasContent) {
      this.totalErrors++;
      return {
        type: "inject_message",
        message: {
          role: "user",
          content: "Your previous response was empty. Please continue working on the task or call task_done if complete.",
        },
      };
    }

    return { type: "continue" };
  }

  /**
   * Record a model error (API failure, malformed response, etc.)
   */
  recordError(error: string): RecoveryAction {
    this.consecutiveErrors++;
    this.totalErrors++;

    if (this.consecutiveErrors >= this.options.maxConsecutiveErrors) {
      return {
        type: "abort",
        reason: `${this.consecutiveErrors} consecutive errors: ${error}`,
      };
    }

    return {
      type: "inject_message",
      message: {
        role: "user",
        content: `An error occurred: ${error}. Please try a different approach.`,
      },
    };
  }

  /**
   * Record a tool execution error.
   */
  recordToolError(toolName: string, error: string): RecoveryAction {
    this.totalErrors++;

    // Tool errors are normal — the model should handle them
    // But track repeated failures on the same tool
    return { type: "continue" };
  }

  /** Get recovery statistics. */
  getStats(): { totalErrors: number; consecutiveErrors: number; iterationsSinceWrite: number } {
    return {
      totalErrors: this.totalErrors,
      consecutiveErrors: this.consecutiveErrors,
      iterationsSinceWrite: this.iterationsSinceWrite,
    };
  }

  private detectLoop(signatures: ToolCallSignature[]): boolean {
    // Add new signatures to history
    this.recentToolCalls.push(...signatures);

    // Keep last N signatures
    const maxHistory = this.options.maxRepeatedToolCalls * 3;
    if (this.recentToolCalls.length > maxHistory) {
      this.recentToolCalls = this.recentToolCalls.slice(-maxHistory);
    }

    // Check if the same signature appears too many times recently
    const recent = this.recentToolCalls.slice(-this.options.maxRepeatedToolCalls * 2);
    const counts = new Map<string, number>();

    for (const sig of recent) {
      const key = `${sig.name}:${sig.inputHash}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const count of counts.values()) {
      if (count >= this.options.maxRepeatedToolCalls) {
        // Reset to allow the corrective message to take effect
        this.recentToolCalls = [];
        return true;
      }
    }

    return false;
  }
}

function hashObject(obj: Record<string, unknown>): string {
  const str = JSON.stringify(obj, Object.keys(obj).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}
