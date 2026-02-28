# Model Routing

The **ModelRouter** selects the best available model for each task based on complexity, cost, performance history, and provider health.

## Architecture

```
                    ┌───────────┐
                    │   Task    │
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │  Explicit  │──── task.assignedModel? ──→ Use it
                    │  Override  │
                    └─────┬─────┘
                          │ no
                    ┌─────▼─────┐
                    │  Budget   │──── over cap? ──→ Force cheapest
                    │   Check   │
                    └─────┬─────┘
                          │ ok
                    ┌─────▼─────┐
                    │Performance│──── label match? ──→ Use best historical
                    │  History  │
                    └─────┬─────┘
                          │ no match
                    ┌─────▼─────┐
                    │  Strategy │
                    │  Router   │
                    └─────┬─────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │Capability│ │   Cost   │ │  Speed   │
        │  Match   │ │ Optimized│ │  First   │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │             │
             └──────┬──────┘─────────────┘
                    │
              ┌─────▼─────┐
              │  Fallback  │──── all failed? ──→ Any healthy model
              │   Chain    │
              └─────┬──────┘
                    │
              ┌─────▼─────┐
              │  Routing   │
              │  Decision  │
              └────────────┘
```

## Configuration

```toml
[routing]
strategy = "capability_match"          # or "cost_optimized" or "speed_first"
fallback_chain = ["coder", "architect", "fast"]
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strategy` | string | `"capability_match"` | Primary routing strategy. |
| `fallback_chain` | string[] | `["coder"]` | Ordered list of model keys to try if primary selection fails. |

## Routing Strategies

### `capability_match` (Default)

Routes based on task complexity score:

| Complexity | Model Role | Use Case |
|-----------|------------|----------|
| **8–10** | `architect` | Planning, architecture, complex reasoning |
| **4–7** | `coder` | Implementation, bug fixes, moderate tasks |
| **1–3** | `fast` | Classification, linting, simple transforms |

This is the recommended strategy for most setups. It balances quality and cost by using expensive models only when needed.

### `cost_optimized`

Sorts all available models by cost (cheapest first) and picks the cheapest one whose reasoning strength is sufficient for the task:

- High complexity (7+): Requires `high` or `very_high` reasoning
- Lower complexity: `medium` reasoning is acceptable

If no model meets requirements, falls back to the most capable model.

### `speed_first`

Selects the fastest available model regardless of task complexity. Useful for:
- CI/CD pipelines where latency matters
- High-volume batch processing
- Tasks where quality differences are negligible

## Complexity Scoring

The router scores each task on a 1–10 scale using multiple signals:

```
┌─────────────────────────────────────────────────┐
│              Complexity Scorer                   │
│                                                 │
│  Base score: 5                                  │
│                                                 │
│  Description length:                            │
│    > 2000 chars  →  +2                          │
│    > 500 chars   →  +1                          │
│    < 100 chars   →  -2                          │
│                                                 │
│  Labels:                                        │
│    bug/fix/hotfix        →  +1                  │
│    refactor/architecture →  +2  (+ high_reason) │
│    simple/minor/typo     →  -2                  │
│    review/lint           →  -1                  │
│                                                 │
│  Estimate (from Linear):                        │
│    >= 5 points  →  +2                           │
│    <= 1 point   →  -2                           │
│                                                 │
│  Final: clamp(1, 10)                            │
└─────────────────────────────────────────────────┘
```

### Example Scores

| Task | Score | Model |
|------|-------|-------|
| "Fix typo in README" | 1 | `fast` |
| "Add loading spinner to dashboard" | 5 | `coder` |
| "Refactor authentication to use OAuth2" | 9 | `architect` |
| "Run linter and fix issues" | 3 | `fast` |
| "Implement distributed caching layer" | 8 | `architect` |

## Budget-Aware Routing

The router supports **hard cost caps** to prevent runaway spending:

```typescript
const router = new ModelRouter({
  config: routingConfig,
  models: modelConfigs,
  registry: providerRegistry,
  budgetCapUsd: 50.0,        // Hard cap at $50
  currentSpendUsd: 0,         // Running total
});

// Update spend after each task
router.updateSpend(currentTotal);
```

When spend exceeds the budget cap, the router **forces the cheapest available model** regardless of task complexity or strategy. This prevents a runaway agent from consuming excessive API credits.

## Performance-Aware Routing

When a `PerformanceTracker` is provided, the router uses **historical data** to improve decisions:

```
Task with label "security" arrives
  → PerformanceTracker has data showing "architect" solves
    security tasks 40% faster with 20% fewer retries
  → Router picks "architect" over the default "coder"
```

The tracker records success rate, latency, and token usage per model per task label. Over time, the router learns which models perform best for different task types.

## Explicit Model Assignment

Tasks can override routing entirely:

```typescript
const task: AgentTask = {
  id: "task-1",
  title: "Plan the new API",
  description: "...",
  assignedModel: "architect",  // Bypass routing
};
```

This is used by:
- The `--model` CLI flag
- Task decomposition (assigns `architect`, `coder`, or `fast` to subtasks)
- Integration-specific model preferences

## Fallback Chain

When the selected model is unavailable (unhealthy, rate limited, etc.), the router walks the fallback chain:

```toml
[routing]
fallback_chain = ["coder", "architect", "fast"]
```

1. Try `coder` → unhealthy → skip
2. Try `architect` → healthy → use it
3. (If all in chain fail) → try any healthy provider as last resort

## Routing Decision

The router returns a `RoutingDecision` with full transparency:

```typescript
interface RoutingDecision {
  modelKey: string;              // Selected model key
  modelConfig: ModelConfig;      // Full config for the selected model
  reason: string;                // Human-readable explanation
  fallbacksAvailable: string[];  // Remaining fallback options
}
```

Example reasons:
- `"Capability-matched to "architect" role (complexity: 9 — Architectural work — needs strong reasoning)"`
- `"Cost-optimized routing: cheapest capable model (complexity: 3)"`
- `"Budget cap reached ($52.30/$50.00), using cheapest model"`
- `"Performance-optimized: best historical model for label "security""`
- `"Fallback chain: coder (complexity: 6)"`

## Decomposition Integration

When [task decomposition](orchestration.md) is enabled, the complexity score also determines whether a task should be broken into subtasks:

```toml
[foreman]
decompose = true
decompose_threshold = 7   # Score >= 7 triggers decomposition
```

Tasks scoring at or above the threshold are sent to the `TaskDecomposer` instead of being executed directly. See [Orchestration](orchestration.md) for details.
