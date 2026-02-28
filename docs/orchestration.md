# Multi-Agent Orchestration

Complex tasks can be automatically decomposed into a **DAG of subtasks** and executed by multiple agents in parallel.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Orchestration Pipeline                      │
│                                                              │
│  ┌─────────┐     ┌──────────────┐     ┌──────────────────┐  │
│  │  Task    │────→│  Complexity  │────→│  TaskDecomposer  │  │
│  │  Input   │     │   Scorer     │     │                  │  │
│  └─────────┘     └──────┬───────┘     │  LLM or          │  │
│                         │             │  Heuristic        │  │
│                  score < threshold?    └────────┬─────────┘  │
│                    │          │                 │             │
│                    ▼          ▼                 ▼             │
│              ┌─────────┐  ┌──────────────────────────┐       │
│              │ Execute  │  │      TaskGraph (DAG)     │       │
│              │ directly │  │                          │       │
│              └─────────┘  │  plan ──→ implement ──→ test │   │
│                           │             │              │     │
│                           │             └──→ verify ───┘     │
│                           └────────────┬─────────────────┘   │
│                                        │                     │
│                           ┌────────────▼─────────────────┐   │
│                           │   MultiAgentExecutor          │   │
│                           │                               │   │
│                           │  Batch 1: [plan] (architect)  │   │
│                           │  Batch 2: [implement] (coder) │   │
│                           │  Batch 3: [test, verify] ║    │   │
│                           │                          ║    │   │
│                           │  (parallel within batch)  ║    │   │
│                           └───────────────────────────┘   │   │
└──────────────────────────────────────────────────────────────┘
```

## Configuration

```toml
[foreman]
decompose = true
decompose_threshold = 7    # Complexity score 1-10
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `decompose` | boolean | `false` | Enable automatic task decomposition. |
| `decompose_threshold` | number | `7` | Minimum complexity score to trigger decomposition. |

CLI flag: `foreman --decompose "Complex task description"`

## Task Decomposition

### How It Decides

When a task arrives:

1. The [router](routing.md) scores task complexity (1-10)
2. If score >= `decompose_threshold` and `decompose = true`:
   - Task is sent to the **TaskDecomposer**
3. If score < threshold:
   - Task is executed directly by a single agent

### Decomposition Methods

#### LLM-Powered (Primary)

Uses an `architect` model to analyze the task and produce a structured decomposition:

```
Task: "Implement full authentication with JWT and OAuth"
                    │
                    ▼
         ┌─────────────────┐
         │ Architect Model  │
         │                 │
         │ Analyzes task   │
         │ Produces JSON   │
         │ subtask array   │
         └────────┬────────┘
                  │
                  ▼
    [
      { id: "design",    dependsOn: [],          modelRole: "architect" },
      { id: "jwt",       dependsOn: ["design"],  modelRole: "coder" },
      { id: "oauth",     dependsOn: ["design"],  modelRole: "coder" },
      { id: "middleware", dependsOn: ["jwt"],     modelRole: "coder" },
      { id: "tests",     dependsOn: ["jwt","oauth","middleware"], modelRole: "coder" },
      { id: "verify",    dependsOn: ["tests"],   modelRole: "fast" }
    ]
```

The LLM is prompted with rules:
- Each subtask should be self-contained
- Identify dependencies between subtasks
- Keep subtasks under 30 tool calls
- Assign appropriate model roles
- 2-8 subtasks is ideal

Maximum subtasks: 8 (configurable).

#### Heuristic (Fallback)

If LLM decomposition fails or no architect provider is configured, pattern-based decomposition kicks in:

**Feature Implementation** (triggers: `feature`, `implement`, `add`, `create`, `build`):
```
plan (architect) → implement (coder) → test (coder) → verify (fast)
```

**Refactoring** (triggers: `refactor`, `restructure`, `reorganize`, `migrate`):
```
analyze (architect) → refactor (coder) → fix_tests (coder)
```

**Bug Fix** (triggers: `bug`, `fix`, `issue`, `error`, `broken`):
```
diagnose (coder) → fix (coder) → verify (fast)
```

**Generic** (long descriptions or update/change/modify keywords):
```
plan (architect) → execute (coder) → verify (fast)
```

**Simple** (default fallback):
```
implement (coder) → verify (fast)
```

Keyword matching uses **word boundaries** to avoid false positives (e.g., "padding" won't match "add").

## TaskGraph (DAG)

The `TaskGraph` is a directed acyclic graph of subtasks with dependency tracking.

### SubTask Structure

```typescript
interface SubTask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];         // IDs of upstream dependencies
  modelRole?: string;          // "architect", "coder", "fast"
  labels?: string[];
  complexity?: number;         // 1-10
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
  filesChanged?: string[];
  durationMs?: number;
}
```

### Graph Operations

```typescript
const graph = new TaskGraph();

// Add tasks
graph.addTask({ id: "plan", dependsOn: [], ... });
graph.addTask({ id: "implement", dependsOn: ["plan"], ... });
graph.addTask({ id: "test", dependsOn: ["implement"], ... });

// Get tasks ready to execute (all deps completed)
graph.getReadyTasks();
// → [plan]  (no dependencies)

// After plan completes:
graph.setStatus("plan", "completed");
graph.getReadyTasks();
// → [implement]

// Get tasks that should be skipped (upstream failed)
graph.getSkippableTasks();

// Check if all tasks are done
graph.isComplete();

// Get execution statistics
graph.getStats();
// → { total: 3, completed: 1, failed: 0, skipped: 0, pending: 2, running: 0 }

// Topological sort (linear execution order)
graph.topologicalSort();
// → [plan, implement, test]

// Parallel batches (grouped by dependency depth)
graph.getParallelBatches();
// → [[plan], [implement], [test]]
```

### Validation

The graph validates:
- No cycles (detects via DFS cycle detection)
- All dependency references exist
- At least one root task (no dependencies)

```typescript
const validation = graph.validate();
// { valid: true, errors: [] }
// or
// { valid: false, errors: ["Cycle detected involving: A, B, C"] }
```

### Diamond Dependencies

The graph correctly handles diamond patterns:

```
        A
       / \
      B   C
       \ /
        D
```

B and C can run in parallel after A completes. D waits for both B and C.

```typescript
graph.getParallelBatches();
// → [[A], [B, C], [D]]
```

## MultiAgentExecutor

Executes a `TaskGraph` by dispatching subtasks to agents with respect to dependencies and concurrency limits.

### Execution Flow

```
┌─────────────────────────────────────────┐
│          Execution Loop                  │
│                                         │
│  while (!graph.isComplete()) {          │
│                                         │
│    1. Skip tasks with failed deps       │
│       graph.getSkippableTasks()         │
│       → set status "skipped"            │
│                                         │
│    2. Get ready tasks                   │
│       graph.getReadyTasks()             │
│                                         │
│    3. Dispatch up to concurrency limit  │
│       Launch agents in parallel         │
│                                         │
│    4. Wait for any agent to complete    │
│                                         │
│    5. Record result in graph            │
│       graph.setStatus(id, "completed")  │
│       graph.setResult(id, result, ...)  │
│                                         │
│    6. Loop                              │
│  }                                      │
└─────────────────────────────────────────┘
```

### Dependency Context Injection

When a subtask depends on completed upstream tasks, their results are injected into the prompt:

```
Subtask: "Implement: Add authentication"
Dependencies completed:
  - "Plan: Add authentication" → "Plan: 1. Create auth middleware in src/middleware/auth.ts
     2. Add JWT verification using jsonwebtoken package
     3. Create login/register endpoints..."

Injected into description:
  "Context from previous steps:
   --- Plan: Add authentication ---
   Plan: 1. Create auth middleware...
   ---

   Implement the feature: Add authentication..."
```

This ensures downstream agents have the context they need without re-doing analysis.

### Skip Cascading

When a subtask fails, all downstream dependents are automatically skipped:

```
plan ──→ implement ──→ test ──→ verify
          │
          ✗ FAILED
          │
          ├──→ test: SKIPPED
          └──→ verify: SKIPPED
```

### Concurrency

The executor respects `max_concurrent_agents` from the global config:

```toml
[foreman]
max_concurrent_agents = 3
```

If 3 agents are already running, new ready tasks wait until a slot opens.

### Abort

The executor can be aborted mid-execution:

```typescript
const executor = new MultiAgentExecutor({ ... });
const promise = executor.execute(graph);

// Later:
executor.abort();
// All running agents are stopped, pending tasks are skipped
```

## Execution Result

```typescript
interface ExecutionResult {
  success: boolean;          // All tasks completed (no failures)
  graph: TaskGraph;          // Final graph state
  summary: string;           // Human-readable summary
  totalDurationMs: number;
  totalTokens: { input: number; output: number };
  filesChanged: string[];    // Aggregated across all subtasks
}
```

### Summary Format

```
Decomposed task completed: 3/4 subtasks succeeded, 1 skipped

Subtask results:
- plan (completed, 45s): Created implementation plan with 3 phases
- implement (completed, 120s): Implemented auth middleware and endpoints
- test (completed, 60s): Added 15 unit tests, all passing
- verify (skipped): Skipped due to dependency
```

## Events

The orchestration system emits events at each stage:

| Event | Data | When |
|-------|------|------|
| `task:decomposed` | `{ task, subtaskCount, strategy }` | Task decomposed into subtasks |
| `task:subtask_started` | `{ parentTaskId, subtaskId, title }` | Subtask agent begins |
| `task:subtask_completed` | `{ parentTaskId, subtaskId, title, success }` | Subtask agent finishes |
| `task:graph_completed` | `{ parentTaskId, completed, failed, skipped }` | All subtasks done |

## Example: Full Decomposition

```bash
foreman --decompose "Implement user authentication with JWT tokens and OAuth2 support"
```

1. **Complexity scored**: 9 (long description + "implement" + "authentication")
2. **Threshold check**: 9 >= 7 → decompose
3. **LLM decomposition** (architect model):
   ```
   design (architect) ──→ jwt_impl (coder) ──→ tests (coder) ──→ verify (fast)
                     └──→ oauth_impl (coder) ──┘
   ```
4. **Parallel batches**:
   - Batch 1: `[design]` — architect plans the implementation
   - Batch 2: `[jwt_impl, oauth_impl]` — two coders work in parallel
   - Batch 3: `[tests]` — coder writes tests for both
   - Batch 4: `[verify]` — fast model runs test suite
5. **Total**: 5 agents, 4 sequential batches, 2 parallel slots used
