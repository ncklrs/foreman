import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelRouter } from "../src/router/router.js";
import { PerformanceTracker } from "../src/router/performance.js";
import type { ModelConfig, RoutingConfig, AgentTask } from "../src/types/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";

// Create a mock provider registry
function createMockRegistry(models: Record<string, ModelConfig>) {
  const registry = new ProviderRegistry() as any;
  const providers = new Map<string, any>();

  for (const [key, config] of Object.entries(models)) {
    const mockProvider = {
      name: config.provider,
      modelId: config.model,
      capabilities: () => ({
        streaming: true,
        toolUse: true,
        vision: false,
        maxContextWindow: 200000,
        maxOutputTokens: config.maxTokens,
        reasoningStrength:
          key === "architect" ? "very_high" :
          key === "coder" ? "high" :
          key === "reviewer" ? "medium" : "medium",
        speed:
          key === "fast" ? "fast" :
          key === "architect" ? "slow" : "medium",
      }),
      costProfile: () => ({
        inputTokenCostPer1M: key === "fast" ? 0.8 : key === "architect" ? 15 : 3,
        outputTokenCostPer1M: key === "fast" ? 4 : key === "architect" ? 75 : 15,
        currency: "USD",
      }),
    };
    providers.set(key, mockProvider);
  }

  registry.get = (key: string) => providers.get(key);
  registry.keys = () => Array.from(providers.keys());
  registry.isHealthy = () => true;
  registry.entries = () => Array.from(providers.entries());

  return registry;
}

const defaultModels: Record<string, ModelConfig> = {
  architect: {
    provider: "anthropic",
    model: "claude-opus-4-6",
    role: "planning",
    maxTokens: 8192,
  },
  coder: {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    role: "coding",
    maxTokens: 4096,
  },
  fast: {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    role: "fast tasks",
    maxTokens: 1024,
  },
};

const defaultRouting: RoutingConfig = {
  strategy: "capability_match",
  fallbackChain: ["coder", "architect", "fast"],
};

describe("ModelRouter", () => {
  it("routes explicitly assigned models", () => {
    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(defaultRouting, defaultModels, registry);

    const task: AgentTask = {
      id: "1",
      title: "Test task",
      description: "A test task",
      assignedModel: "architect",
    };

    const decision = router.route(task);
    expect(decision.modelKey).toBe("architect");
    expect(decision.reason).toContain("Explicitly assigned");
  });

  it("routes complex tasks to architect", () => {
    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(defaultRouting, defaultModels, registry);

    const task: AgentTask = {
      id: "1",
      title: "Refactor authentication system",
      description: "A".repeat(3000), // Long description
      labels: ["refactor", "architecture"],
      estimate: 8,
    };

    const decision = router.route(task);
    expect(decision.modelKey).toBe("architect");
  });

  it("routes simple tasks to fast model", () => {
    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(defaultRouting, defaultModels, registry);

    const task: AgentTask = {
      id: "1",
      title: "Fix typo",
      description: "Fix a typo",
      labels: ["typo", "simple"],
      estimate: 1,
    };

    const decision = router.route(task);
    expect(decision.modelKey).toBe("fast");
  });

  it("routes medium tasks to coder", () => {
    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(defaultRouting, defaultModels, registry);

    const task: AgentTask = {
      id: "1",
      title: "Add feature",
      description: "Add a new feature to the user profile page with form validation. " +
        "This requires updating the database schema, adding new API endpoints, " +
        "creating React components for the form, and writing comprehensive tests.",
      labels: ["feature"],
      estimate: 3,
    };

    const decision = router.route(task);
    expect(decision.modelKey).toBe("coder");
  });

  it("scores task complexity from metadata", () => {
    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(defaultRouting, defaultModels, registry);

    // Simple task
    const simple = router.scoreComplexity({
      id: "1",
      title: "Fix typo",
      description: "Typo fix",
      labels: ["typo"],
      estimate: 1,
    });
    expect(simple.score).toBeLessThanOrEqual(3);

    // Complex task
    const complex = router.scoreComplexity({
      id: "2",
      title: "Redesign auth",
      description: "A".repeat(3000),
      labels: ["architecture", "refactor"],
      estimate: 8,
    });
    expect(complex.score).toBeGreaterThanOrEqual(8);
  });

  it("uses cost-optimized routing", () => {
    const costRouting: RoutingConfig = {
      strategy: "cost_optimized",
      fallbackChain: ["coder", "architect", "fast"],
    };

    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(costRouting, defaultModels, registry);

    const task: AgentTask = {
      id: "1",
      title: "Simple task",
      description: "A simple task",
      labels: ["simple"],
    };

    const decision = router.route(task);
    // Should pick the cheapest capable model
    expect(decision.reason).toContain("Cost-optimized");
  });

  it("uses speed-first routing", () => {
    const speedRouting: RoutingConfig = {
      strategy: "speed_first",
      fallbackChain: ["coder", "architect", "fast"],
    };

    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(speedRouting, defaultModels, registry);

    const task: AgentTask = {
      id: "1",
      title: "Quick task",
      description: "Needs fast response",
    };

    const decision = router.route(task);
    expect(decision.modelKey).toBe("fast");
    expect(decision.reason).toContain("Speed-first");
  });

  it("provides fallback chain", () => {
    const registry = createMockRegistry(defaultModels);
    const router = new ModelRouter(defaultRouting, defaultModels, registry);

    const task: AgentTask = {
      id: "1",
      title: "Test",
      description: "Test",
      assignedModel: "coder",
    };

    const decision = router.route(task);
    expect(decision.fallbacksAvailable).toContain("architect");
    expect(decision.fallbacksAvailable).toContain("fast");
    expect(decision.fallbacksAvailable).not.toContain("coder"); // current model excluded
  });

  it("routes by historical performance when labels match", () => {
    const registry = createMockRegistry(defaultModels);
    const tracker = new PerformanceTracker();

    // Record 5 successful "bug" tasks on fast model
    for (let i = 0; i < 5; i++) {
      tracker.record({
        modelKey: "fast",
        taskId: `bug_${i}`,
        success: true,
        durationMs: 1000,
        iterations: 2,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        labels: ["bug"],
      });
    }

    const router = new ModelRouter({
      config: defaultRouting,
      models: defaultModels,
      registry,
      performanceTracker: tracker,
    });

    const task: AgentTask = {
      id: "1",
      title: "Fix null pointer bug",
      description: "Null pointer exception in user service when profile is missing",
      labels: ["bug"],
    };

    const decision = router.route(task);
    expect(decision.modelKey).toBe("fast");
    expect(decision.reason).toContain("Performance-optimized");
  });

  it("forces cheapest model when budget cap exceeded", () => {
    const registry = createMockRegistry(defaultModels);

    const router = new ModelRouter({
      config: defaultRouting,
      models: defaultModels,
      registry,
      budgetCapUsd: 10.0,
      currentSpendUsd: 15.0,
    });

    const task: AgentTask = {
      id: "1",
      title: "Complex refactor",
      description: "A".repeat(3000),
      labels: ["architecture"],
      estimate: 8,
    };

    const decision = router.route(task);
    expect(decision.modelKey).toBe("fast"); // cheapest
    expect(decision.reason).toContain("Budget cap reached");
  });

  it("updateSpend triggers budget-aware routing", () => {
    const registry = createMockRegistry(defaultModels);

    const router = new ModelRouter({
      config: defaultRouting,
      models: defaultModels,
      registry,
      budgetCapUsd: 5.0,
    });

    const complexTask: AgentTask = {
      id: "1",
      title: "Complex task",
      description: "A".repeat(3000),
      labels: ["architecture"],
      estimate: 8,
    };

    // Before budget exceeded
    let decision = router.route(complexTask);
    expect(decision.modelKey).toBe("architect");

    // After budget exceeded
    router.updateSpend(6.0);
    decision = router.route(complexTask);
    expect(decision.modelKey).toBe("fast");
    expect(decision.reason).toContain("Budget cap");
  });
});
