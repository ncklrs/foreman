# Foreman Documentation

**Foreman** is a model-agnostic agentic coding runtime. It orchestrates AI agents to execute software engineering tasks autonomously — bug fixes, feature implementations, refactoring, code reviews, and continuous codebase maintenance.

---

## Documentation Index

### Getting Started

- **[Getting Started](getting-started.md)** — Installation, first run, basic usage
- **[Configuration Reference](configuration.md)** — Complete `foreman.toml` reference
- **[CLI Reference](cli.md)** — All command-line flags and usage patterns

### Architecture

- **[Architecture Overview](architecture.md)** — System design, component map, data flow diagrams
- **[Agent Runtime](agent-runtime.md)** — Execution loop, context management, recovery, caching
- **[Event System](events.md)** — Typed event bus, all event types, subscription patterns

### Core Systems

- **[Model Providers](providers.md)** — Anthropic, OpenAI, Ollama, custom providers
- **[Model Routing](routing.md)** — Routing strategies, complexity scoring, budget caps
- **[Tools](tools.md)** — All agent tools with full input schemas
- **[Policy Engine](policy.md)** — Safety rules, protected paths, approval workflows
- **[Sandbox Environments](sandbox.md)** — Docker, local, and cloud isolation

### Intelligence

- **[Learning System](learning.md)** — KnowledgeStore, AGENTS.md, cross-session memory
- **[Skills](learning.md#skills-registry)** — Built-in and custom skills, prompt enrichment
- **[Multi-Agent Orchestration](orchestration.md)** — Task decomposition, DAGs, parallel execution
- **[Autopilot Mode](autopilot.md)** — Scheduled scanning, auto-remediation

### Integration

- **[Integrations](integrations.md)** — GitHub, Linear, Slack watchers and clients
- **[HTTP API Reference](api.md)** — REST endpoints, WebSocket, Prometheus metrics
- **[Claude Code Hooks](hooks.md)** — Sidecar mode, hook protocol, setup

### Development

- **[Programmatic Usage](programmatic.md)** — Using Foreman as a library
- **[Development Guide](development.md)** — Testing, contributing, architecture decisions

---

## Project Stats

| Metric | Value |
|--------|-------|
| Language | TypeScript (ES Modules) |
| Node.js | >= 20.0.0 |
| Source files | ~70 modules |
| Test suites | 22 |
| Tests | 374 |
| External dependencies | 7 |
| Phases built | 12 |

---

## Quick Links

```bash
# Run a task
foreman "Fix the login bug"

# Watch for work
foreman --watch

# Autopilot scan
foreman --autopilot-once --no-tui

# Claude Code sidecar
foreman --hooks --api

# API server
foreman --api --api-port 4820
```
