# Claude Code Hooks

Foreman can run as a **sidecar** to Claude Code, providing policy enforcement, telemetry, and learning without replacing Claude Code's native capabilities.

## Concept

```
┌─────────────────────┐          ┌──────────────────────┐
│    Claude Code       │          │    Foreman Sidecar   │
│    (interactive)     │   HTTP   │                      │
│                      │◄────────►│  Policy Engine       │
│  User ↔ Claude Code  │  hooks   │  Knowledge Store     │
│                      │          │  Session Tracking    │
│  Native tools:       │          │  Learning            │
│  • Read, Write, Edit │          │  Telemetry           │
│  • Bash, Glob, Grep  │          │                      │
└─────────────────────┘          └──────────────────────┘
```

**Two integration modes**:

| Mode | How | Best For |
|------|-----|----------|
| **CLI Adapter** | Foreman spawns Claude Code as a subprocess | Automated pipelines, CI |
| **Hooks Sidecar** | Claude Code calls Foreman via HTTP hooks | Interactive development |

This page covers the **Hooks Sidecar** mode.

## How It Works

Claude Code supports [HTTP hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — configurable HTTP endpoints called at lifecycle events. Foreman registers as a hook handler and receives events for every tool call, session start, and task completion.

### Event Flow

```
User gives Claude Code a task
        │
        ▼
┌───────────────────┐
│ SessionStart       │───→ Foreman registers session
└────────┬──────────┘
         │
         ▼
┌───────────────────┐     ┌──────────────────────┐
│ PreToolUse         │────→│ Foreman PolicyEngine │
│ (before tool runs) │     │ evaluate(tool, input) │
│                    │←────│ → allow / deny        │
└────────┬──────────┘     └──────────────────────┘
         │ (if allowed)
         ▼
┌───────────────────┐
│ Tool executes      │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐     ┌──────────────────────┐
│ PostToolUse        │────→│ Foreman tracks:      │
│ (after tool runs)  │     │ • Tool history        │
│                    │     │ • Token usage         │
└────────┬──────────┘     │ • File changes        │
         │                └──────────────────────┘
         ▼
   (repeat for each tool call)
         │
         ▼
┌───────────────────┐     ┌──────────────────────┐
│ Stop               │────→│ Foreman analyzes:    │
│ (agent stopping)   │     │ • Tool patterns       │
│                    │     │ • Error rates         │
└────────┬──────────┘     │ • Learning signals    │
         │                └──────────────────────┘
         ▼
┌───────────────────┐     ┌──────────────────────┐
│ TaskCompleted      │────→│ Foreman:             │
│ (session done)     │     │ • learnFromSession()  │
│                    │     │ • Store knowledge     │
└───────────────────┘     │ • Clean up session    │
                          └──────────────────────┘
```

## Setup

### Quick Setup

```bash
# Write hooks config to .claude/settings.json and exit
foreman --hooks-setup

# Start the hooks server
foreman --hooks --api
```

### Manual Setup

```bash
# Print hooks config to stdout (inspect before applying)
foreman --hooks-print

# Start server on custom port
foreman --hooks --api --api-port 8080
```

### What `--hooks-setup` Does

Writes to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "http",
        "url": "http://localhost:4820/api/hooks/pre-tool-use",
        "headers": {}
      }
    ],
    "PostToolUse": [
      {
        "type": "http",
        "url": "http://localhost:4820/api/hooks/post-tool-use",
        "headers": {}
      }
    ],
    "Stop": [
      {
        "type": "http",
        "url": "http://localhost:4820/api/hooks/stop",
        "headers": {}
      }
    ],
    "TaskCompleted": [
      {
        "type": "http",
        "url": "http://localhost:4820/api/hooks/task-completed",
        "headers": {}
      }
    ],
    "SessionStart": [
      {
        "type": "http",
        "url": "http://localhost:4820/api/hooks/session-start",
        "headers": {}
      }
    ]
  }
}
```

If `.claude/settings.json` already exists, the hooks config is **merged** (not overwritten).

### With API Key

```bash
foreman --hooks-setup  # reads from [api] config or FOREMAN_API_KEY env
```

When an API key is configured, hook requests include the header:

```
Authorization: Bearer <api_key>
```

## Hook Events

### `PreToolUse`

Fired **before** Claude Code executes a tool.

**Inbound payload**:
```json
{
  "sessionId": "session-abc123",
  "tool": "Bash",
  "input": {
    "command": "rm -rf node_modules"
  }
}
```

**Response** (allow):
```json
{ "decision": "allow" }
```

**Response** (deny):
```json
{
  "decision": "deny",
  "message": "Blocked command pattern: rm -rf"
}
```

**Tool name mapping**: Claude Code uses different tool names than Foreman. The handler maps them:

| Claude Code | Foreman | Category |
|-------------|---------|----------|
| `Bash` | `run_command` | Command execution |
| `Write` | `write_file` | File creation |
| `Edit` | `edit_file` | File modification |
| `Read` | `read_file` | File reading |
| `Glob` | `list_files` | File listing |
| `Grep` | `search_codebase` | Code search |

**Policy behavior in hooks mode**: Since there's no interactive approval flow in hooks, `require_approval` decisions are mapped to `deny`. The denial message explains why.

---

### `PostToolUse`

Fired **after** a tool executes.

**Inbound payload**:
```json
{
  "sessionId": "session-abc123",
  "tool": "Write",
  "input": {
    "file_path": "/project/src/app.ts",
    "content": "..."
  },
  "output": "File written successfully"
}
```

**Response**: `{ "decision": "allow" }` (always; post-hoc tracking only)

**What Foreman tracks**:
- Tool call history per session
- Files modified
- Token usage patterns
- Error occurrences

---

### `SessionStart`

Fired when a new Claude Code session begins.

**Inbound payload**:
```json
{
  "sessionId": "session-abc123"
}
```

**Response**: `{ "decision": "allow" }`

**What Foreman does**: Registers the session for tracking.

---

### `Stop`

Fired when the agent is about to stop (before final output).

**Inbound payload**:
```json
{
  "sessionId": "session-abc123",
  "reason": "task_complete"
}
```

**Response**: `{ "decision": "allow" }`

**What Foreman does**: Analyzes tool history for learning signals:
- Detects excessive tool usage patterns (>50 calls → lesson about approach)
- Detects high error rates (>30% → lesson about reliability)

---

### `TaskCompleted`

Fired when the task is fully complete.

**Inbound payload**:
```json
{
  "sessionId": "session-abc123",
  "result": "Fixed the login bug by..."
}
```

**Response**: `{ "decision": "allow" }`

**What Foreman does**:
1. Calls `KnowledgeStore.learnFromSession()` with the tool history
2. Stores lessons extracted from the session
3. Cleans up session state

---

### `Notification`

General notifications from Claude Code.

**Inbound payload**:
```json
{
  "sessionId": "session-abc123",
  "message": "Agent is thinking..."
}
```

**Response**: `{ "decision": "allow" }`

**What Foreman does**: Logs the notification.

## API Endpoints

When hooks are enabled, these endpoints are added to the API server:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/hooks/pre-tool-use` | PreToolUse hook handler |
| `POST` | `/api/hooks/post-tool-use` | PostToolUse hook handler |
| `POST` | `/api/hooks/stop` | Stop hook handler |
| `POST` | `/api/hooks/task-completed` | TaskCompleted hook handler |
| `POST` | `/api/hooks/session-start` | SessionStart hook handler |
| `POST` | `/api/hooks/notification` | Notification hook handler |
| `GET` | `/api/hooks/sessions` | List active hook sessions |
| `GET` | `/api/hooks/sessions/:id` | Get hook session details |

### Session Details

```
GET /api/hooks/sessions/session-abc123
```

```json
{
  "sessionId": "session-abc123",
  "startedAt": "2025-01-15T10:00:00Z",
  "toolHistory": [
    { "tool": "Read", "timestamp": "...", "hadError": false },
    { "tool": "Edit", "timestamp": "...", "hadError": false },
    { "tool": "Bash", "timestamp": "...", "hadError": false }
  ],
  "tokenUsage": { "input": 15000, "output": 3000 },
  "filesModified": ["src/app.ts"]
}
```

## Combining Modes

You can run hooks alongside other Foreman modes:

```bash
# Hooks + Watch mode (policy for interactive + automated tasks)
foreman --hooks --watch --api

# Hooks + Autopilot
foreman --hooks --autopilot --api

# Everything
foreman --hooks --watch --autopilot --api --decompose
```

## Comparison: CLI Adapter vs Hooks

| Aspect | CLI Adapter | Hooks Sidecar |
|--------|-------------|---------------|
| **Trigger** | Foreman spawns Claude Code | User runs Claude Code normally |
| **Control** | Foreman controls lifecycle | Claude Code controls lifecycle |
| **Policy** | Evaluated inline | Evaluated via HTTP |
| **Tools** | Claude Code's native tools | Claude Code's native tools |
| **Learning** | Post-session | Real-time per tool call |
| **Approval** | Not available | Deny only (no interactive) |
| **Use case** | CI, automation | Developer workflow |
