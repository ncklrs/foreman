/**
 * Model Router.
 * Selects the best available model for a task based on:
 * - Capability matching (reasoning strength, tool support, context window)
 * - Role-based assignment (map roles to models)
 * - Fallback chains (ordered list if primary is unavailable)
 * - Task complexity scoring
 * - Historical performance data (via PerformanceTracker)
 * - Budget-aware cost caps
 *
 * Implements:
 * - "Budget-Aware Model Routing with Hard Cost Caps" pattern
 * - "Oracle and Worker Multi-Model Approach" pattern
 * - "Failover-Aware Model Fallback" pattern
 */

import type {
  AgentTask,
  ModelConfig,
  RoutingConfig,
  RoutingDecision,
  TaskComplexity,
} from "../types/index.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { PerformanceTracker } from "./performance.js";

export interface RouterOptions {
  config: RoutingConfig;
  models: Record<string, ModelConfig>;
  registry: ProviderRegistry;
  performanceTracker?: PerformanceTracker;
  /** Maximum total cost in USD before switching to cheapest model. */
  budgetCapUsd?: number;
  /** Running total cost so far. Updated externally. */
  currentSpendUsd?: number;
}

export class ModelRouter {
  private config: RoutingConfig;
  private models: Record<string, ModelConfig>;
  private registry: ProviderRegistry;
  private performanceTracker: PerformanceTracker | null;
  private budgetCapUsd: number;
  private currentSpendUsd: number;

  constructor(
    configOrOptions: RoutingConfig | RouterOptions,
    models?: Record<string, ModelConfig>,
    registry?: ProviderRegistry
  ) {
    if (models && registry) {
      // Legacy 3-arg constructor
      this.config = configOrOptions as RoutingConfig;
      this.models = models;
      this.registry = registry;
      this.performanceTracker = null;
      this.budgetCapUsd = Infinity;
      this.currentSpendUsd = 0;
    } else {
      const opts = configOrOptions as RouterOptions;
      this.config = opts.config;
      this.models = opts.models;
      this.registry = opts.registry;
      this.performanceTracker = opts.performanceTracker ?? null;
      this.budgetCapUsd = opts.budgetCapUsd ?? Infinity;
      this.currentSpendUsd = opts.currentSpendUsd ?? 0;
    }
  }

  /** Update running spend for budget-aware routing. */
  updateSpend(usd: number): void {
    this.currentSpendUsd = usd;
  }

  /** Select the best model for a given task. */
  route(task: AgentTask): RoutingDecision {
    // Budget cap: if we've exceeded budget, force cheapest available model
    if (this.currentSpendUsd >= this.budgetCapUsd) {
      return this.routeByCost(task, true);
    }

    // If task has an explicit model assignment, use it
    if (task.assignedModel && this.models[task.assignedModel]) {
      const provider = this.registry.get(task.assignedModel);
      if (provider && this.registry.isHealthy(task.assignedModel)) {
        return {
          modelKey: task.assignedModel,
          modelConfig: this.models[task.assignedModel],
          reason: `Explicitly assigned model: ${task.assignedModel}`,
          fallbacksAvailable: this.getAvailableFallbacks(task.assignedModel),
        };
      }
    }

    // Performance-aware: if we have historical data for a matching label,
    // prefer the historically best model for that label
    if (this.performanceTracker && task.labels && task.labels.length > 0) {
      for (const label of task.labels) {
        const bestKey = this.performanceTracker.getBestModelForLabel(label);
        if (bestKey && this.models[bestKey] && this.registry.isHealthy(bestKey)) {
          return {
            modelKey: bestKey,
            modelConfig: this.models[bestKey],
            reason: `Performance-optimized: best historical model for label "${label}"`,
            fallbacksAvailable: this.getAvailableFallbacks(bestKey),
          };
        }
      }
    }

    switch (this.config.strategy) {
      case "capability_match":
        return this.routeByCapability(task);
      case "cost_optimized":
        return this.routeByCost(task);
      case "speed_first":
        return this.routeBySpeed(task);
      default:
        return this.routeByCapability(task);
    }
  }

  /** Score task complexity from task metadata. */
  scoreComplexity(task: AgentTask): TaskComplexity {
    let score = 5; // baseline
    const requiredCapabilities: string[] = ["tool_use"];
    const reasons: string[] = [];

    // Description length indicates complexity
    const descLength = task.description.length;
    if (descLength > 2000) {
      score += 2;
      reasons.push("Long description suggests complex task");
    } else if (descLength > 500) {
      score += 1;
      reasons.push("Moderate description length");
    } else if (descLength < 100) {
      score -= 2;
      reasons.push("Short description suggests simple task");
    }

    // Labels provide signal
    const labels = task.labels ?? [];
    if (labels.some((l) => /bug|fix|hotfix/i.test(l))) {
      score += 1;
      reasons.push("Bug fix — may need careful analysis");
    }
    if (labels.some((l) => /refactor|architecture|design/i.test(l))) {
      score += 2;
      requiredCapabilities.push("high_reasoning");
      reasons.push("Architectural work — needs strong reasoning");
    }
    if (labels.some((l) => /simple|minor|typo|docs/i.test(l))) {
      score -= 2;
      reasons.push("Labeled as simple/minor");
    }
    if (labels.some((l) => /review|lint/i.test(l))) {
      score -= 1;
      reasons.push("Review/lint task");
    }

    // Estimate field from Linear
    if (task.estimate !== undefined) {
      if (task.estimate >= 5) {
        score += 2;
        reasons.push(`High estimate (${task.estimate})`);
      } else if (task.estimate <= 1) {
        score -= 2;
        reasons.push(`Low estimate (${task.estimate})`);
      }
    }

    // Clamp to 1-10
    score = Math.max(1, Math.min(10, score));

    return {
      score,
      reasoning: reasons.join("; ") || "Default complexity",
      requiredCapabilities,
    };
  }

  private routeByCapability(task: AgentTask): RoutingDecision {
    const complexity = this.scoreComplexity(task);

    // High complexity -> architect model
    if (complexity.score >= 8) {
      const decision = this.tryModel("architect", task, complexity);
      if (decision) return decision;
    }

    // Medium-high complexity -> coder model
    if (complexity.score >= 4) {
      const decision = this.tryModel("coder", task, complexity);
      if (decision) return decision;
    }

    // Low complexity -> fast model
    if (complexity.score < 4) {
      const decision = this.tryModel("fast", task, complexity);
      if (decision) return decision;
    }

    // Fall through to fallback chain
    return this.routeByFallback(task, complexity);
  }

  private routeByCost(task: AgentTask, forceCheapest = false): RoutingDecision {
    const complexity = this.scoreComplexity(task);

    // Sort models by cost (cheapest first) and pick the first capable one
    const sorted = Object.entries(this.models)
      .map(([key, config]) => {
        const provider = this.registry.get(key);
        const cost = provider?.costProfile();
        return { key, config, provider, cost };
      })
      .filter((m) => m.provider && this.registry.isHealthy(m.key))
      .sort((a, b) => {
        const aCost = (a.cost?.inputTokenCostPer1M ?? 999) + (a.cost?.outputTokenCostPer1M ?? 999);
        const bCost = (b.cost?.inputTokenCostPer1M ?? 999) + (b.cost?.outputTokenCostPer1M ?? 999);
        return aCost - bCost;
      });

    // If forcing cheapest (budget exceeded), skip capability check
    if (forceCheapest && sorted.length > 0) {
      return {
        modelKey: sorted[0].key,
        modelConfig: sorted[0].config,
        reason: `Budget cap reached ($${this.currentSpendUsd.toFixed(2)}/$${this.budgetCapUsd.toFixed(2)}), using cheapest model`,
        fallbacksAvailable: this.getAvailableFallbacks(sorted[0].key),
      };
    }

    // For complex tasks, filter out models that are too weak
    const minReasoningStrength = complexity.score >= 7 ? "high" : "medium";
    const reasoningOrder = ["low", "medium", "high", "very_high"];

    for (const model of sorted) {
      const caps = model.provider!.capabilities();
      const strengthIdx = reasoningOrder.indexOf(caps.reasoningStrength);
      const minIdx = reasoningOrder.indexOf(minReasoningStrength);

      if (strengthIdx >= minIdx) {
        return {
          modelKey: model.key,
          modelConfig: model.config,
          reason: `Cost-optimized routing: cheapest capable model (complexity: ${complexity.score})`,
          fallbacksAvailable: this.getAvailableFallbacks(model.key),
        };
      }
    }

    // If no model meets requirements, use the most capable one available
    return this.routeByFallback(task, complexity);
  }

  private routeBySpeed(task: AgentTask): RoutingDecision {
    const complexity = this.scoreComplexity(task);
    const speedOrder = ["fast", "medium", "slow"];

    const sorted = Object.entries(this.models)
      .map(([key]) => {
        const provider = this.registry.get(key);
        return { key, provider };
      })
      .filter((m) => m.provider && this.registry.isHealthy(m.key))
      .sort((a, b) => {
        const aSpeed = speedOrder.indexOf(a.provider!.capabilities().speed);
        const bSpeed = speedOrder.indexOf(b.provider!.capabilities().speed);
        return aSpeed - bSpeed;
      });

    if (sorted.length > 0) {
      const fastest = sorted[0];
      return {
        modelKey: fastest.key,
        modelConfig: this.models[fastest.key],
        reason: `Speed-first routing: fastest available model`,
        fallbacksAvailable: this.getAvailableFallbacks(fastest.key),
      };
    }

    return this.routeByFallback(task, complexity);
  }

  private tryModel(
    key: string,
    _task: AgentTask,
    complexity: TaskComplexity
  ): RoutingDecision | null {
    if (!this.models[key]) return null;

    const provider = this.registry.get(key);
    if (!provider || !this.registry.isHealthy(key)) return null;

    return {
      modelKey: key,
      modelConfig: this.models[key],
      reason: `Capability-matched to "${key}" role (complexity: ${complexity.score} — ${complexity.reasoning})`,
      fallbacksAvailable: this.getAvailableFallbacks(key),
    };
  }

  private routeByFallback(
    _task: AgentTask,
    complexity: TaskComplexity
  ): RoutingDecision {
    for (const key of this.config.fallbackChain) {
      if (this.models[key] && this.registry.isHealthy(key)) {
        return {
          modelKey: key,
          modelConfig: this.models[key],
          reason: `Fallback chain: ${key} (complexity: ${complexity.score})`,
          fallbacksAvailable: this.getAvailableFallbacks(key),
        };
      }
    }

    // Last resort: use whatever is available
    const anyKey = this.registry.keys().find((k) => this.registry.isHealthy(k));
    if (anyKey) {
      return {
        modelKey: anyKey,
        modelConfig: this.models[anyKey],
        reason: "Last resort: only available model",
        fallbacksAvailable: [],
      };
    }

    throw new Error("No healthy model providers available");
  }

  private getAvailableFallbacks(excludeKey: string): string[] {
    return this.config.fallbackChain.filter(
      (k) => k !== excludeKey && this.models[k] && this.registry.isHealthy(k)
    );
  }
}
