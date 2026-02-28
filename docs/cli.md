# CLI Reference

```
foreman [OPTIONS] [TASK]
```

Bare arguments (not starting with `-`) are concatenated as the task title.

## Options

### Task Execution

| Flag | Argument | Description |
|------|----------|-------------|
| `-t, --task` | `<title>` | Task title. Alternative to bare arguments. |
| `-d, --description` | `<text>` | Task description. Defaults to the task title. |
| `-m, --model` | `<role>` | Force a specific model role (e.g., `"architect"`, `"coder"`, `"fast"`). |
| `--dir` | `<path>` | Working directory for the agent. Defaults to current directory. |
| `--runtime` | `<type>` | Agent runtime: `"foreman"` (default) or `"claude-code"`. |
| `--decompose` | | Auto-decompose complex tasks into subtask DAGs. |

### Configuration

| Flag | Argument | Description |
|------|----------|-------------|
| `-c, --config` | `<path>` | Path to `foreman.toml` config file. |

### Display

| Flag | Description |
|------|-------------|
| `--no-tui` | Run without the terminal UI. Events are logged to stdout. |

### Modes

| Flag | Description |
|------|-------------|
| `-w, --watch` | Watch integrations (GitHub, Linear, Slack) for new tasks. Runs continuously. |
| `--autopilot` | Start autopilot mode with cron-scheduled scanning. Runs continuously. |
| `--autopilot-once` | Run one autopilot scan immediately, then exit. |

### API Server

| Flag | Argument | Description |
|------|----------|-------------|
| `--api` | | Enable HTTP API server. |
| `--api-port` | `<port>` | API server port. Default: 4820. |

### Claude Code Hooks

| Flag | Description |
|------|-------------|
| `--hooks` | Enable Claude Code hooks server. Implies `--api`. |
| `--hooks-setup` | Write hooks config to `.claude/settings.json` and exit. |
| `--hooks-print` | Print hooks config to stdout and exit. |

### Help

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help message and exit. |

## Examples

### Single Task

```bash
# Bare argument
foreman "Fix the login bug"

# With flags
foreman --task "Add dark mode" --description "Add toggle in settings" --model architect

# Specific directory
foreman --dir /path/to/project "Run the linter and fix issues"

# No TUI (for CI/scripts)
foreman --no-tui "Update the README"
```

### Task Decomposition

```bash
# Auto-decompose into subtasks
foreman --decompose "Implement full authentication with JWT and OAuth"
```

The decomposer analyzes the task and creates a DAG of subtasks:
- `plan` (architect) → `implement` (coder) → `test` (coder) → `verify` (fast)

### Claude Code Runtime

```bash
# Use Claude Code CLI instead of built-in agent loop
foreman --runtime claude-code "Fix the bug"
```

### Watch Mode

```bash
# Watch all configured integrations
foreman --watch

# Watch with API server
foreman --watch --api --api-port 4820
```

### Autopilot

```bash
# Single scan, no TUI, exit when done
foreman --autopilot-once --no-tui

# Continuous with cron schedule
foreman --autopilot

# Autopilot + watch (scan AND handle incoming tasks)
foreman --autopilot --watch
```

### API & Hooks

```bash
# API server only
foreman --api --api-port 8080

# Claude Code hooks server
foreman --hooks --api

# Configure Claude Code, then start server
foreman --hooks-setup
foreman --hooks --api

# Print hooks config without writing
foreman --hooks-print
```

### Combined

```bash
# Everything: watch, autopilot, API, decomposition
foreman --watch --autopilot --api --decompose
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success. All tasks completed. |
| `1` | Failure. A task failed, config error, or autopilot scan failed. |

## Signal Handling

- `SIGINT` (Ctrl+C): Graceful shutdown — stops watchers, aborts agents, saves sessions, releases sandboxes.
- `SIGTERM`: Same as SIGINT.
