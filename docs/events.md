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

### Agent Events

| Event | Data | When |
|-------|------|------|
| `agent:started` | `{ session }` | Agent begins work on a task |
| `agent:iteration` | `{ session, iteration }` | Each loop iteration |
| `agent:stream` | `{ sessionId, event: StreamEvent }` | Streaming text/tool output |
| `agent:tool_call` | `{ sessionId, toolName, input }` | Tool is about to execute |
| `agent:tool_result` | `{ sessionId, toolName, result: ToolExecutionResult }` | Tool returned result |
| `agent:completed` | `{ session }` | Agent finished successfully |
| `agent:failed` | `{ session, error }` | Agent failed |
| `agent:approval_required` | `{ session, evaluation: PolicyEvaluation }` | Tool call needs approval |

### Task Events

| Event | Data | When |
|-------|------|------|
| `task:queued` | `{ task }` | Task added to queue |
| `task:assigned` | `{ task, modelKey }` | Task assigned to a model |
| `task:decomposed` | `{ task, subtaskCount, strategy }` | Task split into subtasks |
| `task:subtask_started` | `{ parentTaskId, subtaskId, title }` | Subtask agent begins |
| `task:subtask_completed` | `{ parentTaskId, subtaskId, title, success }` | Subtask agent finishes |
| `task:graph_completed` | `{ parentTaskId, completed, failed, skipped }` | All subtasks done |

### Provider Events

| Event | Data | When |
|-------|------|------|
| `provider:health_changed` | `{ providerName, health: ProviderHealth }` | Provider health status changed |

### Autopilot Events

| Event | Data | When |
|-------|------|------|
| `autopilot:run_started` | `{ run: AutopilotRun }` | Autopilot run begins |
| `autopilot:scan_complete` | `{ run, findingsCount }` | Scan finished |
| `autopilot:ticket_created` | `{ run, finding, ticketId }` | Ticket created from finding |
| `autopilot:resolve_started` | `{ run, finding }` | Auto-fix began |
| `autopilot:resolve_completed` | `{ run, finding, success }` | Auto-fix finished |
| `autopilot:run_completed` | `{ run }` | Entire run done |

## EventBus API

### Emitting Events

```typescript
import { EventBus } from "foreman";

const bus = new EventBus();

bus.emit({
  type: "agent:started",
  session: mySession,
});
```

### Listening to Events

#### Type-Specific Listener

```typescript
bus.on("agent:completed", (event) => {
  console.log(`Agent completed: ${event.session.task.title}`);
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
const event = await bus.waitFor("agent:completed", 30_000); // 30s timeout
```

### Unsubscribing

```typescript
const unsubscribe = bus.on("agent:started", handler);

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
const taskEvents = bus.getHistory("agent:completed");

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
bus.listenerCount("agent:completed"); // 3
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
                   • agent:started   → "Starting: Fix login bug"
                   • agent:stream    → Live text output
                   • agent:completed → "Done (42s, 15 iterations)"
```

### Logging

The logger subscribes to events for structured output:

```
EventBus ──emit──→ Logger ──write──→ stdout / file
                   [INFO]  agent:started  Fix login bug (model: coder)
                   [DEBUG] agent:tool_call read_file src/app.ts
                   [INFO]  agent:completed Fix login bug (42s)
```

### API Event History

The [REST API](api.md) exposes event history via `GET /api/events`:

```
EventBus ──emit──→ History Buffer ──query──→ GET /api/events
                   (ring buffer,              ?type=agent:completed
                    last 1000 events)         &limit=50
```

## Full Event Type Definition

```typescript
type ForemanEvent =
  // Agent lifecycle
  | { type: "agent:started"; session: AgentSession }
  | { type: "agent:iteration"; session: AgentSession; iteration: number }
  | { type: "agent:stream"; sessionId: string; event: StreamEvent }
  | { type: "agent:tool_call"; sessionId: string; toolName: string; input: Record<string, unknown> }
  | { type: "agent:tool_result"; sessionId: string; toolName: string; result: ToolExecutionResult }
  | { type: "agent:completed"; session: AgentSession }
  | { type: "agent:failed"; session: AgentSession; error: string }
  | { type: "agent:approval_required"; session: AgentSession; evaluation: PolicyEvaluation }

  // Provider health
  | { type: "provider:health_changed"; providerName: string; health: ProviderHealth }

  // Task lifecycle
  | { type: "task:queued"; task: AgentTask }
  | { type: "task:assigned"; task: AgentTask; modelKey: string }

  // Decomposition
  | { type: "task:decomposed"; task: AgentTask; subtaskCount: number; strategy: string }
  | { type: "task:subtask_started"; parentTaskId: string; subtaskId: string; title: string }
  | { type: "task:subtask_completed"; parentTaskId: string; subtaskId: string; title: string; success: boolean }
  | { type: "task:graph_completed"; parentTaskId: string; completed: number; failed: number; skipped: number }

  // Autopilot
  | { type: "autopilot:run_started"; run: AutopilotRun }
  | { type: "autopilot:scan_complete"; run: AutopilotRun; findingsCount: number }
  | { type: "autopilot:ticket_created"; run: AutopilotRun; finding: ReviewFinding; ticketId: string }
  | { type: "autopilot:resolve_started"; run: AutopilotRun; finding: ReviewFinding }
  | { type: "autopilot:resolve_completed"; run: AutopilotRun; finding: ReviewFinding; success: boolean }
  | { type: "autopilot:run_completed"; run: AutopilotRun };
```
