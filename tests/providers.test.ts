import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { BaseProvider } from "../src/providers/base.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelCapabilities,
  CostProfile,
  StreamEvent,
  ForemanConfig,
  ModelConfig,
} from "../src/types/index.js";
import type { ModelProvider } from "../src/providers/base.js";

// ---------------------------------------------------------------------------
// Mock provider helpers (following the same pattern as router.test.ts)
// ---------------------------------------------------------------------------

function createMockProvider(
  overrides: Partial<ModelProvider> & { name: string; modelId: string },
): ModelProvider {
  return {
    capabilities: () => ({
      streaming: true,
      toolUse: true,
      vision: false,
      maxContextWindow: 200000,
      maxOutputTokens: 4096,
      reasoningStrength: "medium" as const,
      speed: "medium" as const,
    }),
    costProfile: () => ({
      inputTokenCostPer1M: 3,
      outputTokenCostPer1M: 15,
      currency: "USD",
    }),
    chat: vi.fn().mockResolvedValue({
      id: "resp-1",
      content: [{ type: "text", text: "OK" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
      model: overrides.modelId,
    } satisfies ChatResponse),
    chatStream: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 42,
      lastChecked: new Date(),
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Concrete subclass of BaseProvider for testing healthCheck behaviour
// ---------------------------------------------------------------------------

class TestProvider extends BaseProvider {
  readonly name = "test-provider";
  readonly modelId = "test-model-1";

  chat = vi.fn<(req: ChatRequest) => Promise<ChatResponse>>();

  // Not relevant for healthCheck tests, but required by the abstract class.
  async *chatStream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "message_end" };
  }

  capabilities(): ModelCapabilities {
    return {
      streaming: true,
      toolUse: false,
      vision: false,
      maxContextWindow: 128000,
      maxOutputTokens: 4096,
      reasoningStrength: "medium",
      speed: "fast",
    };
  }

  costProfile(): CostProfile {
    return {
      inputTokenCostPer1M: 1,
      outputTokenCostPer1M: 5,
      currency: "USD",
    };
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  // ── register & get ──────────────────────────────────────────────

  describe("register / get", () => {
    it("registers a provider and retrieves it by key", () => {
      const provider = createMockProvider({ name: "anthropic", modelId: "claude-sonnet-4-5-20250929" });
      registry.register("coder", provider);

      const result = registry.get("coder");
      expect(result).toBe(provider);
    });

    it("returns undefined for an unregistered key", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("overwrites an existing key when re-registering", () => {
      const first = createMockProvider({ name: "a", modelId: "model-a" });
      const second = createMockProvider({ name: "b", modelId: "model-b" });

      registry.register("coder", first);
      registry.register("coder", second);

      expect(registry.get("coder")).toBe(second);
    });
  });

  // ── getOrThrow ──────────────────────────────────────────────────

  describe("getOrThrow", () => {
    it("returns the provider when it exists", () => {
      const provider = createMockProvider({ name: "anthropic", modelId: "claude-sonnet-4-5-20250929" });
      registry.register("coder", provider);

      expect(registry.getOrThrow("coder")).toBe(provider);
    });

    it("throws when the provider does not exist", () => {
      expect(() => registry.getOrThrow("missing")).toThrowError(
        "No provider configured for role: missing",
      );
    });
  });

  // ── keys (list) ─────────────────────────────────────────────────

  describe("keys (list)", () => {
    it("returns an empty array when no providers are registered", () => {
      expect(registry.keys()).toEqual([]);
    });

    it("returns all registered keys", () => {
      registry.register("coder", createMockProvider({ name: "a", modelId: "m-a" }));
      registry.register("architect", createMockProvider({ name: "b", modelId: "m-b" }));
      registry.register("fast", createMockProvider({ name: "c", modelId: "m-c" }));

      const keys = registry.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain("coder");
      expect(keys).toContain("architect");
      expect(keys).toContain("fast");
    });
  });

  // ── has (via get) ───────────────────────────────────────────────

  describe("has (existence check via get)", () => {
    it("confirms a registered provider exists", () => {
      registry.register("coder", createMockProvider({ name: "a", modelId: "m-a" }));
      expect(registry.get("coder")).toBeDefined();
    });

    it("confirms an unregistered key does not exist", () => {
      expect(registry.get("nope")).toBeUndefined();
    });
  });

  // ── entries ─────────────────────────────────────────────────────

  describe("entries", () => {
    it("returns key-provider pairs", () => {
      const p1 = createMockProvider({ name: "a", modelId: "m-a" });
      const p2 = createMockProvider({ name: "b", modelId: "m-b" });

      registry.register("coder", p1);
      registry.register("architect", p2);

      const entries = registry.entries();
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual(["coder", p1]);
      expect(entries).toContainEqual(["architect", p2]);
    });
  });

  // ── remove ──────────────────────────────────────────────────────

  describe("remove", () => {
    it("removes a registered provider and returns true", () => {
      registry.register("coder", createMockProvider({ name: "a", modelId: "m-a" }));
      expect(registry.remove("coder")).toBe(true);
      expect(registry.get("coder")).toBeUndefined();
    });

    it("returns false when removing a non-existent key", () => {
      expect(registry.remove("ghost")).toBe(false);
    });
  });

  // ── fromConfig ──────────────────────────────────────────────────

  describe("fromConfig", () => {
    it("creates providers from a full config object", () => {
      // Set required env vars so createProvider doesn't throw
      process.env.ANTHROPIC_API_KEY = "sk-test-anthropic";
      process.env.OPENAI_API_KEY = "sk-test-openai";

      const config: ForemanConfig = {
        foreman: {
          name: "test-foreman",
          logLevel: "info",
          maxConcurrentAgents: 2,
        },
        models: {
          coder: {
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
            role: "coding",
            maxTokens: 4096,
          },
          fast: {
            provider: "openai",
            model: "gpt-4o-mini",
            role: "fast tasks",
            maxTokens: 1024,
          },
          local: {
            provider: "local",
            model: "llama3",
            role: "local dev",
            maxTokens: 2048,
            endpoint: "http://localhost:11434",
          },
        },
        routing: {
          strategy: "capability_match",
          fallbackChain: ["coder", "fast"],
        },
        sandbox: {
          type: "docker",
          warmPool: 1,
          timeoutMinutes: 10,
          cleanup: "on_success",
        },
        policy: {
          protectedPaths: [],
          blockedCommands: [],
          maxDiffLines: 500,
          requireApprovalAbove: 100,
        },
      };

      const reg = ProviderRegistry.fromConfig(config);

      // Should have created all three providers
      expect(reg.keys()).toHaveLength(3);
      expect(reg.keys()).toContain("coder");
      expect(reg.keys()).toContain("fast");
      expect(reg.keys()).toContain("local");

      // Each provider should be a real object with the expected modelId
      expect(reg.get("coder")!.modelId).toBe("claude-sonnet-4-5-20250929");
      expect(reg.get("fast")!.modelId).toBe("gpt-4o-mini");
      expect(reg.get("local")!.modelId).toBe("llama3");

      // Cleanup
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    });

    it("throws for an unknown provider type in config", () => {
      const config = {
        foreman: { name: "test", logLevel: "info" as const, maxConcurrentAgents: 1 },
        models: {
          bad: {
            provider: "magic" as any,
            model: "gpt-999",
            role: "broken",
            maxTokens: 100,
          },
        },
        routing: { strategy: "capability_match" as const, fallbackChain: [] },
        sandbox: { type: "local" as const, warmPool: 0, timeoutMinutes: 5, cleanup: "always" as const },
        policy: { protectedPaths: [], blockedCommands: [], maxDiffLines: 100, requireApprovalAbove: 50 },
      } satisfies ForemanConfig;

      expect(() => ProviderRegistry.fromConfig(config)).toThrowError("Unknown provider type: magic");
    });
  });

  // ── healthCheckAll ──────────────────────────────────────────────

  describe("healthCheckAll", () => {
    it("runs health checks on every registered provider", async () => {
      const p1 = createMockProvider({ name: "a", modelId: "m-a" });
      const p2 = createMockProvider({ name: "b", modelId: "m-b" });

      registry.register("coder", p1);
      registry.register("fast", p2);

      const results = await registry.healthCheckAll();

      expect(results.size).toBe(2);
      expect(results.get("coder")!.healthy).toBe(true);
      expect(results.get("fast")!.healthy).toBe(true);
      expect(p1.healthCheck).toHaveBeenCalledOnce();
      expect(p2.healthCheck).toHaveBeenCalledOnce();
    });

    it("caches health results for getCachedHealth", async () => {
      const provider = createMockProvider({ name: "a", modelId: "m-a" });
      registry.register("coder", provider);

      // Before any check, cache is empty
      expect(registry.getCachedHealth("coder")).toBeUndefined();

      await registry.healthCheckAll();

      const cached = registry.getCachedHealth("coder");
      expect(cached).toBeDefined();
      expect(cached!.healthy).toBe(true);
    });
  });

  // ── isHealthy ───────────────────────────────────────────────────

  describe("isHealthy", () => {
    it("assumes healthy when never checked", () => {
      registry.register("coder", createMockProvider({ name: "a", modelId: "m-a" }));
      expect(registry.isHealthy("coder")).toBe(true);
    });

    it("reflects cached health after a check", async () => {
      const unhealthy = createMockProvider({ name: "a", modelId: "m-a" });
      (unhealthy.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
        healthy: false,
        latencyMs: 999,
        lastChecked: new Date(),
        error: "connection refused",
      });

      registry.register("broken", unhealthy);
      await registry.healthCheckAll();

      expect(registry.isHealthy("broken")).toBe(false);
    });
  });
});

// ===========================================================================
// BaseProvider.healthCheck
// ===========================================================================

describe("BaseProvider.healthCheck", () => {
  let provider: TestProvider;

  beforeEach(() => {
    provider = new TestProvider();
  });

  it("returns healthy when chat responds with content", async () => {
    provider.chat.mockResolvedValue({
      id: "resp-1",
      content: [{ type: "text", text: "OK" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
      model: "test-model-1",
    });

    const health = await provider.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.lastChecked).toBeInstanceOf(Date);
    expect(health.error).toBeUndefined();
  });

  it("sends the expected probe request to chat", async () => {
    provider.chat.mockResolvedValue({
      id: "resp-1",
      content: [{ type: "text", text: "OK" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
      model: "test-model-1",
    });

    await provider.healthCheck();

    expect(provider.chat).toHaveBeenCalledOnce();
    const request = provider.chat.mock.calls[0][0];
    expect(request.messages).toEqual([{ role: "user", content: "Say OK" }]);
    expect(request.maxTokens).toBe(10);
    expect(request.temperature).toBe(0);
  });

  it("returns unhealthy when chat returns empty content", async () => {
    provider.chat.mockResolvedValue({
      id: "resp-2",
      content: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 0 },
      model: "test-model-1",
    });

    const health = await provider.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.error).toBeUndefined(); // no thrown error, just empty content
  });

  it("returns unhealthy with error message when chat throws", async () => {
    provider.chat.mockRejectedValue(new Error("API rate limit exceeded"));

    const health = await provider.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.error).toBe("API rate limit exceeded");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.lastChecked).toBeInstanceOf(Date);
  });

  it("handles non-Error thrown values", async () => {
    provider.chat.mockRejectedValue("string error");

    const health = await provider.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.error).toBe("string error");
  });

  it("stores the result via getLastHealth", async () => {
    provider.chat.mockResolvedValue({
      id: "resp-1",
      content: [{ type: "text", text: "OK" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
      model: "test-model-1",
    });

    // Before any check
    expect(provider.getLastHealth()).toBeNull();

    await provider.healthCheck();

    const last = provider.getLastHealth();
    expect(last).not.toBeNull();
    expect(last!.healthy).toBe(true);
  });

  it("updates getLastHealth on subsequent calls", async () => {
    // First call -- healthy
    provider.chat.mockResolvedValueOnce({
      id: "resp-1",
      content: [{ type: "text", text: "OK" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
      model: "test-model-1",
    });

    await provider.healthCheck();
    expect(provider.getLastHealth()!.healthy).toBe(true);

    // Second call -- unhealthy
    provider.chat.mockRejectedValueOnce(new Error("timeout"));

    await provider.healthCheck();
    expect(provider.getLastHealth()!.healthy).toBe(false);
    expect(provider.getLastHealth()!.error).toBe("timeout");
  });
});
