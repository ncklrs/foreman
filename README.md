# Foreman

Model-agnostic agentic coding runtime with TUI control plane.

Foreman orchestrates AI agents to execute software engineering tasks autonomously — bug fixes, feature implementations, refactoring, code reviews, and more. It supports multiple LLM providers, enforces safety policies, learns from past sessions, and integrates with GitHub, Linear, and Slack.

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Architecture](#architecture)
- [Model Providers](#model-providers)
- [Model Routing](#model-routing)
- [Agent Runtime](#agent-runtime)
- [Tools](#tools)
- [Policy Engine](#policy-engine)
- [Sandbox Environments](#sandbox-environments)
- [Integrations](#integrations)
- [Autopilot Mode](#autopilot-mode)
- [Learning System](#learning-system)
- [Skills](#skills)
- [HTTP API](#http-api)
- [Claude Code Hooks](#claude-code-hooks)
- [Multi-Agent Orchestration](#multi-agent-orchestration)
- [Event System](#event-system)
- [Programmatic Usage](#programmatic-usage)
- [Testing](#testing)

---

## Quick Start

```bash
# Run a single task
foreman "Fix the login bug in src/auth.ts"

# Run with a specific model
foreman --task "Add dark mode" --model architect

# Watch for GitHub/Linear tasks
foreman --watch

# Run as a Claude Code sidecar (hooks mode)
foreman --hooks --api

# Autopilot: scan codebase and auto-fix issues
foreman --autopilot-once --no-tui
```

## Installation

```bash
npm install
npm run build
```

**Requirements:** Node.js >= 20.0.0

**Binary:** After building, `foreman` is available at `dist/cli.js`. Add to PATH or use `npm link`.

---

## Configuration

Foreman loads configuration from TOML files, searched in order:

1. `./foreman.toml`
2. `./.foreman.toml`
3. `~/.config/foreman/foreman.toml`

Override with `--config <path>`.

### Full Configuration Reference

```toml
# ── Core Settings ────────────────────────────────────────────────

[foreman]
name = "my-foreman"                     # Instance name (appears in logs)
log_level = "info"                      # debug | info | warn | error
max_concurrent_agents = 3              # Max parallel agent sessions
runtime = "foreman"                     # "foreman" (built-in) | "claude-code"
decompose = false                       # Auto-decompose complex tasks
decompose_threshold = 7                 # Complexity score threshold (1-10)

# ── Model Definitions ───────────────────────────────────────────

[models.architect]
provider = "anthropic"
model = "claude-opus-4-6"
role = "planning, architecture, complex reasoning"
max_tokens = 8192
temperature = 0.3

[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
role = "code generation, implementation"
max_tokens = 4096
temperature = 0.2

[models.fast]
provider = "anthropic"
model = "claude-haiku-4-5-20251001"
role = "classification, routing, simple transforms"
max_tokens = 1024

[models.local]
provider = "local"
model = "qwen3:32b"
endpoint = "http://localhost:11434"
role = "code review, quick checks"
max_tokens = 2048

[models.gpt]
provider = "openai"
model = "gpt-4o"
role = "alternative implementation"
max_tokens = 4096
api_key = "${OPENAI_API_KEY}"

# ── Routing ──────────────────────────────────────────────────────

[routing]
strategy = "capability_match"           # capability_match | cost_optimized | speed_first
fallback_chain = ["coder", "architect", "fast"]

# ── Sandbox ──────────────────────────────────────────────────────

[sandbox]
type = "docker"                         # docker | local
warm_pool = 3                           # Pre-warmed containers
timeout_minutes = 30
cleanup = "on_success"                  # on_success | always | never

[sandbox.cloud]                         # Optional cloud sandboxes
provider = "fly"                        # fly | daytona
app = "foreman-sandboxes"
region = "iad"

# ── Policy ───────────────────────────────────────────────────────

[policy]
protected_paths = [
  "package.json",
  ".env",
  ".env.*",
  ".github/*",
  "docker-compose.yml"
]
blocked_commands = ["rm -rf /", "curl | sh"]
max_diff_lines = 500                    # Hard limit on total diff size
require_approval_above = 200           # Lines changed before approval needed

# ── Integrations ─────────────────────────────────────────────────

[linear]
api_key = "${LINEAR_API_KEY}"
team = "ENG"
watch_labels = ["agent-ready"]
watch_status = "Todo"

[github]
token = "${GITHUB_TOKEN}"
owner = "your-org"
repo = "your-repo"
watch_labels = ["agent-ready"]
watch_state = "open"

[slack]
bot_token = "${SLACK_BOT_TOKEN}"
watch_channels = ["#eng-agents"]
trigger_prefix = "!agent"
post_progress = true

# ── Autopilot ────────────────────────────────────────────────────

[autopilot]
enabled = true
schedule = "0 9 * * 1-5"               # Weekdays at 9am UTC
timezone = "UTC"
scanners = ["security", "code_quality", "test_coverage", "dependencies"]
max_tickets_per_run = 5
auto_resolve = true
max_concurrent_resolves = 2
min_severity = 3                        # 1=info, 5=critical
ticket_target = "github"               # github | linear
ticket_labels = ["autopilot"]
branch_prefix = "autopilot/"

# ── HTTP API ─────────────────────────────────────────────────────

[api]
enabled = true
port = 4820
host = "127.0.0.1"
api_key = "${FOREMAN_API_KEY}"
cors_origins = ["http://localhost:3000"]
```

### Environment Variable Substitution

Use `${VAR_NAME}` in any string value to reference environment variables:

```toml
[linear]
api_key = "${LINEAR_API_KEY}"
```

---

## CLI Reference

```
foreman [OPTIONS] [TASK]
```

### Options

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to foreman.toml config file |
| `-t, --task <title>` | Task title to execute |
| `-d, --description <text>` | Task description (defaults to title) |
| `-m, --model <role>` | Force a specific model role |
| `--dir <path>` | Working directory for the agent |
| `--no-tui` | Run without the terminal UI |
| `-w, --watch` | Watch integrations for new tasks |
| `--autopilot` | Start autopilot mode (cron-scheduled) |
| `--autopilot-once` | Run one autopilot scan, then exit |
| `--api` | Enable HTTP API server |
| `--api-port <port>` | API server port (default: 4820) |
| `--runtime <type>` | Agent runtime: `foreman` or `claude-code` |
| `--hooks` | Enable Claude Code hooks server |
| `--hooks-setup` | Write hooks config to `.claude/settings.json` |
| `--hooks-print` | Print hooks config to stdout |
| `--decompose` | Auto-decompose complex tasks into subtask DAGs |
| `-h, --help` | Show help message |

### Examples

```bash
# Simple task execution
foreman "Fix the login bug"

# Force architect model with description
foreman --task "Add dark mode" --description "Add theme toggle to settings" --model architect

# Watch for tasks (GitHub + Linear + Slack)
foreman --watch

# Autopilot: continuous background scanning
foreman --autopilot

# Single autopilot scan with output
foreman --autopilot-once --no-tui

# API server + hooks for Claude Code sidecar
foreman --hooks --api --api-port 4820

# Auto-configure Claude Code to use Foreman hooks
foreman --hooks-setup

# Decompose and parallelize complex work
foreman --decompose "Implement full authentication system with JWT, sessions, and OAuth"
```

---

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
│  │  ┌───────────┐  ┌───────────────┐  ┌────────────────┐  │    │
│  │  │ AgentLoop  │  │ ClaudeCode    │  │ MultiAgent     │  │    │
│  │  │ (built-in) │  │ Runner        │  │ Executor       │  │    │
│  │  │            │  │ (CLI adapter) │  │ (parallel DAG) │  │    │
│  │  └───────────┘  └───────────────┘  └────────────────┘  │    │
│  │                                                         │    │
│  │  ┌───────────┐  ┌───────────┐  ┌──────────────┐       │    │
│  │  │ Context   │  │ Recovery  │  │ SubAgent     │       │    │
│  │  │ Manager   │  │ Manager   │  │ Spawner      │       │    │
│  │  └───────────┘  └───────────┘  └──────────────┘       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                     Providers                              │  │
│  │  Anthropic  │  OpenAI  │  Ollama (local)  │  Custom       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ │
│  │ EventBus │ │ Learning │ │ Skills │ │ Autopilot│ │ Hooks  │ │
│  └──────────┘ └──────────┘ └────────┘ └──────────┘ └────────┘ │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Integrations                             │  │
│  │  GitHub  │  Linear  │  Slack  │  HTTP API  │  WebSocket   │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Component Overview

| Component | Purpose |
|-----------|---------|
| **Orchestrator** | Central coordinator. Manages task queue, sessions, routing, lifecycle |
| **Model Router** | Selects best model per task based on complexity, cost, speed |
| **Agent Runtime** | Executes tasks via tool-calling loops (built-in, Claude Code, or multi-agent) |
| **Policy Engine** | Enforces safety: protected paths, blocked commands, diff limits |
| **EventBus** | Typed pub/sub for all lifecycle events |
| **KnowledgeStore** | Persistent cross-session learning (`~/.foreman/knowledge.json`) |
| **SkillsRegistry** | Task-specific prompt enrichment (7 built-in + custom skills) |
| **AutopilotEngine** | Scheduled codebase scanning and auto-remediation |
| **HookHandler** | Claude Code sidecar: policy + telemetry via HTTP hooks |
| **TaskDecomposer** | Breaks complex tasks into parallel subtask DAGs |

---

## Model Providers

Foreman supports three provider types:

### Anthropic

```toml
[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
max_tokens = 4096
```

Requires `ANTHROPIC_API_KEY` environment variable.

### OpenAI

```toml
[models.gpt]
provider = "openai"
model = "gpt-4o"
max_tokens = 4096
api_key = "${OPENAI_API_KEY}"
```

### Local (Ollama)

```toml
[models.local]
provider = "local"
model = "qwen3:32b"
endpoint = "http://localhost:11434"
max_tokens = 2048
```

Connects to any Ollama-compatible API.

### Provider Registry

All providers are managed through the `ProviderRegistry`, which handles:
- Health checking (periodic, every 5 minutes)
- Capability reporting (reasoning strength, speed, context window)
- Cost profiles (per-million-token pricing)
- Fallback when a provider is unhealthy

---

## Model Routing

The router selects the best model for each task. Three strategies:

### capability_match (default)

Maps task complexity to model capability:

| Complexity Score | Model Role |
|-----------------|------------|
| 8-10 | `architect` (strongest reasoning) |
| 4-7 | `coder` (balanced) |
| 1-3 | `fast` (quick, cheap) |

### cost_optimized

Selects the cheapest model that meets minimum reasoning requirements. Enforces budget caps — when spend exceeds `budgetCapUsd`, forces the cheapest model.

### speed_first

Selects the fastest available model regardless of reasoning strength.

### Complexity Scoring

Tasks are scored 1-10 based on:
- Description length (+2 for >2000 chars, -2 for <100 chars)
- Labels (`refactor`/`architecture` → +2, `simple`/`docs` → -2)
- Linear estimate (high → +2, low → -2)

### Performance-Aware Routing

After tasks complete, performance data is recorded. The router learns which models perform best for specific label types and preferentially routes matching tasks.

---

## Agent Runtime

### Built-in AgentLoop

The core execution engine:

1. **System prompt** built from task context, codebase, policies, enrichments
2. **Message loop**: send to LLM → parse tool calls → execute → feed results back
3. **Context management**: auto-summarize when approaching token limits
4. **Recovery**: detect infinite loops, stalls, repeated failures
5. **Completion**: `task_done` tool call or max iterations reached

### Claude Code Runtime

Alternative runtime that delegates execution to Claude Code CLI:

```bash
foreman --runtime claude-code "Fix the bug"
```

Spawns `claude --print --output-format stream-json` and streams events back through Foreman's event bus. Inherits Foreman's learning system (knowledge + skills + AGENTS.md are injected into the prompt).

### Multi-Agent Executor

For decomposed tasks, the executor runs subtask DAGs:

```bash
foreman --decompose "Implement full authentication"
```

Independent subtasks run in parallel, respecting dependency ordering. Failed subtasks cascade skips to downstream dependencies.

---

## Tools

Agents have access to these tools:

### File Operations

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents (supports offset/limit) |
| `write_file` | Create or overwrite files |
| `edit_file` | Targeted string replacement edits |
| `delete_file` | Delete files |
| `search_codebase` | Regex search across the codebase |

### Git Operations

| Tool | Description |
|------|-------------|
| `git_status` | Working tree status |
| `git_diff` | Preview staged/unstaged changes |
| `git_commit` | Stage and commit changes |
| `git_branch` | Create/switch branches |
| `git_log` | View commit history |
| `git_push` | Push to remote |
| `create_pull_request` | Create a pull request |

### Command Execution

| Tool | Description |
|------|-------------|
| `run_command` | Execute shell commands (subject to policy) |
| `run_test` | Run test suites |

### Agent Coordination

| Tool | Description |
|------|-------------|
| `spawn_subagent` | Delegate subtask to another model |
| `task_done` | Signal task completion with summary |
| `web_fetch` | Fetch and parse web content |

---

## Policy Engine

The policy engine evaluates every tool call against configured rules.

### Decisions

- **allow** — proceed normally
- **require_approval** — pause and wait for human approval
- **deny** — block the tool call

### Protected Paths

Files matching protected path patterns require approval before writing:

```toml
protected_paths = ["package.json", ".env", ".env.*", ".github/*"]
```

### Blocked Commands

Commands matching these patterns are denied:

```toml
blocked_commands = ["rm -rf /", "curl | sh"]
```

Additionally, these dangerous patterns are always blocked:
- Fork bombs
- Writing to block devices
- Formatting filesystems
- `dd` to devices

### Approval-Required Commands

These command patterns require human approval:
- `npm install/uninstall/update`
- `pip install`
- `git push`, `git reset --hard`
- Package manager modifications

### Diff Size Limits

```toml
max_diff_lines = 500           # Hard deny above this
require_approval_above = 200   # Approval needed above this
```

---

## Sandbox Environments

Agents execute in isolated environments:

### Local Sandbox

```toml
[sandbox]
type = "local"
```

Uses the local filesystem with git worktree isolation.

### Docker Sandbox

```toml
[sandbox]
type = "docker"
warm_pool = 3
timeout_minutes = 30
cleanup = "on_success"
```

Each task gets a fresh Docker container. The warm pool pre-creates containers for fast startup.

### Cloud Sandbox

```toml
[sandbox.cloud]
provider = "fly"
app = "foreman-sandboxes"
region = "iad"
```

Supports Fly.io and Daytona for remote sandboxed execution.

---

## Integrations

### GitHub

Watch for issues labeled `agent-ready` and auto-assign agents:

```toml
[github]
token = "${GITHUB_TOKEN}"
owner = "your-org"
repo = "your-repo"
watch_labels = ["agent-ready"]
```

Foreman will:
- Pick up labeled issues
- Add `agent-working` label while processing
- Comment progress/results on the issue
- Add `agent-completed` or `agent-failed` label when done

### Linear

Watch for tickets in a specific status:

```toml
[linear]
api_key = "${LINEAR_API_KEY}"
team = "ENG"
watch_labels = ["agent-ready"]
watch_status = "Todo"
```

Foreman will:
- Pick up matching tickets
- Update status to "In Progress"
- Comment results and update to "In Review" on completion

### Slack

Respond to messages in designated channels:

```toml
[slack]
bot_token = "${SLACK_BOT_TOKEN}"
watch_channels = ["#eng-agents"]
trigger_prefix = "!agent"
post_progress = true
```

Users trigger tasks with `!agent Fix the login bug`, and Foreman reacts with progress emojis and threaded replies.

---

## Autopilot Mode

Autopilot runs scheduled codebase scans and can auto-create tickets or auto-fix issues.

### Scanners

| Scanner | What It Finds |
|---------|--------------|
| `security` | Security vulnerabilities, unsafe patterns |
| `dependencies` | Outdated or vulnerable dependencies |
| `code_quality` | Code smells, complexity, duplication |
| `test_coverage` | Missing test coverage |
| `performance` | Performance bottlenecks |
| `documentation` | Missing or outdated documentation |
| `dead_code` | Unused exports, unreachable code |
| `type_safety` | Type errors, unsafe casts |

### Usage

```bash
# One-off scan
foreman --autopilot-once --no-tui

# Continuous (cron-scheduled)
foreman --autopilot --watch
```

### Configuration

```toml
[autopilot]
enabled = true
schedule = "0 9 * * 1-5"          # Weekdays at 9am
scanners = ["security", "code_quality", "test_coverage"]
max_tickets_per_run = 5
auto_resolve = true                # Auto-fix issues
min_severity = 3                   # Only create tickets for severity >= 3
ticket_target = "github"           # Create GitHub issues
ticket_labels = ["autopilot"]
```

### Flow

1. **Scan**: LLM-powered scanners analyze the codebase
2. **Deduplicate**: Filter out previously-seen findings via KnowledgeStore
3. **Triage**: Filter by minimum severity
4. **Ticket**: Create GitHub issues or Linear tickets
5. **Resolve** (optional): Spawn agents to auto-fix each finding

---

## Learning System

Foreman learns from every session and improves over time.

### KnowledgeStore

Persistent storage at `~/.foreman/knowledge.json`:

- **Lessons**: patterns, anti-patterns, conventions, tool tips learned from sessions
- **Failure patterns**: recurring errors and their resolutions
- **Model preferences**: which model performs best for which task labels
- **Seen findings**: fingerprints for deduplicating autopilot findings

Lessons are injected into agent prompts as a `## Lessons Learned` section.

### AGENTS.md

Convention file that tells agents how to work with a specific codebase. Searched in:

1. `AGENTS.md`
2. `.github/AGENTS.md`
3. `docs/AGENTS.md`
4. `.foreman/AGENTS.md`

Contents are injected into agent system prompts. Can be auto-generated via the architect model.

### Learning Sources

- **Sessions**: After each task, successful patterns and errors are extracted
- **Autopilot**: Finding deduplication prevents re-reporting known issues
- **User corrections**: Manual lessons via API (`POST /api/knowledge/learn`)
- **Hook telemetry**: Tool usage patterns from Claude Code hooks sessions

---

## Skills

Skills are task-specific prompt enrichments that activate when their triggers match a task.

### Built-in Skills

| Skill | Triggers | What It Adds |
|-------|----------|-------------|
| `code-review` | review, audit, check | Review methodology, checklist |
| `refactor` | refactor, restructure | Safe refactoring guidelines |
| `test-writing` | test, spec, coverage | Test strategy, patterns |
| `bug-fix` | bug, fix, issue, error | Diagnosis methodology |
| `feature-implementation` | feature, implement, add | Implementation checklist |
| `migration` | migrate, upgrade, update | Migration safety procedures |
| `security-fix` | security, vulnerability, CVE | Security remediation guidelines |

### Custom Skills

Create JSON files in `.foreman/skills/`:

```json
{
  "name": "database-migration",
  "description": "Handles database schema migrations safely",
  "triggers": ["migration", "schema", "database"],
  "promptTemplate": "When performing database migrations:\n1. Always create a reversible migration\n2. Test with production-like data\n3. ...",
  "tags": ["database", "migration"],
  "tools": []
}
```

### Programmatic Registration

```typescript
import { SkillsRegistry } from "foreman";

const registry = new SkillsRegistry();
registry.register({
  name: "my-skill",
  description: "Custom skill",
  triggers: ["keyword"],
  promptTemplate: "Instructions...",
  tags: [],
  source: "programmatic",
});
```

---

## HTTP API

Enable with `--api` or `[api]` config section. Default port: 4820.

### Authentication

Set `api_key` in config. Authenticate via:
- Header: `Authorization: Bearer <key>`
- Query param: `?key=<key>`

### Endpoints

#### Health & Status

```
GET /api/health              → Server health, provider status, session counts
GET /api/providers           → All configured model providers with health
GET /api/config              → Current configuration (secrets redacted)
```

#### Sessions

```
GET /api/sessions            → List sessions (filter: ?status=running, ?limit=50)
GET /api/sessions/:id        → Session detail with full message history
```

#### Tasks

```
POST /api/tasks              → Enqueue a new task
  Body: { "title": "...", "description": "...", "labels": [...], "model": "..." }
```

#### Events

```
GET /api/events              → Event history (filter: ?type=agent, ?limit=100)
```

#### Knowledge

```
GET /api/knowledge           → Knowledge store summary
GET /api/knowledge/lessons   → List lessons (filter: ?type=pattern)
POST /api/knowledge/learn    → Record a manual lesson
  Body: { "summary": "...", "detail": "...", "tags": [...] }
```

#### Skills

```
GET /api/skills              → List all registered skills
```

#### Autopilot

```
GET /api/autopilot/runs      → List autopilot run history
POST /api/autopilot/trigger  → Trigger an immediate autopilot run
```

#### Metrics

```
GET /api/metrics             → JSON metrics (sessions, tokens, models)
GET /api/metrics/prometheus  → Prometheus-compatible text metrics
```

### WebSocket

```
ws://localhost:4820/api/ws
```

Real-time streaming of all `ForemanEvent`s. Supports client-side filtering and ping/pong keepalive.

---

## Claude Code Hooks

Foreman can act as a **sidecar** to Claude Code. Instead of spawning Claude Code as a subprocess, you run Claude Code directly and it POSTs lifecycle events to Foreman.

### Setup

```bash
# Auto-configure Claude Code
foreman --hooks-setup

# Start Foreman as hook server
foreman --hooks --api
```

This writes to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "type": "http",
      "url": "http://127.0.0.1:4820/api/hooks/pre-tool-use",
      "timeout": 5000
    }],
    "PostToolUse": [{
      "type": "http",
      "url": "http://127.0.0.1:4820/api/hooks/post-tool-use",
      "timeout": 5000
    }],
    "Stop": [{
      "type": "http",
      "url": "http://127.0.0.1:4820/api/hooks/stop",
      "timeout": 5000
    }],
    "TaskCompleted": [{
      "type": "http",
      "url": "http://127.0.0.1:4820/api/hooks/task-completed",
      "timeout": 5000
    }],
    "SessionStart": [{
      "type": "http",
      "url": "http://127.0.0.1:4820/api/hooks/session-start",
      "timeout": 5000
    }]
  }
}
```

### What Hooks Enable

| Hook Event | Foreman Action |
|------------|---------------|
| `PreToolUse` | Policy enforcement — deny destructive commands, protected path writes |
| `PostToolUse` | Telemetry — track tool usage patterns, error rates |
| `Stop` | Learning — extract patterns from tool history |
| `TaskCompleted` | Learning — feed session results to KnowledgeStore |
| `SessionStart` | Tracking — register session in Foreman's event system |

### Hook Endpoints

```
POST /api/hooks/:event       → Process hook event, return decision
GET  /api/hooks/sessions     → List active hook sessions
GET  /api/hooks/sessions/:id → Hook session detail with tool history
```

### Comparison: CLI Adapter vs Hooks

| | CLI Adapter (`--runtime claude-code`) | Hooks (`--hooks`) |
|---|---|---|
| Who starts Claude? | Foreman spawns it | User runs Claude Code directly |
| Integration depth | Subprocess with streaming JSON | HTTP callbacks per event |
| Use case | Automated pipelines, autopilot | Interactive development |
| Policy enforcement | Pre-built prompt instructions | Live PreToolUse deny/allow |
| Learning capture | Post-hoc from session results | Real-time from every tool call |

---

## Multi-Agent Orchestration

Complex tasks can be decomposed into a DAG of subtasks executed by multiple agents in parallel.

### Enable

```bash
foreman --decompose "Implement full authentication system"
```

Or in config:

```toml
[foreman]
decompose = true
decompose_threshold = 7    # Complexity score to trigger decomposition
```

### Decomposition Patterns

The `TaskDecomposer` uses heuristic patterns or LLM-powered analysis:

#### Feature Implementation
```
plan (architect) → implement (coder) → test (coder) → verify (fast)
```

#### Refactoring
```
analyze (architect) → refactor (coder) → fix_tests (coder)
```

#### Bug Fix
```
diagnose (coder) → fix (coder) → verify (fast)
```

#### Generic
```
plan (architect) → execute (coder) → verify (fast)
```

### Task Graph

The `TaskGraph` models subtask dependencies as a DAG:

```typescript
import { TaskGraph, TaskDecomposer, MultiAgentExecutor } from "foreman";

const graph = new TaskGraph();
graph.addTask({ id: "a", title: "Step A", dependsOn: [], status: "pending", description: "..." });
graph.addTask({ id: "b", title: "Step B", dependsOn: ["a"], status: "pending", description: "..." });
graph.addTask({ id: "c", title: "Step C", dependsOn: ["a"], status: "pending", description: "..." });
graph.addTask({ id: "d", title: "Step D", dependsOn: ["b", "c"], status: "pending", description: "..." });

// Get parallel execution batches:
// Batch 0: [a]     (no deps)
// Batch 1: [b, c]  (both depend on a, run in parallel)
// Batch 2: [d]     (depends on b and c)
const batches = graph.getParallelBatches();
```

### Execution

The `MultiAgentExecutor` runs the graph:
- Dispatches ready subtasks up to concurrency limit
- Injects dependency context (results from completed steps) into downstream prompts
- Skips subtasks when upstream dependencies fail
- Aggregates results, files changed, and token usage

---

## Event System

All lifecycle events flow through the typed `EventBus`.

### Event Types

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
  // Providers
  | { type: "provider:health_changed"; providerName: string; health: ProviderHealth }
  // Tasks
  | { type: "task:queued"; task: AgentTask }
  | { type: "task:assigned"; task: AgentTask; modelKey: string }
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
  | { type: "autopilot:run_completed"; run: AutopilotRun }
```

### Subscribing

```typescript
const bus = orchestrator.getEventBus();

// Specific event type
bus.on("agent:completed", (event) => {
  console.log(`Task done: ${event.session.task.title}`);
});

// All events
bus.onAny((event) => {
  console.log(event.type);
});

// Wait for an event (Promise-based)
const event = await bus.waitFor("agent:completed", 30000);
```

---

## Programmatic Usage

Use Foreman as a library in your own applications:

```typescript
import { Orchestrator, loadConfig } from "foreman";

const config = await loadConfig("./foreman.toml");
const orchestrator = new Orchestrator(config);

await orchestrator.initialize();
orchestrator.start();

// Enqueue a task
orchestrator.enqueueTask({
  id: "task_1",
  title: "Fix the login bug",
  description: "Users can't log in with special characters in password",
  labels: ["bug", "auth"],
});

// Listen for completion
orchestrator.getEventBus().on("agent:completed", (event) => {
  console.log("Done:", event.session.task.title);
  console.log("Tokens:", event.session.tokenUsage);
});

// Access subsystems
const knowledge = orchestrator.getKnowledgeStore();
const skills = orchestrator.getSkillsRegistry();
const events = orchestrator.getEvents();
const sessions = orchestrator.getSessions();

// Graceful shutdown
await orchestrator.stop();
```

### Using Individual Components

```typescript
import {
  ProviderRegistry,
  ModelRouter,
  AgentLoop,
  PolicyEngine,
  EventBus,
  KnowledgeStore,
  TaskGraph,
  TaskDecomposer,
  HookHandler,
} from "foreman";
```

---

## Testing

374 tests across 22 test suites.

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Run specific suite
npx vitest run tests/hooks.test.ts
```

### Test Coverage by Module

| Module | Tests | Coverage |
|--------|-------|----------|
| API server & handlers | 49 | Routes, auth, CORS, rate limiting, WebSocket |
| Autopilot engine | 15 | Scanning, dedup, ticket creation, scheduling |
| Cache | 8 | Tool result caching, invalidation |
| Claude Code adapter | 14 | CLI spawning, streaming JSON, event mapping |
| CLI | 8 | Arg parsing, config loading, flags |
| Config | 12 | TOML parsing, env vars, normalization |
| Context management | 10 | Token counting, summarization |
| Events | 20 | EventBus, subscriptions, history, pause/resume |
| Git tools | 11 | Status, diff, commit, branch |
| Hooks | 38 | PreToolUse, PostToolUse, lifecycle, config gen |
| Integrations | 10 | GitHub, Slack clients and watchers |
| Learning | 48 | KnowledgeStore, AgentsMd, SkillsRegistry |
| Orchestration | 39 | TaskGraph, decomposer, parallel batches |
| Policy | 20 | Protected paths, blocked commands, diff limits |
| Recovery | 12 | Loop detection, stall recovery |
| Retry | 8 | Exponential backoff |
| Router | 25 | Complexity scoring, routing strategies |
| Sandbox | 6 | Docker, local, cloud |
| Secrets | 5 | Encryption, env injection |
| Sessions | 10 | Persistence, restore |
| Tools | 6 | Execution, safety checks |
