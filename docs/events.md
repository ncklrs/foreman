# Event System

Foreman uses a type-safe event bus for real-time communication between components. Events are emitted at every lifecycle point and can be consumed via the API, WebSocket, TUI, or programmatic listeners.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                       EventBus                              │
│                                                            │
│  Emitters:                        Consumers:               │
│  ┌────────────┐                   ┌────────────────┐       │
│  │ Orchestrator│──┐           ┌──→│ TUI Renderer   │       │
│  ├────────────┤  │           │   ├────────────────┤       │
│  │ AgentLoop   │──┤    bus    │   │ WebSocket      │       │
│  ├────────────┤  ├──→ ════ ──┤   │ (broadcast)    │       │
│  │ Autopilot   │──┤           │   ├────────────────┤       │
│  ├────────────┤  │           │   │ API (history)  │       │
│  │ Watchers    │──┤           │   ├────────────────┤       │
│  ├────────────┤  │           │   │ Logger         │       │
│  │ HookHandler │──┘           └──→│ Custom         │       │
│  └────────────┘                   └────────────────┘       │
│                                                            │
│  Features:                                                 │
│  • Type-specific listeners    • Wildcard listeners         │
│  • Event history (ring buffer) • Pause/resume with buffer  │
│  • Promise-based waitFor()    • Filtering and retrieval    │
└────────────────────────────────────────────────────────────┘
```

## Event Types

### Task Events

| Event | Data | When |
|-------|------|------|
| `task:queued` | `{ task }` | Task added to queue |
| `task:started` | `{ task, modelKey, sessionId }` | Agent begins work |
| `task:completed` | `{ task, session, durationMs }` | Task finished successfully |
| `task:failed` | `{ task, error, session }` | Task failed |
| `task:decomposed` | `{ task, subtaskCount, strategy }` | Task split into subtasks |
| `task:subtask_started` | `{ parentTaskId, subtaskId, title }` | Subtask agent begins |
| `task:subtask_completed` | `{ parentTaskId, subtaskId, title, success }` | Subtask agent finishes |
| `task:graph_completed` | `{ parentTaskId, completed, failed, skipped }` | All subtasks done |

### Agent Events

| Event | Data | When |
|-------|------|------|
| `agent:iteration` | `{ sessionId, iteration, tokenUsage }` | Each loop iteration |
| `agent:tool_called` | `{ sessionId, tool, input, durationMs }` | Tool executed |
| `agent:tool_result` | `{ sessionId, tool, output, cached }` | Tool returned result |
| `agent:error` | `{ sessionId, error, recoverable }` | Error in agent loop |
| `agent:recovery` | `{ sessionId, type, message }` | Recovery action taken |
| `agent:context_summarized` | `{ sessionId, tokensBefore, tokensAfter }` | Context compressed |
| `agent:streaming` | `{ sessionId, text }` | Streaming text output |

### Autopilot Events

| Event | Data | When |
|-------|------|------|
| `autopilot:scan_started` | `{ scanners, runId }` | Scan begins |
| `autopilot:scan_completed` | `{ findings, runId }` | Scan finished |
| `autopilot:ticket_created` | `{ title, target, url }` | Ticket created |
| `autopilot:resolve_started` | `{ finding, runId }` | Auto-fix began |
| `autopilot:resolve_completed` | `{ finding, success, runId }` | Auto-fix finished |
| `autopilot:run_completed` | `{ stats, runId }` | Entire run done |

### Integration Events

| Event | Data | When |
|-------|------|------|
| `integration:task_received` | `{ source, task }` | New task from watcher |
| `integration:update_posted` | `{ source, target, message }` | Progress update sent |

### System Events

| Event | Data | When |
|-------|------|------|
| `system:started` | `{ config }` | Foreman booted |
| `system:shutdown` | `{ reason }` | Graceful shutdown |
| `system:error` | `{ error }` | Unrecoverable error |

## EventBus API

### Emitting Events

```typescript
import { EventBus } from "foreman";

const bus = new EventBus();

bus.emit({
  type: "task:started",
  task: myTask,
  modelKey: "coder",
  sessionId: "session-abc",
});
```

### Listening to Events

#### Type-Specific Listener

```typescript
bus.on("task:completed", (event) => {
  console.log(`Task ${event.task.title} completed in ${event.durationMs}ms`);
});
```

#### Wildcard Listener

```typescript
bus.onAny((event) => {
  console.log(`[${event.type}]`, event);
});
```

#### One-Shot Wait

```typescript
// Wait for the next event of a specific type
const event = await bus.waitFor("task:completed", 30_000); // 30s timeout
```

### Unsubscribing

```typescript
const unsubscribe = bus.on("task:started", handler);

// Later:
unsubscribe();
```

### Event History

The bus maintains a ring buffer of recent events:

```typescript
const bus = new EventBus({ historySize: 1000 }); // Default: 1000

// Get all history
const allEvents = bus.getHistory();

// Filter by type
const taskEvents = bus.getHistory("task:completed");

// Filter by time
const recentEvents = bus.getHistorySince(new Date("2025-01-15T10:00:00Z"));
```

### Pause / Resume

```typescript
// Pause — events are buffered, not delivered
bus.pause();

// ... do something ...

// Resume — buffered events are delivered
bus.resume();
```

### Listener Count

```typescript
bus.listenerCount("task:completed"); // 3
bus.listenerCount();                 // total across all types
```

## Integration with Other Systems

### WebSocket Broadcasting

The [API server](api.md) connects to the event bus and broadcasts events to WebSocket clients:

```
EventBus ──emit──→ WebSocket Server ──broadcast──→ Connected Clients
                   (filtered by subscription)
```

### TUI Rendering

The terminal UI subscribes to events for real-time display:

```
EventBus ──emit──→ TUI ──render──→ Terminal
                   • task:started   → "Starting: Fix login bug"
                   • agent:streaming → Live text output
                   • task:completed  → "Done (42s, 15 iterations)"
```

### Logging

The logger subscribes to events for structured output:

```
EventBus ──emit──→ Logger ──write──→ stdout / file
                   [INFO]  task:started  Fix login bug (model: coder)
                   [DEBUG] agent:tool_called read_file src/app.ts
                   [INFO]  task:completed Fix login bug (42s)
```

### API Event History

The [REST API](api.md) exposes event history via `GET /api/events`:

```
EventBus ──emit──→ History Buffer ──query──→ GET /api/events
                   (ring buffer,              ?type=task:completed
                    last 1000 events)         &limit=50
```

## Full Event Type Definition

```typescript
type ForemanEvent =
  // Task lifecycle
  | { type: "task:queued"; task: AgentTask }
  | { type: "task:started"; task: AgentTask; modelKey: string; sessionId: string }
  | { type: "task:completed"; task: AgentTask; session: AgentSession; durationMs: number }
  | { type: "task:failed"; task: AgentTask; error: string; session?: AgentSession }

  // Decomposition
  | { type: "task:decomposed"; task: AgentTask; subtaskCount: number; strategy: string }
  | { type: "task:subtask_started"; parentTaskId: string; subtaskId: string; title: string }
  | { type: "task:subtask_completed"; parentTaskId: string; subtaskId: string; title: string; success: boolean }
  | { type: "task:graph_completed"; parentTaskId: string; completed: number; failed: number; skipped: number }

  // Agent internals
  | { type: "agent:iteration"; sessionId: string; iteration: number; tokenUsage: TokenUsage }
  | { type: "agent:tool_called"; sessionId: string; tool: string; input: unknown; durationMs: number }
  | { type: "agent:tool_result"; sessionId: string; tool: string; output: string; cached: boolean }
  | { type: "agent:error"; sessionId: string; error: string; recoverable: boolean }
  | { type: "agent:recovery"; sessionId: string; type: string; message: string }
  | { type: "agent:context_summarized"; sessionId: string; tokensBefore: number; tokensAfter: number }
  | { type: "agent:streaming"; sessionId: string; text: string }

  // Autopilot
  | { type: "autopilot:scan_started"; scanners: string[]; runId: string }
  | { type: "autopilot:scan_completed"; findings: ReviewFinding[]; runId: string }
  | { type: "autopilot:ticket_created"; title: string; target: string; url?: string }
  | { type: "autopilot:resolve_started"; finding: ReviewFinding; runId: string }
  | { type: "autopilot:resolve_completed"; finding: ReviewFinding; success: boolean; runId: string }
  | { type: "autopilot:run_completed"; stats: AutopilotRunStats; runId: string }

  // Integrations
  | { type: "integration:task_received"; source: string; task: AgentTask }
  | { type: "integration:update_posted"; source: string; target: string; message: string }

  // System
  | { type: "system:started"; config: ForemanConfig }
  | { type: "system:shutdown"; reason: string }
  | { type: "system:error"; error: string };
```
