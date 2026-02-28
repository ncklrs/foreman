# Getting Started

## Installation

```bash
git clone <repo-url>
cd foreman
npm install
npm run build
```

**Requirements:** Node.js >= 20.0.0

After building, the `foreman` binary is at `dist/cli.js`. Use `npm link` to add it to your PATH.

## First Run

The simplest way to use Foreman is to give it a task:

```bash
foreman "Fix the login bug in src/auth.ts"
```

Without a config file, Foreman uses sensible defaults:
- Anthropic provider with `claude-sonnet-4-5-20250929`
- Local sandbox (no Docker)
- Standard policy (protects `package.json`, `.env`)
- Capability-based routing

## Setting Up a Config File

Create `foreman.toml` in your project root:

```toml
[foreman]
name = "my-project"
log_level = "info"
max_concurrent_agents = 2

[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
role = "code generation"
max_tokens = 4096

[routing]
strategy = "capability_match"
fallback_chain = ["coder"]

[sandbox]
type = "local"
warm_pool = 1
timeout_minutes = 30
cleanup = "on_success"

[policy]
protected_paths = ["package.json", ".env"]
blocked_commands = ["rm -rf /"]
max_diff_lines = 500
require_approval_above = 200
```

See [Configuration Reference](configuration.md) for all options.

## Environment Variables

Set your API keys:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export GITHUB_TOKEN="ghp_..."         # Optional: for GitHub integration
export LINEAR_API_KEY="lin_..."       # Optional: for Linear integration
export SLACK_BOT_TOKEN="xoxb-..."     # Optional: for Slack integration
```

## Usage Modes

### Single Task

Execute one task and exit:

```bash
foreman "Add input validation to the signup form"
foreman --task "Refactor auth module" --model architect
foreman --task "Fix bug #42" --description "Users see a blank page after login"
```

### Watch Mode

Continuously watch for tasks from GitHub, Linear, or Slack:

```bash
foreman --watch
```

Requires at least one integration configured in `foreman.toml`.

### Autopilot Mode

Run scheduled codebase scans:

```bash
# Single scan
foreman --autopilot-once --no-tui

# Continuous (cron-scheduled)
foreman --autopilot
```

### API Server

Expose Foreman as an HTTP API:

```bash
foreman --api --api-port 4820
```

Then submit tasks via REST:

```bash
curl -X POST http://localhost:4820/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Fix the bug", "labels": ["bug"]}'
```

### Claude Code Sidecar

Use Foreman as a policy/learning sidecar for Claude Code:

```bash
# Configure Claude Code to POST hooks to Foreman
foreman --hooks-setup

# Start the hooks server
foreman --hooks --api
```

Now run Claude Code normally — every tool call flows through Foreman for policy enforcement and learning.

### Multi-Agent Decomposition

Break complex tasks into parallel subtasks:

```bash
foreman --decompose "Implement full authentication with JWT, sessions, and OAuth"
```

## Terminal UI

By default, Foreman renders a terminal UI (TUI) using React and Ink. Disable it for CI/headless environments:

```bash
foreman --no-tui "Fix the bug"
```

In `--no-tui` mode, events are logged to stdout.

## What Happens When You Run a Task

```
1. Config loaded (foreman.toml or defaults)
2. Orchestrator initializes providers, sandbox, learning system
3. Task enqueued → complexity scored → model selected
4. Sandbox acquired (Docker or local)
5. System prompt built with:
   - Task context
   - Codebase structure
   - AGENTS.md conventions
   - Lessons from past sessions
   - Matched skills
   - Policy constraints
6. Agent loop executes:
   - Send prompt to LLM
   - Parse tool calls from response
   - Execute tools (read, write, edit, run, git)
   - Feed results back to LLM
   - Repeat until task_done or max iterations
7. Results collected:
   - Session saved to disk
   - Knowledge store updated
   - Integrations notified (GitHub, Linear, Slack)
   - Performance metrics recorded
8. Sandbox released, cleanup per policy
```

## Next Steps

- [Configuration Reference](configuration.md) — Fine-tune every aspect
- [Architecture Overview](architecture.md) — Understand the internals
- [Tools](tools.md) — See what agents can do
- [Integrations](integrations.md) — Connect to GitHub, Linear, Slack
