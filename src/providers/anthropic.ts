/**
 * Anthropic provider adapter.
 * Supports Claude Opus, Sonnet, and Haiku with full tool-use and streaming.
 */

import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  CostProfile,
  ModelCapabilities,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
  TokenUsage,
} from "../types/index.js";
import { BaseProvider } from "./base.js";
import { withRetry } from "../utils/retry.js";

interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

// Anthropic API types (subset needed for our adapter)
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

const MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {
  "claude-opus-4-6": {
    maxContextWindow: 200000,
    maxOutputTokens: 32000,
    reasoningStrength: "very_high",
    speed: "slow",
  },
  "claude-sonnet-4-5-20250929": {
    maxContextWindow: 200000,
    maxOutputTokens: 16384,
    reasoningStrength: "high",
    speed: "medium",
  },
  "claude-haiku-4-5-20251001": {
    maxContextWindow: 200000,
    maxOutputTokens: 8192,
    reasoningStrength: "medium",
    speed: "fast",
  },
};

const MODEL_COSTS: Record<string, CostProfile> = {
  "claude-opus-4-6": {
    inputTokenCostPer1M: 15.0,
    outputTokenCostPer1M: 75.0,
    currency: "USD",
  },
  "claude-sonnet-4-5-20250929": {
    inputTokenCostPer1M: 3.0,
    outputTokenCostPer1M: 15.0,
    currency: "USD",
  },
  "claude-haiku-4-5-20251001": {
    inputTokenCostPer1M: 0.8,
    outputTokenCostPer1M: 4.0,
    currency: "USD",
  },
};

export class AnthropicProvider extends BaseProvider {
  readonly name = "anthropic";
  readonly modelId: string;

  private apiKey: string;
  private baseUrl: string;

  constructor(options: AnthropicProviderOptions) {
    super();
    this.apiKey = options.apiKey;
    this.modelId = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  }

  capabilities(): ModelCapabilities {
    const modelCaps = this.findModelCapabilities();
    return {
      streaming: true,
      toolUse: true,
      vision: true,
      maxContextWindow: modelCaps.maxContextWindow ?? 200000,
      maxOutputTokens: modelCaps.maxOutputTokens ?? 8192,
      reasoningStrength: modelCaps.reasoningStrength ?? "high",
      speed: modelCaps.speed ?? "medium",
    };
  }

  costProfile(): CostProfile {
    const modelKey = this.findModelKey();
    return MODEL_COSTS[modelKey] ?? {
      inputTokenCostPer1M: 3.0,
      outputTokenCostPer1M: 15.0,
      currency: "USD",
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return withRetry(async () => {
      const body = this.buildRequestBody(request);

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      return this.parseResponse(data);
    });
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const body = { ...this.buildRequestBody(request), stream: true };

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolUse: Partial<ToolUseBlock> | null = null;
    let inputJsonBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }

            const eventType = event.type as string;

            if (eventType === "message_start") {
              yield { type: "message_start" };
            } else if (eventType === "content_block_start") {
              const contentBlock = event.content_block as Record<string, unknown>;
              if (contentBlock?.type === "tool_use") {
                currentToolUse = {
                  type: "tool_use",
                  id: contentBlock.id as string,
                  name: contentBlock.name as string,
                  input: {},
                };
                inputJsonBuffer = "";
                yield { type: "tool_use_start", toolUse: { ...currentToolUse } };
              }
            } else if (eventType === "content_block_delta") {
              const delta = event.delta as Record<string, unknown>;
              if (delta?.type === "text_delta") {
                yield { type: "text_delta", text: delta.text as string };
              } else if (delta?.type === "input_json_delta") {
                inputJsonBuffer += delta.partial_json as string;
                yield { type: "tool_use_delta", text: delta.partial_json as string };
              }
            } else if (eventType === "content_block_stop") {
              if (currentToolUse) {
                try {
                  currentToolUse.input = JSON.parse(inputJsonBuffer || "{}") as Record<string, unknown>;
                } catch {
                  currentToolUse.input = {};
                }
                yield { type: "tool_use_end", toolUse: { ...currentToolUse } };
                currentToolUse = null;
                inputJsonBuffer = "";
              }
            } else if (eventType === "message_delta") {
              const usage = event.usage as { output_tokens?: number } | undefined;
              if (usage) {
                yield {
                  type: "message_end",
                  usage: { inputTokens: 0, outputTokens: usage.output_tokens ?? 0 },
                };
              }
            } else if (eventType === "message_stop") {
              yield { type: "message_end" };
            } else if (eventType === "error") {
              yield { type: "error", error: JSON.stringify(event.error) };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const messages = this.convertMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(
        (t): AnthropicTool => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })
      );
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop_sequences = request.stopSequences;
    }

    return body;
  }

  private convertMessages(messages: ChatRequest["messages"]): AnthropicMessage[] {
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue; // Handled via system param

      if (msg.role === "tool") {
        // Tool results need to be part of a user message
        const toolResult: AnthropicContentBlock = {
          type: "tool_result",
          tool_use_id: msg.toolCallId ?? "",
          content: typeof msg.content === "string" ? msg.content : "",
        };
        // Merge into previous user message or create new one
        const last = anthropicMessages[anthropicMessages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as AnthropicContentBlock[]).push(toolResult);
        } else {
          anthropicMessages.push({ role: "user", content: [toolResult] });
        }
        continue;
      }

      if (typeof msg.content === "string") {
        anthropicMessages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        const blocks: AnthropicContentBlock[] = msg.content.map((block) => {
          if (block.type === "text") {
            return { type: "text" as const, text: block.text };
          }
          if (block.type === "tool_use") {
            return {
              type: "tool_use" as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }
          if (block.type === "tool_result") {
            return {
              type: "tool_result" as const,
              tool_use_id: block.toolUseId,
              content: block.content,
              is_error: block.isError,
            };
          }
          return { type: "text" as const, text: "" };
        });
        anthropicMessages.push({
          role: msg.role as "user" | "assistant",
          content: blocks,
        });
      }
    }

    return anthropicMessages;
  }

  private parseResponse(data: AnthropicResponse): ChatResponse {
    const content: ContentBlock[] = data.content.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text } as TextBlock;
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        } as ToolUseBlock;
      }
      return { type: "text", text: "" } as TextBlock;
    });

    const stopReason = this.mapStopReason(data.stop_reason);

    return {
      id: data.id,
      content,
      stopReason,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
      model: data.model,
    };
  }

  private mapStopReason(reason: string): ChatResponse["stopReason"] {
    switch (reason) {
      case "end_turn":
        return "end_turn";
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }

  private findModelKey(): string {
    // Find the best matching key in our cost/capability maps
    for (const key of Object.keys(MODEL_COSTS)) {
      if (this.modelId.startsWith(key) || key.startsWith(this.modelId)) {
        return key;
      }
    }
    return this.modelId;
  }

  private findModelCapabilities(): Partial<ModelCapabilities> {
    for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
      if (this.modelId.startsWith(key) || key.startsWith(this.modelId)) {
        return caps;
      }
    }
    return {};
  }
}
