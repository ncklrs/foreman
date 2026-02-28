# Foreman

Model-agnostic agentic coding runtime with TUI control plane.

Foreman orchestrates AI agents to execute software engineering tasks autonomously — bug fixes, feature implementations, refactoring, code reviews, and more. It supports multiple LLM providers, enforces safety policies, learns from past sessions, and integrates with GitHub, Linear, and Slack.

## Quick Start

```bash
# Install
npm install && npm run build

# Run a task
foreman "Fix the login bug in src/auth.ts"

# Force a specific model
foreman --task "Add dark mode" --model architect

# Watch for GitHub/Linear/Slack tasks
foreman --watch

# Autopilot: scan codebase and auto-fix issues
foreman --autopilot-once --no-tui

# Claude Code sidecar (policy + learning via hooks)
foreman --hooks-setup && foreman --hooks --api

# Auto-decompose complex tasks into parallel subtask DAGs
foreman --decompose "Implement full authentication with JWT and OAuth"
```

**Requirements:** Node.js >= 20.0.0

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         CLI / TUI                                │
│  foreman "Fix bug" │ --watch │ --autopilot │ --hooks │ --api    │
└──────────────┬───────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────┐
│                       Orchestrator                               │
│  Task queue │ Session mgmt │ Learning │ Decomposition            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Model Router │  │ Policy Engine │  │ Task Decomposer      │   │
│  │ capability   │  │ protected     │  │ DAG → parallel       │   │
│  │ cost         │  │ blocked       │  │ batches              │   │
│  │ speed        │  │ diff limits   │  └──────────────────────┘   │
│  └──────┬──────┘  └──────────────┘                              │
│         │                                                        │
│  ┌──────▼──────────────────────────────────────────────────┐    │
│  │                    Agent Runtime                         │    │
│  │  AgentLoop (built-in) │ ClaudeCode CLI │ MultiAgent DAG │    │
│  │  Context Manager │ Recovery Manager │ SubAgent Spawner   │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Providers: Anthropic │ OpenAI │ Ollama (local) │ Custom  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ │
│  │ EventBus │ │ Learning │ │ Skills │ │ Autopilot│ │ Hooks  │ │
│  └──────────┘ └──────────┘ └────────┘ └──────────┘ └────────┘ │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Integrations: GitHub │ Linear │ Slack │ HTTP API │ WS    │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Features

| Feature | Description |
|---------|-------------|
| **Multi-Provider** | Anthropic, OpenAI, Ollama — swap models without changing code |
| **Smart Routing** | Routes tasks to the right model by complexity, cost, or speed |
| **Agent Runtime** | Multi-turn tool-calling loop with context management and recovery |
| **Policy Engine** | Protected paths, blocked commands, diff limits, approval workflows |
| **Sandboxes** | Docker, local, or cloud (Fly.io, Daytona) isolation |
| **Integrations** | Watch GitHub Issues, Linear tickets, Slack messages for tasks |
| **Autopilot** | 8 codebase scanners with auto-ticketing and auto-remediation |
| **Learning** | Cross-session knowledge, AGENTS.md conventions, skills registry |
| **Claude Code Hooks** | Run as a sidecar for policy enforcement and telemetry |
| **Task Decomposition** | Break complex tasks into parallel subtask DAGs |
| **HTTP API + WebSocket** | Full REST API with real-time event streaming |
| **Event System** | Typed event bus connecting all components |

## Minimal Config

```toml
[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
role = "code generation"
max_tokens = 4096
```

Or just run `foreman "task"` with no config — sensible defaults are used automatically.

## Documentation

Full documentation is in [`docs/`](docs/README.md):

| Page | Description |
|------|-------------|
| [Getting Started](docs/getting-started.md) | Installation, first run, basic usage |
| [Configuration](docs/configuration.md) | Complete `foreman.toml` reference |
| [CLI Reference](docs/cli.md) | All flags, examples, exit codes |
| [Architecture](docs/architecture.md) | System design, component map, data flow diagrams |
| [Model Providers](docs/providers.md) | Anthropic, OpenAI, Ollama, custom providers |
| [Model Routing](docs/routing.md) | Routing strategies, complexity scoring, budget caps |
| [Agent Runtime](docs/agent-runtime.md) | Execution loop, context management, recovery, caching |
| [Tools](docs/tools.md) | All 17 agent tools with full schemas |
| [Policy Engine](docs/policy.md) | Safety rules, protected paths, approval workflows |
| [Sandbox](docs/sandbox.md) | Docker, local, and cloud isolation |
| [Integrations](docs/integrations.md) | GitHub, Linear, Slack watchers and clients |
| [Autopilot](docs/autopilot.md) | 8 scanners, scheduling, auto-remediation |
| [Learning System](docs/learning.md) | KnowledgeStore, AGENTS.md, skills registry |
| [HTTP API](docs/api.md) | REST endpoints, WebSocket, Prometheus metrics |
| [Claude Code Hooks](docs/hooks.md) | Sidecar mode, hook protocol, setup |
| [Orchestration](docs/orchestration.md) | Task decomposition, DAGs, parallel execution |
| [Event System](docs/events.md) | Typed event bus, all event types |
| [Programmatic Usage](docs/programmatic.md) | Using Foreman as a library |
| [Development Guide](docs/development.md) | Project structure, testing, contributing |

## Testing

```bash
npx vitest run          # 374 tests, 22 suites
npx vitest              # Watch mode
npx vitest run --coverage
```

## License

MIT
