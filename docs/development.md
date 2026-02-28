# Development Guide

How to work on Foreman itself: project structure, testing, and contributing.

## Prerequisites

- **Node.js** 20+
- **TypeScript** 5+
- **Docker** (optional, for sandbox testing)
- **Git**

## Project Structure

```
foreman/
├── src/
│   ├── index.ts                 # Public API exports
│   ├── cli.ts                   # CLI entry point & arg parsing
│   ├── orchestrator.ts          # Central coordinator
│   │
│   ├── providers/               # Model provider adapters
│   │   ├── base.ts              # ModelProvider interface
│   │   ├── registry.ts          # ProviderRegistry
│   │   ├── anthropic.ts         # Anthropic (Claude) provider
│   │   ├── openai.ts            # OpenAI provider
│   │   └── ollama.ts            # Ollama (local) provider
│   │
│   ├── router/                  # Model routing
│   │   ├── router.ts            # ModelRouter
│   │   └── performance.ts       # PerformanceTracker
│   │
│   ├── runtime/                 # Agent execution engine
│   │   ├── loop.ts              # AgentLoop (core multi-turn loop)
│   │   ├── context.ts           # ContextManager (auto-summarization)
│   │   ├── recovery.ts          # RecoveryManager (error/loop/stall)
│   │   ├── cache.ts             # ToolResultCache
│   │   ├── prompt.ts            # System prompt builder
│   │   └── subagent.ts          # SubAgentSpawner
│   │
│   ├── adapters/                # External runtime adapters
│   │   └── claude-code.ts       # Claude Code CLI adapter
│   │
│   ├── tools/                   # Tool system
│   │   ├── definitions.ts       # CORE_TOOLS schema definitions
│   │   └── executor.ts          # ToolExecutor implementation
│   │
│   ├── policy/                  # Policy enforcement
│   │   └── engine.ts            # PolicyEngine
│   │
│   ├── sandbox/                 # Execution environments
│   │   └── manager.ts           # SandboxManager
│   │
│   ├── integrations/            # External service integrations
│   │   ├── github.ts            # GitHub Issues client & watcher
│   │   ├── slack.ts             # Slack client & watcher
│   │   └── linear/
│   │       ├── client.ts        # Linear API client
│   │       └── watcher.ts       # Linear issue watcher
│   │
│   ├── autopilot/               # Autonomous codebase scanning
│   │   ├── engine.ts            # AutopilotEngine
│   │   ├── reviewer.ts          # LLM-powered code reviewer
│   │   ├── scheduler.ts         # Cron scheduler
│   │   └── tickets.ts           # Ticket creator
│   │
│   ├── learning/                # Cross-session learning
│   │   ├── knowledge.ts         # KnowledgeStore
│   │   └── agents-md.ts         # AGENTS.md manager
│   │
│   ├── skills/                  # Skill registry
│   │   └── registry.ts          # SkillsRegistry
│   │
│   ├── events/                  # Event system
│   │   └── bus.ts               # EventBus
│   │
│   ├── api/                     # HTTP API
│   │   ├── server.ts            # ApiServer
│   │   ├── handlers.ts          # Route handlers
│   │   ├── router.ts            # Path-based HTTP router
│   │   ├── websocket.ts         # WebSocket server
│   │   └── middleware.ts        # Auth, CORS, rate limiting
│   │
│   ├── hooks/                   # Claude Code hooks
│   │   ├── types.ts             # Hook event types
│   │   ├── handler.ts           # HookHandler
│   │   └── config.ts            # Config generator
│   │
│   ├── orchestration/           # Multi-agent orchestration
│   │   ├── graph.ts             # TaskGraph DAG
│   │   ├── decomposer.ts        # TaskDecomposer
│   │   └── executor.ts          # MultiAgentExecutor
│   │
│   ├── config/                  # Configuration
│   │   └── loader.ts            # TOML config loader
│   │
│   ├── storage/                 # Persistence
│   │   └── sessions.ts          # Session storage
│   │
│   ├── secrets/                 # Secret management
│   │   └── manager.ts           # SecretsManager
│   │
│   └── types/                   # Type definitions
│       └── index.ts             # All shared types
│
├── tests/                       # Test files
│   ├── providers.test.ts
│   ├── router.test.ts
│   ├── runtime.test.ts
│   ├── tools.test.ts
│   ├── policy.test.ts
│   ├── sandbox.test.ts
│   ├── integrations.test.ts
│   ├── autopilot.test.ts
│   ├── learning.test.ts
│   ├── api.test.ts
│   ├── hooks.test.ts
│   ├── orchestration.test.ts
│   └── ...
│
├── docs/                        # Documentation (you're here)
│
├── foreman.toml                 # Default config (example)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Building

```bash
# Install dependencies
npm install

# TypeScript compilation
npx tsc

# Watch mode
npx tsc --watch
```

## Testing

Tests use **Vitest** with mocking for external dependencies (API calls, Docker, file system).

```bash
# Run all tests
npx vitest run

# Watch mode
npx vitest

# Run specific test file
npx vitest run tests/policy.test.ts

# Run tests matching a pattern
npx vitest run -t "PolicyEngine"

# With coverage
npx vitest run --coverage
```

### Test Structure

Each module has a corresponding test file in `tests/`:

| Module | Test File | Coverage |
|--------|-----------|----------|
| Providers | `providers.test.ts` | Provider creation, health checks, chat mocking |
| Router | `router.test.ts` | Routing strategies, complexity scoring, fallbacks |
| Runtime | `runtime.test.ts` | Agent loop, context management, recovery, caching |
| Tools | `tools.test.ts` | Tool definitions, executor, file ops, git ops |
| Policy | `policy.test.ts` | All policy rules, protected paths, diff tracking |
| Sandbox | `sandbox.test.ts` | Lifecycle, warm pool, Docker/local modes |
| Integrations | `integrations.test.ts` | GitHub, Slack, Linear client & watcher |
| Autopilot | `autopilot.test.ts` | Engine, reviewer, scheduler, tickets |
| Learning | `learning.test.ts` | Knowledge store, AGENTS.md, skills |
| API | `api.test.ts` | All endpoints, auth, WebSocket, rate limiting |
| Hooks | `hooks.test.ts` | All hook events, policy enforcement, config gen |
| Orchestration | `orchestration.test.ts` | Graph, decomposer, executor |

### Writing Tests

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("MyComponent", () => {
  let component: MyComponent;

  beforeEach(() => {
    component = new MyComponent();
  });

  it("should do something", () => {
    const result = component.doSomething();
    expect(result).toBe("expected");
  });

  it("should handle errors", async () => {
    const mockProvider = {
      chat: vi.fn().mockRejectedValue(new Error("API error")),
    };

    await expect(component.run(mockProvider)).rejects.toThrow("API error");
  });
});
```

### Mocking Patterns

**Provider mocking**:
```typescript
const mockProvider = {
  name: "mock",
  modelId: "mock-model",
  chat: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Response" }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50 },
  }),
  chatStream: vi.fn(),
  capabilities: vi.fn().mockReturnValue({
    toolUse: true,
    streaming: true,
    vision: false,
    reasoningStrength: "high",
    speed: "medium",
    maxContextTokens: 200_000,
  }),
  costProfile: vi.fn().mockReturnValue({
    inputTokenCostPer1M: 3.0,
    outputTokenCostPer1M: 15.0,
  }),
  healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 100 }),
};
```

**File system mocking**:
```typescript
import { vol } from "memfs";
vi.mock("fs/promises", () => vol.promises);

beforeEach(() => {
  vol.fromJSON({
    "/project/src/app.ts": "console.log('hello');",
    "/project/package.json": '{"name": "test"}',
  });
});
```

## Architecture Decisions

### Zero External Dependencies (API/Server)

The HTTP server, WebSocket server, and router are built on Node's `http` module with zero npm dependencies. This:
- Reduces supply chain risk
- Keeps the install size minimal
- Avoids version conflicts

### Provider Abstraction

All LLM providers implement the same `ModelProvider` interface. This means:
- Adding a new provider requires implementing 5 methods
- No provider-specific code leaks into the orchestration layer
- Models can be swapped without changing any business logic

### Event-Driven Architecture

The `EventBus` decouples producers (orchestrator, agents, autopilot) from consumers (TUI, API, WebSocket, logger). This enables:
- Adding new consumers without modifying producers
- Real-time streaming to multiple outputs simultaneously
- Event history for debugging and API access

### Learning System

The learning system stores knowledge in simple JSON files rather than a database. This:
- Requires no external dependencies
- Is easy to inspect, edit, and version control
- Works everywhere (local, CI, containers)

## Key Patterns

### Config-First Design

Everything is configurable via TOML. Sensible defaults mean you can run with zero config.

### Graceful Degradation

- No architect model? → Heuristic decomposition
- No Docker? → Local sandboxes
- No learning data? → Standard prompts
- API provider down? → Fallback chain
- Context window full? → Auto-summarize

### Type Safety

Full TypeScript with strict mode. All events, configs, and API responses are typed. No `any` escape hatches in public APIs.

## Current Stats

- **12 phases** of implementation
- **374+ tests** across 22 test files
- **30+ source files** covering all components
- **Zero runtime dependencies** for core functionality
- **3 LLM providers** (Anthropic, OpenAI, Ollama)
- **3 integrations** (GitHub, Linear, Slack)
- **8 autopilot scanners**
- **17 agent tools**
- **7 built-in skills**
