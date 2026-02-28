# Policy Engine

The Policy Engine evaluates every tool call before execution, enforcing safety rules to prevent destructive or unauthorized operations.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                    PolicyEngine                         │
│                                                        │
│  Tool Call ──→ ┌──────────────────────┐                │
│                │  Evaluate Pipeline    │                │
│                │                      │                │
│                │  1. Protected paths  │                │
│                │  2. Blocked commands │                │
│                │  3. Dangerous patterns│               │
│                │  4. Diff thresholds  │                │
│                │  5. Remote state     │                │
│                └──────────┬───────────┘                │
│                           │                            │
│                           ▼                            │
│                ┌──────────────────────┐                │
│                │     Decision         │                │
│                │                      │                │
│                │  • allow             │                │
│                │  • deny (+ reason)   │                │
│                │  • require_approval  │                │
│                └──────────────────────┘                │
└────────────────────────────────────────────────────────┘
```

## Configuration

```toml
[policy]
protected_paths = ["package.json", ".env", ".env.*", ".github/*"]
blocked_commands = ["rm -rf /", "curl | sh"]
max_diff_lines = 500
require_approval_above = 200
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `protected_paths` | string[] | `[]` | Glob patterns for files requiring approval to modify. |
| `blocked_commands` | string[] | `[]` | Command substrings that are always denied. |
| `max_diff_lines` | number | `500` | Hard limit — deny if cumulative diff exceeds this. |
| `require_approval_above` | number | `200` | Soft limit — require approval above this threshold. |

## Decision Types

### `allow`

Tool call proceeds without interruption. Used for:
- Read-only operations (`read_file`, `search_codebase`, `list_files`, `git_status`, `git_diff`, `git_log`)
- Write operations to non-protected paths below diff thresholds

### `deny`

Tool call is blocked. The agent receives a denial message and must try a different approach. Used for:
- Writes to protected paths
- Blocked command matches
- Dangerous command patterns
- Diff threshold exceeded (`max_diff_lines`)

### `require_approval`

Tool call is paused pending human approval. The approval callback is invoked. Used for:
- Diff threshold exceeded (`require_approval_above` but below `max_diff_lines`)
- Package manager commands
- Git state-changing operations
- PR creation

## Evaluation Rules

### File Write Operations (`write_file`, `edit_file`)

```
1. Check protected_paths
   ├─ Match? → deny("Protected path: {path}")
   └─ No match ↓

2. Track diff lines (estimate based on content)

3. Check cumulative diff
   ├─ > max_diff_lines? → deny("Diff limit exceeded")
   ├─ > require_approval_above? → require_approval("Large diff: {n} lines")
   └─ Below thresholds → allow
```

### Command Execution (`run_command`)

```
1. Check blocked_commands list
   ├─ Contains blocked substring? → deny("Blocked command")
   └─ No match ↓

2. Check dangerous patterns
   ├─ rm -rf /          → deny
   ├─ :(){ :|:& };:    → deny (fork bomb)
   ├─ > /dev/sd*        → deny (device write)
   ├─ mkfs.*            → deny (format disk)
   ├─ dd if=*           → deny (disk write)
   └─ No match ↓

3. Check approval patterns
   ├─ npm/yarn/pnpm install  → require_approval
   ├─ pip install             → require_approval
   ├─ cargo install           → require_approval
   ├─ git push                → require_approval
   ├─ git reset               → require_approval
   ├─ git checkout -- .       → require_approval
   └─ No match → allow
```

### Git Operations

| Tool | Policy |
|------|--------|
| `git_status` | Always allow |
| `git_diff` | Always allow |
| `git_log` | Always allow |
| `git_branch` | Always allow |
| `git_commit` | Require approval if cumulative diff > `require_approval_above` |
| `create_pull_request` | Always require approval |

### Other Tools

| Tool | Policy |
|------|--------|
| `read_file` | Always allow |
| `search_codebase` | Always allow |
| `list_files` | Always allow |
| `web_fetch` | Always allow |
| `spawn_subagent` | Always allow |
| `task_done` | Always allow |

## Protected Paths

Glob patterns that prevent agent modification of sensitive files:

```toml
protected_paths = [
  "package.json",     # Direct match
  ".env",             # Direct match
  ".env.*",           # Glob: .env.local, .env.production
  ".github/*",        # Glob: all files in .github/
  "**/*.lock",        # Recursive: all lock files
  "Dockerfile",       # Direct match
]
```

### Path Matching

The engine supports multiple matching modes:

| Pattern | Matches | Mode |
|---------|---------|------|
| `package.json` | `package.json` | Exact filename |
| `.env.*` | `.env.local`, `.env.prod` | Wildcard glob |
| `.github/*` | `.github/workflows/ci.yml` | Directory prefix |
| `src/**/*.test.ts` | `src/deep/nested/foo.test.ts` | Recursive glob |

## Diff Tracking

The engine tracks cumulative diff lines across all file modifications in a session:

```
write_file("src/app.ts", 50 lines)     → cumulative: 50
edit_file("src/utils.ts", +10 -5)      → cumulative: 65
write_file("src/new.ts", 200 lines)    → cumulative: 265
                                          ↑ exceeds require_approval_above (200)
                                          → next write requires approval
```

### Methods

```typescript
// Track lines changed for a file
engine.trackDiffLines("src/app.ts", 50);

// Check current cumulative total
engine.getTotalDiffLines(); // 265

// Evaluate diff size against thresholds
engine.evaluateDiffSize();
// → { decision: "require_approval", reason: "Large cumulative diff: 265 lines" }

// Reset tracking (e.g., after approval)
engine.resetDiffTracking();
```

## Built-in Dangerous Patterns

These patterns are **always denied** regardless of configuration:

| Pattern | Reason |
|---------|--------|
| `rm -rf /` | Recursive delete from root |
| `:(){ :\|:& };:` | Fork bomb |
| `> /dev/sd` | Direct device write |
| `mkfs` | Filesystem format |
| `dd if=` | Direct disk write |

## Approval Flow

When a tool call requires approval:

1. The policy engine returns `require_approval` with a reason
2. The `AgentLoop` calls the `onApproval` callback
3. The callback can be:
   - **Interactive**: Prompts the user via TUI
   - **Auto-approve**: Returns `true` (for CI/headless mode)
   - **Auto-deny**: Returns `false` (for locked-down environments)
4. If approved, execution proceeds
5. If denied, the agent receives a denial message

```typescript
const loop = new AgentLoop({
  // ...
  onApproval: async (toolName, toolInput) => {
    // Custom approval logic
    if (toolName === "run_command" && toolInput.command.includes("npm install")) {
      return true; // Auto-approve npm install
    }
    return false; // Deny everything else
  },
});
```

## Hooks Mode

When Foreman runs as a [Claude Code hooks sidecar](hooks.md), the policy engine evaluates Claude Code tool calls:

- Claude Code tool names are mapped to Foreman equivalents (`Bash` → `run_command`, `Write` → `write_file`, etc.)
- `require_approval` is mapped to `deny` (no interactive approval in hooks mode)
- Hook responses use the Claude Code protocol (`allow` / `deny` with message)

## Programmatic Usage

```typescript
import { PolicyEngine } from "foreman";

const engine = new PolicyEngine({
  protectedPaths: ["package.json", ".env"],
  blockedCommands: ["rm -rf /"],
  maxDiffLines: 500,
  requireApprovalAbove: 200,
});

// Evaluate a tool call
const decision = engine.evaluate("write_file", {
  path: "package.json",
  content: "...",
});
// → { decision: "deny", reason: "Protected path: package.json" }

const decision2 = engine.evaluate("run_command", {
  command: "npm test",
});
// → { decision: "allow" }
```
