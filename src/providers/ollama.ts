/**
 * Ollama provider adapter.
 * Connects to local Ollama instances via their OpenAI-compatible API.
 */

import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  CostProfile,
  ModelCapabilities,
  ProviderHealth,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
  TokenUsage,
} from "../types/index.js";
import { BaseProvider } from "./base.js";

interface OllamaProviderOptions {
  endpoint: string;
  model: string;
}

// OpenAI-compatible API types (subset used by Ollama)
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OAIResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

interface OAIStreamChunk {
  id: string;
  choices: Array<{
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export class OllamaProvider extends BaseProvider {
  readonly name = "ollama";
  readonly modelId: string;

  private endpoint: string;

  constructor(options: OllamaProviderOptions) {
    super();
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.modelId = options.model;
  }

  capabilities(): ModelCapabilities {
    return {
      streaming: true,
      toolUse: true,
      vision: false,
      maxContextWindow: 32768,
      maxOutputTokens: 4096,
      reasoningStrength: "medium",
      speed: "medium",
    };
  }

  costProfile(): CostProfile {
    // Local models have zero API cost
    return {
      inputTokenCostPer1M: 0,
      outputTokenCostPer1M: 0,
      currency: "USD",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      // Ollama exposes a simple API endpoint we can check
      const response = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return {
        healthy: true,
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request);

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OAIResponse;
    return this.parseResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const body = { ...this.buildRequestBody(request), stream: true };

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const activeToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    yield { type: "message_start" };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            yield { type: "message_end" };
            continue;
          }

          let chunk: OAIStreamChunk;
          try {
            chunk = JSON.parse(data) as OAIStreamChunk;
          } catch {
            continue;
          }

          const choice = chunk.choices[0];
          if (!choice) continue;

          // Text content
          if (choice.delta.content) {
            yield { type: "text_delta", text: choice.delta.content };
          }

          // Tool calls
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (tc.id && tc.function?.name) {
                // New tool call starting
                activeToolCalls.set(tc.index, {
                  id: tc.id,
                  name: tc.function.name,
                  args: tc.function.arguments ?? "",
                });
                yield {
                  type: "tool_use_start",
                  toolUse: {
                    type: "tool_use",
                    id: tc.id,
                    name: tc.function.name,
                  },
                };
              } else if (tc.function?.arguments) {
                // Continuing tool call arguments
                const existing = activeToolCalls.get(tc.index);
                if (existing) {
                  existing.args += tc.function.arguments;
                  yield {
                    type: "tool_use_delta",
                    text: tc.function.arguments,
                  };
                }
              }
            }
          }

          // Finish reason
          if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
            // Emit tool_use_end for all active tool calls
            for (const [, tc] of activeToolCalls) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(tc.args || "{}") as Record<string, unknown>;
              } catch {
                // Leave empty
              }
              yield {
                type: "tool_use_end",
                toolUse: {
                  type: "tool_use",
                  id: tc.id,
                  name: tc.name,
                  input,
                },
              };
            }
            activeToolCalls.clear();
          }

          if (chunk.usage) {
            yield {
              type: "message_end",
              usage: {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              },
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const messages = this.convertMessages(request);

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
    };

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(
        (t): OAITool => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })
      );
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop = request.stopSequences;
    }

    return body;
  }

  private convertMessages(request: ChatRequest): OAIMessage[] {
    const messages: OAIMessage[] = [];

    // Add system prompt
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === "system") {
        messages.push({ role: "system", content: typeof msg.content === "string" ? msg.content : "" });
        continue;
      }

      if (msg.role === "tool") {
        messages.push({
          role: "tool",
          content: typeof msg.content === "string" ? msg.content : "",
          tool_call_id: msg.toolCallId,
        });
        continue;
      }

      if (typeof msg.content === "string") {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        // Build content and tool calls from blocks
        const textParts: string[] = [];
        const toolCalls: OAIToolCall[] = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const oaiMsg: OAIMessage = {
          role: msg.role as "user" | "assistant",
          content: textParts.join("\n") || null,
        };

        if (toolCalls.length > 0) {
          oaiMsg.tool_calls = toolCalls;
        }

        messages.push(oaiMsg);
      }
    }

    return messages;
  }

  private parseResponse(data: OAIResponse): ChatResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error("No choices in response");
    }

    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content } as TextBlock);
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // Leave empty
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        } as ToolUseBlock);
      }
    }

    const stopReason = this.mapStopReason(choice.finish_reason);

    const usage: TokenUsage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };

    return {
      id: data.id,
      content,
      stopReason,
      usage,
      model: data.model,
    };
  }

  private mapStopReason(reason: string): ChatResponse["stopReason"] {
    switch (reason) {
      case "stop":
        return "end_turn";
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      default:
        return "end_turn";
    }
  }
}
