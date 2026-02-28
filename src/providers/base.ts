/**
 * Base ModelProvider interface and abstract class.
 * All provider adapters implement this interface.
 */

import type {
  ChatRequest,
  ChatResponse,
  CostProfile,
  ModelCapabilities,
  ProviderHealth,
  StreamEvent,
} from "../types/index.js";

export interface ModelProvider {
  readonly name: string;
  readonly modelId: string;

  /** Send a chat request and get a complete response. */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** Send a chat request and stream the response. */
  chatStream(request: ChatRequest): AsyncIterable<StreamEvent>;

  /** Return this model's capabilities. */
  capabilities(): ModelCapabilities;

  /** Return this model's cost profile. */
  costProfile(): CostProfile;

  /** Check if the provider is healthy and reachable. */
  healthCheck(): Promise<ProviderHealth>;
}

export abstract class BaseProvider implements ModelProvider {
  abstract readonly name: string;
  abstract readonly modelId: string;

  abstract chat(request: ChatRequest): Promise<ChatResponse>;
  abstract chatStream(request: ChatRequest): AsyncIterable<StreamEvent>;
  abstract capabilities(): ModelCapabilities;
  abstract costProfile(): CostProfile;

  private lastHealth: ProviderHealth | null = null;

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const response = await this.chat({
        messages: [{ role: "user", content: "Say OK" }],
        maxTokens: 10,
        temperature: 0,
      });

      const health: ProviderHealth = {
        healthy: response.content.length > 0,
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
      };
      this.lastHealth = health;
      return health;
    } catch (error) {
      const health: ProviderHealth = {
        healthy: false,
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.lastHealth = health;
      return health;
    }
  }

  getLastHealth(): ProviderHealth | null {
    return this.lastHealth;
  }
}
