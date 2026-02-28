/**
 * OpenAI-compatible provider adapter.
 * Supports GPT-4o, o1, and any OpenAI-compatible API endpoint.
 * Shares the OpenAI-compatible protocol with the Ollama adapter but
 * adds authentication and OpenAI-specific model metadata.
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

interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OAIResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: OAIToolCall[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
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
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {
  "gpt-4o": {
    maxContextWindow: 128000,
    maxOutputTokens: 16384,
    reasoningStrength: "high",
    speed: "medium",
  },
  "gpt-4o-mini": {
    maxContextWindow: 128000,
    maxOutputTokens: 16384,
    reasoningStrength: "medium",
    speed: "fast",
  },
  "o1": {
    maxContextWindow: 200000,
    maxOutputTokens: 100000,
    reasoningStrength: "very_high",
    speed: "slow",
  },
  "o1-mini": {
    maxContextWindow: 128000,
    maxOutputTokens: 65536,
    reasoningStrength: "high",
    speed: "medium",
  },
};

const MODEL_COSTS: Record<string, CostProfile> = {
  "gpt-4o": { inputTokenCostPer1M: 2.5, outputTokenCostPer1M: 10.0, currency: "USD" },
  "gpt-4o-mini": { inputTokenCostPer1M: 0.15, outputTokenCostPer1M: 0.6, currency: "USD" },
  "o1": { inputTokenCostPer1M: 15.0, outputTokenCostPer1M: 60.0, currency: "USD" },
  "o1-mini": { inputTokenCostPer1M: 3.0, outputTokenCostPer1M: 12.0, currency: "USD" },
};

export class OpenAIProvider extends BaseProvider {
  readonly name = "openai";
  readonly modelId: string;

  private apiKey: string;
  private baseUrl: string;

  constructor(options: OpenAIProviderOptions) {
    super();
    this.apiKey = options.apiKey;
    this.modelId = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com";
  }

  capabilities(): ModelCapabilities {
    const caps = this.findModelCapabilities();
    return {
      streaming: true,
      toolUse: true,
      vision: true,
      maxContextWindow: caps.maxContextWindow ?? 128000,
      maxOutputTokens: caps.maxOutputTokens ?? 4096,
      reasoningStrength: caps.reasoningStrength ?? "high",
      speed: caps.speed ?? "medium",
    };
  }

  costProfile(): CostProfile {
    const key = this.findModelKey();
    return MODEL_COSTS[key] ?? { inputTokenCostPer1M: 2.5, outputTokenCostPer1M: 10.0, currency: "USD" };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OAIResponse;
    return this.parseResponse(data);
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const body = { ...this.buildRequestBody(request), stream: true, stream_options: { include_usage: true } };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    if (!response.body) throw new Error("Response body is null");

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
          try { chunk = JSON.parse(data) as OAIStreamChunk; } catch { continue; }

          const choice = chunk.choices?.[0];
          if (!choice) {
            if (chunk.usage) {
              yield { type: "message_end", usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens } };
            }
            continue;
          }

          if (choice.delta.content) {
            yield { type: "text_delta", text: choice.delta.content };
          }

          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (tc.id && tc.function?.name) {
                activeToolCalls.set(tc.index, { id: tc.id, name: tc.function.name, args: tc.function.arguments ?? "" });
                yield { type: "tool_use_start", toolUse: { type: "tool_use", id: tc.id, name: tc.function.name } };
              } else if (tc.function?.arguments) {
                const existing = activeToolCalls.get(tc.index);
                if (existing) {
                  existing.args += tc.function.arguments;
                  yield { type: "tool_use_delta", text: tc.function.arguments };
                }
              }
            }
          }

          if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
            for (const [, tc] of activeToolCalls) {
              let input: Record<string, unknown> = {};
              try { input = JSON.parse(tc.args || "{}") as Record<string, unknown>; } catch { /* noop */ }
              yield { type: "tool_use_end", toolUse: { type: "tool_use", id: tc.id, name: tc.name, input } };
            }
            activeToolCalls.clear();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const messages = this.convertMessages(request);
    const body: Record<string, unknown> = { model: this.modelId, messages };

    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t): OAITool => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    if (request.stopSequences && request.stopSequences.length > 0) body.stop = request.stopSequences;

    return body;
  }

  private convertMessages(request: ChatRequest): OAIMessage[] {
    const messages: OAIMessage[] = [];

    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === "system") {
        messages.push({ role: "system", content: typeof msg.content === "string" ? msg.content : "" });
        continue;
      }
      if (msg.role === "tool") {
        messages.push({ role: "tool", content: typeof msg.content === "string" ? msg.content : "", tool_call_id: msg.toolCallId });
        continue;
      }
      if (typeof msg.content === "string") {
        messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: OAIToolCall[] = [];
        for (const block of msg.content) {
          if (block.type === "text") textParts.push(block.text);
          else if (block.type === "tool_use") {
            toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } });
          }
        }
        const oaiMsg: OAIMessage = { role: msg.role as "user" | "assistant", content: textParts.join("\n") || null };
        if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls;
        messages.push(oaiMsg);
      }
    }

    return messages;
  }

  private parseResponse(data: OAIResponse): ChatResponse {
    const choice = data.choices[0];
    if (!choice) throw new Error("No choices in response");

    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content } as TextBlock);
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* noop */ }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input } as ToolUseBlock);
      }
    }

    return {
      id: data.id,
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      model: data.model,
    };
  }

  private mapStopReason(reason: string): ChatResponse["stopReason"] {
    switch (reason) {
      case "stop": return "end_turn";
      case "tool_calls": return "tool_use";
      case "length": return "max_tokens";
      default: return "end_turn";
    }
  }

  private findModelKey(): string {
    for (const key of Object.keys(MODEL_COSTS)) {
      if (this.modelId.startsWith(key)) return key;
    }
    return this.modelId;
  }

  private findModelCapabilities(): Partial<ModelCapabilities> {
    for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
      if (this.modelId.startsWith(key)) return caps;
    }
    return {};
  }
}
