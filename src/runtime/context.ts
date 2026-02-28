/**
 * Context window manager.
 * Tracks token usage across the conversation and automatically
 * summarizes older messages when approaching the model's context limit.
 */

import type { ChatMessage, ContentBlock, TokenUsage } from "../types/index.js";
import type { ModelProvider } from "../providers/base.js";

export interface ContextManagerOptions {
  /** Maximum context window tokens for the model. */
  maxContextTokens: number;
  /** Trigger summarization when usage exceeds this fraction (0-1). */
  summarizationThreshold: number;
  /** Number of recent messages to always preserve. */
  preserveRecentMessages: number;
  /** Provider to use for summarization (can be a fast/cheap model). */
  summarizationProvider?: ModelProvider;
}

interface MessageTokenEstimate {
  message: ChatMessage;
  estimatedTokens: number;
  index: number;
}

export class ContextManager {
  private options: ContextManagerOptions;
  private totalEstimatedTokens = 0;

  constructor(options: Partial<ContextManagerOptions> = {}) {
    this.options = {
      maxContextTokens: options.maxContextTokens ?? 200000,
      summarizationThreshold: options.summarizationThreshold ?? 0.75,
      preserveRecentMessages: options.preserveRecentMessages ?? 10,
      summarizationProvider: options.summarizationProvider,
    };
  }

  /**
   * Check if the conversation needs summarization and apply it if so.
   * Returns the (possibly compacted) message array.
   */
  async manage(
    messages: ChatMessage[],
    systemPromptTokens: number
  ): Promise<ChatMessage[]> {
    const estimates = messages.map((msg, i) => ({
      message: msg,
      estimatedTokens: this.estimateTokens(msg),
      index: i,
    }));

    this.totalEstimatedTokens =
      systemPromptTokens +
      estimates.reduce((sum, e) => sum + e.estimatedTokens, 0);

    const threshold =
      this.options.maxContextTokens * this.options.summarizationThreshold;

    if (this.totalEstimatedTokens <= threshold) {
      return messages;
    }

    return this.summarize(estimates);
  }

  /** Get the current estimated token count. */
  getEstimatedTokens(): number {
    return this.totalEstimatedTokens;
  }

  /** Get utilization as a percentage. */
  getUtilization(): number {
    return this.totalEstimatedTokens / this.options.maxContextTokens;
  }

  private async summarize(
    estimates: MessageTokenEstimate[]
  ): Promise<ChatMessage[]> {
    const preserveCount = this.options.preserveRecentMessages;
    const totalMessages = estimates.length;

    if (totalMessages <= preserveCount + 1) {
      // Not enough messages to summarize
      return estimates.map((e) => e.message);
    }

    // Split into old (to summarize) and recent (to preserve)
    const oldMessages = estimates.slice(0, totalMessages - preserveCount);
    const recentMessages = estimates.slice(totalMessages - preserveCount);

    // Build summary of old messages
    const summary = this.buildSummary(oldMessages);

    // If we have a summarization provider, use it for a better summary
    if (this.options.summarizationProvider) {
      try {
        const aiSummary = await this.aiSummarize(oldMessages);
        if (aiSummary) {
          return [
            {
              role: "user",
              content: `[Context Summary - Previous ${oldMessages.length} messages]\n\n${aiSummary}`,
            },
            ...recentMessages.map((e) => e.message),
          ];
        }
      } catch {
        // Fall back to rule-based summary
      }
    }

    return [
      {
        role: "user",
        content: `[Context Summary - Previous ${oldMessages.length} messages]\n\n${summary}`,
      },
      ...recentMessages.map((e) => e.message),
    ];
  }

  private buildSummary(messages: MessageTokenEstimate[]): string {
    const parts: string[] = [];
    const filesRead: Set<string> = new Set();
    const filesWritten: Set<string> = new Set();
    const commandsRun: string[] = [];
    const searchesPerformed: string[] = [];
    const keyDecisions: string[] = [];

    for (const { message } of messages) {
      if (typeof message.content === "string") {
        // Extract key information from text
        if (message.role === "assistant" && message.content.length > 100) {
          // Keep first sentence of significant assistant messages
          const firstSentence = message.content.split(/[.!?\n]/)[0];
          if (firstSentence && firstSentence.length > 20) {
            keyDecisions.push(firstSentence.trim());
          }
        }
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            switch (block.name) {
              case "read_file":
                filesRead.add(String(input.path ?? ""));
                break;
              case "write_file":
                filesWritten.add(String(input.path ?? ""));
                break;
              case "edit_file":
                filesWritten.add(String(input.path ?? ""));
                break;
              case "run_command":
                commandsRun.push(String(input.command ?? "").slice(0, 80));
                break;
              case "search_codebase":
                searchesPerformed.push(String(input.pattern ?? ""));
                break;
            }
          }
        }
      }
    }

    if (filesRead.size > 0) {
      parts.push(`Files read: ${Array.from(filesRead).join(", ")}`);
    }
    if (filesWritten.size > 0) {
      parts.push(`Files modified: ${Array.from(filesWritten).join(", ")}`);
    }
    if (commandsRun.length > 0) {
      parts.push(`Commands run: ${commandsRun.slice(-5).join("; ")}`);
    }
    if (searchesPerformed.length > 0) {
      parts.push(`Searches: ${searchesPerformed.join(", ")}`);
    }
    if (keyDecisions.length > 0) {
      parts.push(`Key decisions:\n${keyDecisions.slice(-5).map((d) => `- ${d}`).join("\n")}`);
    }

    return parts.join("\n\n") || "Previous messages summarized (no significant actions recorded).";
  }

  private async aiSummarize(
    messages: MessageTokenEstimate[]
  ): Promise<string | null> {
    if (!this.options.summarizationProvider) return null;

    // Build a condensed version of the messages for the summarizer
    const condensed = messages.map(({ message }) => {
      if (typeof message.content === "string") {
        return `[${message.role}]: ${message.content.slice(0, 200)}`;
      }
      if (Array.isArray(message.content)) {
        const blocks = message.content
          .map((b) => {
            if (b.type === "text") return b.text.slice(0, 100);
            if (b.type === "tool_use") return `[tool: ${b.name}]`;
            if (b.type === "tool_result") return `[result: ${b.content.slice(0, 50)}]`;
            return "";
          })
          .filter(Boolean);
        return `[${message.role}]: ${blocks.join(" | ")}`;
      }
      return "";
    });

    const response = await this.options.summarizationProvider.chat({
      messages: [
        {
          role: "user",
          content: `Summarize this agent conversation concisely. Focus on: what files were read/modified, what commands were run, what decisions were made, and what progress was achieved.\n\n${condensed.join("\n")}`,
        },
      ],
      maxTokens: 500,
      temperature: 0,
      systemPrompt:
        "You are a concise summarizer. Produce a brief summary of the agent's conversation, focusing on actions taken and progress made.",
    });

    const textBlock = response.content.find(
      (b): b is { type: "text"; text: string } => b.type === "text"
    );
    return textBlock?.text ?? null;
  }

  /**
   * Estimate token count for a message.
   * Uses the approximation of ~4 characters per token.
   */
  private estimateTokens(message: ChatMessage): number {
    if (typeof message.content === "string") {
      return Math.ceil(message.content.length / 4);
    }

    if (Array.isArray(message.content)) {
      let total = 0;
      for (const block of message.content) {
        if (block.type === "text") {
          total += Math.ceil(block.text.length / 4);
        } else if (block.type === "tool_use") {
          total += Math.ceil(JSON.stringify(block.input).length / 4) + 20;
        } else if (block.type === "tool_result") {
          total += Math.ceil(block.content.length / 4) + 10;
        }
      }
      return total;
    }

    return 10; // minimal overhead
  }
}
