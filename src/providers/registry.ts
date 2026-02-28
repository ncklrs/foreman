/**
 * Provider registry — manages all configured model providers.
 * Creates provider instances from config, tracks health, and exposes lookup.
 */

import type { ForemanConfig, ModelConfig, ProviderHealth } from "../types/index.js";
import type { ModelProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";

export class ProviderRegistry {
  private providers: Map<string, ModelProvider> = new Map();
  private healthCache: Map<string, ProviderHealth> = new Map();

  /** Build providers from configuration. */
  static fromConfig(config: ForemanConfig): ProviderRegistry {
    const registry = new ProviderRegistry();

    for (const [key, modelConfig] of Object.entries(config.models)) {
      const provider = registry.createProvider(key, modelConfig);
      registry.providers.set(key, provider);
    }

    return registry;
  }

  /** Get a provider by its role key (e.g. "coder", "architect"). */
  get(key: string): ModelProvider | undefined {
    return this.providers.get(key);
  }

  /** Get a provider, throwing if not found. */
  getOrThrow(key: string): ModelProvider {
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(`No provider configured for role: ${key}`);
    }
    return provider;
  }

  /** Return all registered provider keys. */
  keys(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Return all providers with their keys. */
  entries(): Array<[string, ModelProvider]> {
    return Array.from(this.providers.entries());
  }

  /** Run health checks on all providers. */
  async healthCheckAll(): Promise<Map<string, ProviderHealth>> {
    const results = new Map<string, ProviderHealth>();
    const checks = this.entries().map(async ([key, provider]) => {
      const health = await provider.healthCheck();
      results.set(key, health);
      this.healthCache.set(key, health);
    });

    await Promise.allSettled(checks);
    return results;
  }

  /** Get cached health for a provider. */
  getCachedHealth(key: string): ProviderHealth | undefined {
    return this.healthCache.get(key);
  }

  /** Check if a provider is healthy (based on last check). */
  isHealthy(key: string): boolean {
    const health = this.healthCache.get(key);
    return health?.healthy ?? true; // Assume healthy if never checked
  }

  /** Register a new provider at runtime. */
  register(key: string, provider: ModelProvider): void {
    this.providers.set(key, provider);
  }

  /** Remove a provider. */
  remove(key: string): boolean {
    this.healthCache.delete(key);
    return this.providers.delete(key);
  }

  private createProvider(_key: string, config: ModelConfig): ModelProvider {
    switch (config.provider) {
      case "anthropic":
        return new AnthropicProvider({
          apiKey: config.apiKey ?? resolveEnvVar("ANTHROPIC_API_KEY"),
          model: config.model,
        });

      case "local":
        return new OllamaProvider({
          endpoint: config.endpoint ?? "http://localhost:11434",
          model: config.model,
        });

      case "openai":
        return new OpenAIProvider({
          apiKey: config.apiKey ?? resolveEnvVar("OPENAI_API_KEY"),
          model: config.model,
          baseUrl: config.endpoint,
        });

      default:
        throw new Error(`Unknown provider type: ${config.provider}`);
    }
  }
}

/** Resolve environment variable references like ${VAR_NAME}. */
function resolveEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}
