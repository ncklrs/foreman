# Tools Reference

Tools are the capabilities available to agents during task execution. Each tool has a defined schema, and calls are evaluated by the [Policy Engine](policy.md) before execution.

## Tool Categories

```
┌──────────────────────────────────────────────────┐
│                  CORE_TOOLS                       │
│                                                  │
│  File System          Git               Web      │
│  ┌──────────────┐    ┌──────────────┐  ┌──────┐ │
│  │ read_file    │    │ git_status   │  │web_  │ │
│  │ write_file   │    │ git_diff     │  │fetch │ │
│  │ edit_file    │    │ git_commit   │  └──────┘ │
│  │ run_command  │    │ git_log      │           │
│  │ search_      │    │ git_branch   │  Agent    │
│  │  codebase   │    │ create_pull_ │  ┌──────┐ │
│  │ list_files   │    │  request     │  │spawn_│ │
│  └──────────────┘    └──────────────┘  │sub-  │ │
│                                        │agent │ │
│  Completion                            └──────┘ │
│  ┌──────────────┐                               │
│  │ task_done    │                               │
│  └──────────────┘                               │
└──────────────────────────────────────────────────┘
```

## File System Tools

### `read_file`

Read the contents of a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Absolute or relative file path |
| `offset` | number | No | Start reading from this line (1-based) |
| `limit` | number | No | Maximum number of lines to read |

**Returns**: File contents with line numbers. Format: `  1 | line content`

**Policy**: Always allowed (read-only).

**Caching**: Results are cached. Cache invalidated when the file is written or edited.

---

### `write_file`

Create or overwrite a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path to write |
| `content` | string | Yes | Full file content |

**Returns**: Confirmation with character count.

**Policy**: Checked against `protected_paths`. Diff lines tracked toward `max_diff_lines` / `require_approval_above` thresholds.

**Side effects**: Creates parent directories if needed. Invalidates read cache for the file.

---

### `edit_file`

Apply a surgical string replacement to a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | File path to edit |
| `old_string` | string | Yes | Exact string to find |
| `new_string` | string | Yes | Replacement string |

**Returns**: Confirmation or error.

**Validation**:
- File must exist
- `old_string` must be found in the file
- `old_string` must be unique (no ambiguous matches)
- `old_string` and `new_string` must differ

**Policy**: Same as `write_file`.

---

### `run_command`

Execute a shell command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `timeout` | number | No | Timeout in seconds (default: 120) |

**Returns**: stdout and stderr output. Truncated at 10MB.

**Policy**: Checked against `blocked_commands` list and dangerous patterns. Commands matching `npm install`, `pip install`, etc. require approval.

**Execution**: Uses Node's `child_process.exec()` with configurable timeout. Force-kills after timeout + 5s grace period.

---

### `search_codebase`

Search file contents using regex (powered by ripgrep).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern to search for |
| `path` | string | No | Directory to search in (default: working dir) |
| `include` | string | No | Glob pattern to filter files (e.g., `"*.ts"`) |
| `max_results` | number | No | Maximum results to return (default: 50) |

**Returns**: Matching lines with file paths and line numbers.

**Policy**: Always allowed (read-only).

**Caching**: Results cached. Invalidated on any file write in the search directory.

---

### `list_files`

List files in a directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Directory path |
| `recursive` | boolean | No | Include subdirectories (default: false) |
| `pattern` | string | No | Glob pattern to filter (e.g., `"*.ts"`) |

**Returns**: File listing. Automatically filters out `node_modules/` and `.git/`.

**Policy**: Always allowed (read-only).

**Caching**: Results cached.

## Git Tools

### `git_status`

Show the working tree status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns**: Output of `git status --short`.

**Caching**: Cached. Invalidated on any file write.

---

### `git_diff`

Show staged and unstaged changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `staged` | boolean | No | Show only staged changes (default: false) |

**Returns**: Output of `git diff` or `git diff --staged`.

**Caching**: Cached. Invalidated on any file write.

---

### `git_commit`

Stage files and create a commit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Commit message |
| `files` | string[] | No | Specific files to stage (default: all changed) |

**Returns**: Commit hash and summary.

**Policy**: Requires approval if cumulative diff exceeds `require_approval_above` threshold.

---

### `git_log`

Show recent commit history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `count` | number | No | Number of commits (default: 10) |
| `oneline` | boolean | No | One-line format (default: true) |

**Returns**: Commit log output.

**Caching**: Cached. Invalidated on commit.

---

### `git_branch`

Create, list, or switch branches.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"create"` \| `"switch"` \| `"list"` | Yes | Branch operation |
| `name` | string | No | Branch name (required for create/switch) |

**Returns**: Operation result.

---

### `create_pull_request`

Push the current branch and create a pull request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | PR title |
| `body` | string | No | PR description |
| `base` | string | No | Base branch (default: `"main"`) |
| `draft` | boolean | No | Create as draft PR (default: false) |

**Returns**: PR URL and number.

**Policy**: Always requires approval (modifies remote state).

**Implementation**: Uses `gh pr create` CLI. Prevents PR creation when on the base branch.

## Web Tools

### `web_fetch`

Fetch content from a URL.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch (HTTP/HTTPS only) |
| `method` | string | No | HTTP method (default: `"GET"`) |
| `headers` | object | No | Custom request headers |
| `body` | string | No | Request body |
| `max_length` | number | No | Max response chars (default: 50,000) |

**Returns**: Response body. JSON is auto-formatted. Long responses are truncated.

**Validation**: Only `http://` and `https://` schemes allowed.

## Agent Tools

### `spawn_subagent`

Delegate a subtask to an independent child agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Subtask title |
| `description` | string | Yes | Detailed description |
| `modelRole` | string | No | Model role for the sub-agent (`"fast"`, `"coder"`, `"architect"`) |

**Returns**: Sub-agent result with summary, files changed, and token usage.

See [Agent Runtime](agent-runtime.md#sub-agent-spawning) for details.

## Completion

### `task_done`

Signal that the task is complete.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `summary` | string | Yes | Summary of what was accomplished |
| `files_changed` | string[] | No | List of files that were modified |

**Behavior**: Ends the agent loop and returns the session result. This is the only way for an agent to gracefully terminate.

## Tool Execution Flow

```
Agent requests tool call
        │
        ▼
┌───────────────┐
│ Policy Engine │──→ deny? ──→ Return denial message to agent
│  evaluate()   │
└───────┬───────┘
        │ allow / require_approval
        ▼
┌───────────────┐
│   Approval    │──→ denied? ──→ Return denial to agent
│  (if needed)  │
└───────┬───────┘
        │ approved
        ▼
┌───────────────┐
│  Check Cache  │──→ hit? ──→ Return cached result
│               │
└───────┬───────┘
        │ miss
        ▼
┌───────────────┐
│ Tool Executor │──→ Execute in sandbox working directory
│  execute()    │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Cache Result  │──→ Store if tool is cacheable
│ (if eligible) │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Track Diffs   │──→ Update cumulative diff line count
│ (if write)    │
└───────────────┘
```

## Custom Tools via Skills

The [Skills system](learning.md#skills-registry) can inject additional tools:

```json
{
  "name": "deploy",
  "description": "Deploy the application",
  "triggers": ["deploy", "release", "ship"],
  "tools": [
    {
      "name": "deploy_staging",
      "description": "Deploy to staging environment",
      "inputSchema": {
        "type": "object",
        "properties": {
          "version": { "type": "string" }
        }
      }
    }
  ]
}
```

Skills-injected tools are only available when a matching skill is activated for the current task.
