# Configuration Reference

Foreman is configured via TOML files. All settings, their types, defaults, and behaviors are documented here.

## Config File Location

Searched in order:

1. `./foreman.toml`
2. `./.foreman.toml`
3. `~/.config/foreman/foreman.toml`

Override with `--config <path>`.

## Environment Variable Substitution

Any string value can reference environment variables:

```toml
api_key = "${LINEAR_API_KEY}"
```

If the variable is unset, the literal `${VAR}` remains (no error).

---

## `[foreman]` — Global Settings

```toml
[foreman]
name = "my-foreman"
log_level = "info"
max_concurrent_agents = 3
runtime = "foreman"
decompose = false
decompose_threshold = 7
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | `"foreman"` | Instance name. Appears in logs and event payloads. |
| `log_level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Minimum log level. |
| `max_concurrent_agents` | number | `1` | Maximum parallel agent sessions. |
| `runtime` | `"foreman"` \| `"claude-code"` | `"foreman"` | Agent runtime. `"foreman"` uses the built-in AgentLoop. `"claude-code"` spawns the Claude Code CLI. |
| `decompose` | boolean | `false` | Auto-decompose complex tasks into subtask DAGs. |
| `decompose_threshold` | number | `7` | Minimum complexity score (1-10) to trigger decomposition. |

---

## `[models.<name>]` — Model Definitions

Define one or more models. The `<name>` becomes the model key used for routing.

```toml
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
role = "classification, simple transforms"
max_tokens = 1024

[models.local]
provider = "local"
model = "qwen3:32b"
endpoint = "http://localhost:11434"
role = "code review"
max_tokens = 2048

[models.gpt]
provider = "openai"
model = "gpt-4o"
role = "alternative implementation"
max_tokens = 4096
api_key = "${OPENAI_API_KEY}"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `"anthropic"` \| `"openai"` \| `"local"` | Yes | LLM provider type. |
| `model` | string | Yes | Model identifier (e.g., `"claude-sonnet-4-5-20250929"`). |
| `role` | string | Yes | Human-readable description of what this model is used for. |
| `max_tokens` | number | Yes | Maximum output tokens per request. |
| `temperature` | number | No | Sampling temperature (0.0-1.0). |
| `endpoint` | string | No | Custom API endpoint URL. Required for `"local"` provider. |
| `api_key` | string | No | Per-model API key override. Falls back to env vars. |

### Conventional Model Keys

The router recognizes these role-based keys:

| Key | Used For |
|-----|----------|
| `architect` | High-complexity tasks (score 8+), planning, task decomposition |
| `coder` | Medium-complexity tasks (score 4-7), implementation |
| `fast` | Low-complexity tasks (score 1-3), summarization, classification |
| `reviewer` | Code review in autopilot mode |

You can use any key name — these are conventions the router understands.

---

## `[routing]` — Model Selection

```toml
[routing]
strategy = "capability_match"
fallback_chain = ["coder", "architect", "fast"]
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strategy` | `"capability_match"` \| `"cost_optimized"` \| `"speed_first"` | `"capability_match"` | How to select models for tasks. |
| `fallback_chain` | string[] | `["coder"]` | Ordered list of model keys to try if primary selection fails. |

See [Routing](routing.md) for strategy details.

---

## `[sandbox]` — Execution Environments

```toml
[sandbox]
type = "docker"
warm_pool = 3
timeout_minutes = 30
cleanup = "on_success"
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"docker"` \| `"local"` | `"local"` | Sandbox type. Docker provides full isolation. |
| `warm_pool` | number | `1` | Number of pre-warmed containers to keep ready. |
| `timeout_minutes` | number | `30` | Maximum time before a sandbox is force-killed. |
| `cleanup` | `"on_success"` \| `"always"` \| `"never"` | `"on_success"` | When to destroy sandbox after use. |

### `[sandbox.cloud]` — Cloud Sandboxes

```toml
[sandbox.cloud]
provider = "fly"
app = "foreman-sandboxes"
region = "iad"
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `"fly"` \| `"daytona"` | Cloud sandbox provider. |
| `app` | string | Application name on the provider. |
| `region` | string | Deployment region. |

---

## `[policy]` — Safety Rules

```toml
[policy]
protected_paths = ["package.json", ".env", ".env.*", ".github/*"]
blocked_commands = ["rm -rf /", "curl | sh"]
max_diff_lines = 500
require_approval_above = 200
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `protected_paths` | string[] | `[]` | Glob patterns for files that require approval to write. |
| `blocked_commands` | string[] | `[]` | Command substrings that are always denied. |
| `max_diff_lines` | number | `500` | Hard limit — deny if cumulative diff exceeds this. |
| `require_approval_above` | number | `200` | Approval threshold — require approval if cumulative diff exceeds this. |

See [Policy Engine](policy.md) for built-in dangerous patterns.

---

## `[linear]` — Linear Integration

```toml
[linear]
api_key = "${LINEAR_API_KEY}"
team = "ENG"
watch_labels = ["agent-ready"]
watch_status = "Todo"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `api_key` | string | Yes | Linear API key. |
| `team` | string | Yes | Team identifier (e.g., `"ENG"`). |
| `watch_labels` | string[] | Yes | Labels to watch for new tasks. |
| `watch_status` | string | Yes | Workflow status to filter (e.g., `"Todo"`). |

---

## `[github]` — GitHub Integration

```toml
[github]
token = "${GITHUB_TOKEN}"
owner = "your-org"
repo = "your-repo"
watch_labels = ["agent-ready"]
watch_state = "open"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | Yes | GitHub personal access token or app token. |
| `owner` | string | Yes | Repository owner (user or org). |
| `repo` | string | Yes | Repository name. |
| `watch_labels` | string[] | Yes | Issue labels to watch. |
| `watch_state` | `"open"` \| `"closed"` \| `"all"` | No | Issue state filter. Default: `"open"`. |

---

## `[slack]` — Slack Integration

```toml
[slack]
bot_token = "${SLACK_BOT_TOKEN}"
watch_channels = ["#eng-agents"]
trigger_prefix = "!agent"
post_progress = true
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bot_token` | string | Yes | Slack Bot User OAuth Token. |
| `watch_channels` | string[] | Yes | Channel names to watch. |
| `trigger_prefix` | string | No | Message prefix to trigger tasks. Default: `"!agent"`. |
| `post_progress` | boolean | No | Post progress updates to thread. Default: `true`. |

---

## `[autopilot]` — Autonomous Scanning

```toml
[autopilot]
enabled = true
schedule = "0 9 * * 1-5"
timezone = "UTC"
scanners = ["security", "code_quality", "test_coverage", "dependencies"]
max_tickets_per_run = 5
auto_resolve = true
max_concurrent_resolves = 2
min_severity = 3
ticket_target = "github"
ticket_labels = ["autopilot"]
branch_prefix = "autopilot/"
working_dir = "."
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Whether autopilot is active. |
| `schedule` | string | Required | Cron expression (5-field). |
| `timezone` | string | `"UTC"` | Timezone for schedule. |
| `scanners` | string[] | Required | Which scanners to run. See below. |
| `max_tickets_per_run` | number | `5` | Cap on tickets created per scan. |
| `auto_resolve` | boolean | `false` | Spawn agents to auto-fix findings. |
| `max_concurrent_resolves` | number | `2` | Parallel auto-fix agents. |
| `min_severity` | number | `1` | Minimum severity (1-5) to create tickets. |
| `ticket_target` | `"github"` \| `"linear"` | Required | Where to create tickets. |
| `ticket_labels` | string[] | `[]` | Labels to add to created tickets. |
| `branch_prefix` | string | `"autopilot/"` | Branch name prefix for auto-fix work. |
| `working_dir` | string | `"."` | Directory to scan. |

### Scanner Types

`security`, `dependencies`, `code_quality`, `test_coverage`, `performance`, `documentation`, `dead_code`, `type_safety`

See [Autopilot](autopilot.md) for details on each scanner.

---

## `[api]` — HTTP API Server

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

---

## Minimal Config

The absolute minimum to run:

```toml
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
protected_paths = []
blocked_commands = []
max_diff_lines = 500
require_approval_above = 200
```

Or just run `foreman "task"` without any config — sensible defaults are used automatically.
