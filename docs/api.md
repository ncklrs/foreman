# HTTP API & WebSocket

Foreman exposes a REST API and WebSocket server for programmatic control, monitoring, and integration.

## Configuration

```toml
[api]
enabled = true
port = 4820
host = "127.0.0.1"
api_key = "${FOREMAN_API_KEY}"
cors_origins = ["http://localhost:3000"]
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Start API server on boot. |
| `port` | number | `4820` | Listen port. |
| `host` | string | `"127.0.0.1"` | Bind address. Use `"0.0.0.0"` for network access. |
| `api_key` | string | None | API key for authentication. If unset, auth is disabled. |
| `cors_origins` | string[] | `["*"]` | Allowed CORS origins. |

## Starting the Server

```bash
# Via CLI flags
foreman --api --api-port 4820

# With other modes
foreman --watch --api
foreman --autopilot --api --api-port 8080
```

Or via config:

```toml
[api]
enabled = true
port = 4820
```

## Authentication

If `api_key` is configured, all requests must include:

```
Authorization: Bearer <api_key>
```

Unauthenticated requests receive `401 Unauthorized`.

## Rate Limiting

Built-in sliding window rate limiter:
- **100 requests per minute** per client IP
- Returns `429 Too Many Requests` when exceeded

## REST Endpoints

### Health & Status

#### `GET /api/health`

Health check endpoint.

**Response** `200`:
```json
{
  "status": "ok",
  "uptime": 3600,
  "version": "1.0.0"
}
```

---

#### `GET /api/providers`

List all configured model providers with health status.

**Response** `200`:
```json
{
  "providers": {
    "architect": {
      "name": "anthropic",
      "model": "claude-opus-4-6",
      "healthy": true,
      "latencyMs": 245
    },
    "coder": {
      "name": "anthropic",
      "model": "claude-sonnet-4-5-20250929",
      "healthy": true,
      "latencyMs": 180
    }
  }
}
```

---

### Sessions

#### `GET /api/sessions`

List all agent sessions.

**Response** `200`:
```json
{
  "sessions": [
    {
      "id": "session-abc123",
      "taskId": "task-1",
      "status": "completed",
      "iterations": 15,
      "tokenUsage": { "input": 50000, "output": 12000, "total": 62000 },
      "filesChanged": ["src/app.ts", "src/utils.ts"],
      "startedAt": "2025-01-15T10:00:00Z",
      "completedAt": "2025-01-15T10:05:30Z",
      "durationMs": 330000
    }
  ]
}
```

---

#### `GET /api/sessions/:id`

Get detailed session information.

**Response** `200`:
```json
{
  "session": {
    "id": "session-abc123",
    "taskId": "task-1",
    "status": "completed",
    "iterations": 15,
    "tokenUsage": { "input": 50000, "output": 12000, "total": 62000 },
    "toolCalls": [
      {
        "tool": "read_file",
        "input": { "path": "src/app.ts" },
        "output": "...",
        "durationMs": 5
      }
    ],
    "filesChanged": ["src/app.ts"],
    "result": "Fixed the login bug by...",
    "startedAt": "2025-01-15T10:00:00Z",
    "completedAt": "2025-01-15T10:05:30Z",
    "durationMs": 330000
  }
}
```

**Response** `404`:
```json
{ "error": "Session not found" }
```

---

### Tasks

#### `POST /api/tasks`

Submit a new task for execution.

**Request**:
```json
{
  "title": "Fix the login bug",
  "description": "Users can't log in when using email with + characters",
  "labels": ["bug", "auth"],
  "model": "coder"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Task title. |
| `description` | string | No | Detailed description. Defaults to title. |
| `labels` | string[] | No | Task labels for routing and matching. |
| `model` | string | No | Force a specific model key. |

**Response** `201`:
```json
{
  "taskId": "task-abc123",
  "status": "queued"
}
```

---

### Events

#### `GET /api/events`

Get recent event history.

**Query parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter by event type |
| `limit` | number | Max events to return (default: 100) |
| `since` | string | ISO timestamp — events after this time |

**Response** `200`:
```json
{
  "events": [
    {
      "type": "task:started",
      "timestamp": "2025-01-15T10:00:00Z",
      "data": {
        "taskId": "task-1",
        "title": "Fix login bug",
        "modelKey": "coder"
      }
    },
    {
      "type": "agent:tool_called",
      "timestamp": "2025-01-15T10:00:05Z",
      "data": {
        "sessionId": "session-abc123",
        "tool": "read_file",
        "durationMs": 5
      }
    }
  ]
}
```

---

### Knowledge

#### `GET /api/knowledge`

Get all stored lessons and failure patterns.

**Response** `200`:
```json
{
  "lessons": [
    {
      "id": "lesson-abc",
      "text": "Use vitest for testing",
      "category": "convention",
      "confidence": 0.85,
      "usedCount": 5
    }
  ],
  "failures": [
    {
      "id": "fail-def",
      "taskTitle": "Deploy",
      "error": "Missing DEPLOY_KEY",
      "modelKey": "coder"
    }
  ]
}
```

---

#### `POST /api/knowledge/learn`

Submit a manual lesson.

**Request**:
```json
{
  "text": "Always run prettier before committing",
  "category": "preference"
}
```

**Response** `201`:
```json
{ "status": "learned" }
```

---

### Skills

#### `GET /api/skills`

List all registered skills.

**Response** `200`:
```json
{
  "skills": [
    {
      "name": "code-review",
      "description": "Systematic code review",
      "triggers": ["review", "audit"],
      "tags": ["quality"],
      "source": "builtin"
    }
  ]
}
```

---

### Autopilot

#### `GET /api/autopilot/runs`

Get autopilot run history.

**Response** `200`:
```json
{
  "runs": [
    {
      "id": "run-abc",
      "startedAt": "2025-01-15T09:00:00Z",
      "completedAt": "2025-01-15T09:05:00Z",
      "findingsCount": 3,
      "ticketsCreated": 2,
      "resolvedCount": 1
    }
  ]
}
```

---

#### `POST /api/autopilot/trigger`

Trigger an immediate autopilot scan.

**Response** `202`:
```json
{ "status": "triggered", "runId": "run-xyz" }
```

---

### Metrics

#### `GET /api/metrics`

Prometheus-compatible metrics endpoint.

**Response** `200` (text/plain):
```
# HELP foreman_tasks_total Total tasks processed
# TYPE foreman_tasks_total counter
foreman_tasks_total{status="completed"} 42
foreman_tasks_total{status="failed"} 3

# HELP foreman_agent_iterations_total Total agent loop iterations
# TYPE foreman_agent_iterations_total counter
foreman_agent_iterations_total 1250

# HELP foreman_tokens_total Total tokens used
# TYPE foreman_tokens_total counter
foreman_tokens_total{direction="input"} 5000000
foreman_tokens_total{direction="output"} 1200000

# HELP foreman_active_sessions Current active agent sessions
# TYPE foreman_active_sessions gauge
foreman_active_sessions 2
```

---

### Configuration

#### `GET /api/config`

Get current configuration (sensitive values redacted).

**Response** `200`:
```json
{
  "foreman": {
    "name": "my-foreman",
    "runtime": "foreman",
    "maxConcurrentAgents": 3
  },
  "models": {
    "coder": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5-20250929",
      "apiKey": "***REDACTED***"
    }
  },
  "routing": {
    "strategy": "capability_match",
    "fallbackChain": ["coder", "architect"]
  }
}
```

---

## WebSocket

Real-time event streaming via WebSocket.

### Connection

```
ws://localhost:4820/ws
```

If authentication is enabled:
```
ws://localhost:4820/ws?token=<api_key>
```

### Protocol

The WebSocket implements RFC 6455 with:
- Automatic ping/pong keepalive (every 30s)
- Connection timeout after 60s of no pong
- JSON message framing

### Subscribing to Events

After connecting, send a subscription message:

```json
{
  "type": "subscribe",
  "events": ["task:*", "agent:*"]
}
```

**Wildcard patterns**:
- `"*"` — All events
- `"task:*"` — All task events
- `"agent:*"` — All agent events
- `"autopilot:*"` — All autopilot events

### Receiving Events

Events are streamed as JSON:

```json
{
  "type": "task:started",
  "timestamp": "2025-01-15T10:00:00Z",
  "data": {
    "taskId": "task-1",
    "title": "Fix login bug"
  }
}
```

### Client Example

```javascript
const ws = new WebSocket("ws://localhost:4820/ws?token=my-api-key");

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "subscribe",
    events: ["*"]
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data.data);
};
```

### Server Implementation

The WebSocket server is zero-dependency, built on Node's `http` module:

- Manual WebSocket handshake (SHA-1 key exchange)
- Frame parsing and construction (RFC 6455)
- Per-client subscription filters
- Broadcast to all matching clients
- Graceful connection cleanup

## Middleware

### CORS

Configured via `cors_origins`:

```toml
[api]
cors_origins = ["http://localhost:3000", "https://dashboard.example.com"]
```

Responds to preflight `OPTIONS` requests with appropriate headers.

### Rate Limiting

Sliding window rate limiter (in-memory):
- Window: 60 seconds
- Limit: 100 requests per IP
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  API Server                       │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │            HTTP Router                    │   │
│  │  "GET /api/health"    → healthHandler    │   │
│  │  "GET /api/sessions"  → sessionsHandler  │   │
│  │  "POST /api/tasks"    → createTask       │   │
│  │  "GET /api/events"    → eventsHandler    │   │
│  │  ...                                     │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────┐     │
│  │  Middleware   │  │  WebSocket Server    │     │
│  │              │  │                      │     │
│  │  Auth        │  │  Client management   │     │
│  │  CORS        │  │  Event broadcasting  │     │
│  │  Rate limit  │  │  Subscription filter │     │
│  └──────────────┘  └──────────────────────┘     │
│                                                  │
│  Built on Node.js http module (zero dependencies)│
└──────────────────────────────────────────────────┘
```
