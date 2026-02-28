# Agent Runtime

The agent runtime is the core execution engine. It manages the multi-turn loop where an LLM plans and executes tool calls to complete a task.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        AgentLoop                             │
│                                                              │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────────┐    │
│  │   Prompt    │  │   Context    │  │    Recovery       │    │
│  │  Builder    │  │   Manager    │  │    Manager        │    │
│  │            │  │             │  │                   │    │
│  │ system     │  │ token track │  │ error detection  │    │
│  │ prompt +   │  │ auto-       │  │ loop detection   │    │
│  │ knowledge  │  │ summarize   │  │ stall detection  │    │
│  │ + skills   │  │ when 75%    │  │ hallucination    │    │
│  │ + agents.md│  │ capacity    │  │ detection        │    │
│  └─────┬──────┘  └──────┬──────┘  └────────┬─────────┘    │
│        │                │                   │               │
│  ┌─────▼────────────────▼───────────────────▼──────────┐    │
│  │                 Main Loop                            │    │
│  │                                                     │    │
│  │  1. Build messages (with context management)        │    │
│  │  2. Call model (chat or stream)                     │    │
│  │  3. Check for tool_use in response                  │    │
│  │  4. Evaluate tool call against PolicyEngine         │    │
│  │  5. Check ToolResultCache                           │    │
│  │  6. Execute tool via ToolExecutor                   │    │
│  │  7. Cache result if eligible                        │    │
│  │  8. Feed result back to model                       │    │
│  │  9. Check RecoveryManager for anomalies             │    │
│  │ 10. Repeat until task_done or max iterations        │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐     │
│  │   Tool      │  │   Policy     │  │   Tool Result    │     │
│  │  Executor   │  │   Engine     │  │   Cache          │     │
│  └────────────┘  └──────────────┘  └──────────────────┘     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │             SubAgentSpawner                          │    │
│  │  Delegates subtasks to child agents                  │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

## Two Runtimes

Foreman supports two execution backends:

| Feature | Built-in AgentLoop | Claude Code CLI |
|---------|--------------------|-----------------|
| **Config** | `runtime = "foreman"` | `runtime = "claude-code"` |
| **How** | Direct API calls | Spawns `claude` subprocess |
| **Tools** | Custom tool definitions | Claude Code's native tools |
| **Streaming** | Via provider API | Via `--output-format stream-json` |
| **Policy** | Inline evaluation | Via [hooks sidecar](hooks.md) |
| **Best for** | Full control, custom tools | Claude Code's native capabilities |

### Built-in AgentLoop

The default runtime. Calls the LLM API directly and executes tools in-process.

```toml
[foreman]
runtime = "foreman"   # default
```

### Claude Code CLI

Delegates execution to the `claude` CLI. Foreman provides orchestration, learning, and policy enforcement around it.

```toml
[foreman]
runtime = "claude-code"
```

See [Claude Code Hooks](hooks.md) for policy enforcement in this mode.

## AgentLoop Lifecycle

### 1. Initialization

```typescript
const loop = new AgentLoop({
  provider,           // ModelProvider instance
  modelConfig,        // max_tokens, temperature, etc.
  toolExecutor,       // Executes tools in sandbox
  policyEngine,       // Evaluates tool calls
  workingDir: "/path/to/project",
  maxIterations: 200,
  maxTokens: 200_000,
  onApproval: async (tool, input) => true,  // Approval callback
});
```

### 2. Execution

```typescript
const session = await loop.run({
  task: {
    id: "task-1",
    title: "Fix the login bug",
    description: "Users can't log in when...",
  },
  promptEnrichment: {
    lessons: [...],
    conventions: "...",
    activeSkills: [...],
  },
});
```

### 3. Session Result

```typescript
interface AgentSession {
  id: string;
  taskId: string;
  status: "running" | "completed" | "failed" | "aborted";
  iterations: number;
  tokenUsage: { input: number; output: number; total: number };
  toolCalls: ToolCallRecord[];
  filesChanged: string[];
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
}
```

## Context Management

The `ContextManager` prevents context window overflow by automatically summarizing older messages.

```
┌─────────────────────────────────────────────────┐
│              Context Window                      │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  System prompt (always kept)              │   │
│  ├──────────────────────────────────────────┤   │
│  │  Summary of turns 1-15 (compressed)      │   │
│  ├──────────────────────────────────────────┤   │
│  │  Recent turns 16-25 (full detail)        │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  Token usage: 150,000 / 200,000 (75%)           │
│  ┌──────────────────────┐                       │
│  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░ │ ← Summarize here     │
│  └──────────────────────┘                       │
└─────────────────────────────────────────────────┘
```

**How it works**:

1. After each model turn, token usage is estimated (~4 chars per token)
2. When usage exceeds 75% of max context tokens, summarization triggers
3. Older messages are compressed into a summary that preserves:
   - Files read and written
   - Commands executed
   - Key decisions made
   - Current progress
4. The 10 most recent messages are always kept in full detail
5. Summarization can use AI (via a fast model) or a rule-based fallback

```typescript
const contextManager = new ContextManager({
  maxContextTokens: 200_000,
  summarizationThreshold: 0.75,
  provider: fastProvider,  // Optional: AI-powered summarization
});
```

## Recovery System

The `RecoveryManager` detects and recovers from common failure modes:

### Error Detection

- **Model errors**: Malformed responses, API errors
- **Hallucinated tools**: Model calls a tool that doesn't exist
- **Invalid arguments**: Tool call with missing/wrong argument types

Recovery: Injects an error message guiding the model back on track.

### Loop Detection

Detects when the model makes the same tool call repeatedly:

```
Iteration 15: read_file("src/app.ts")
Iteration 16: read_file("src/app.ts")   ← same call
Iteration 17: read_file("src/app.ts")   ← loop detected!
```

Tracks tool call signatures via input hashing. Configurable threshold (default: 3 identical calls).

Recovery: Injects a message telling the model it's in a loop.

### Stall Detection

Detects when the agent makes no progress (no file writes) over N iterations:

```
Iterations 10-20: Only read_file and search_codebase calls
                  No write_file or edit_file in 10 turns
                  → Agent is stalled
```

Recovery: Injects a message prompting the agent to take action or call `task_done`.

### Configuration

```typescript
const recovery = new RecoveryManager({
  maxConsecutiveErrors: 3,    // Errors before injecting recovery prompt
  loopDetectionWindow: 10,   // Check last N calls for loops
  stuckThreshold: 15,        // Iterations without progress
});
```

## Tool Result Cache

The `ToolResultCache` avoids redundant tool calls within a session:

### Cacheable Tools

| Tool | Cached | Why |
|------|--------|-----|
| `read_file` | Yes | File contents don't change unless we write |
| `list_files` | Yes | Directory listings are stable |
| `search_codebase` | Yes | Search results stable within session |
| `git_status` | Yes | Invalidated on file write |
| `git_diff` | Yes | Invalidated on file write |
| `git_log` | Yes | Invalidated on commit |
| `write_file` | No | Side effect |
| `edit_file` | No | Side effect |
| `run_command` | No | Side effect |

### Cache Invalidation

When a write operation occurs, related caches are intelligently invalidated:

- `write_file("src/app.ts")` → invalidates `read_file("src/app.ts")` + all `git_*` caches
- `edit_file("src/app.ts")` → same as above
- `run_command("npm install")` → invalidates all caches (command side effects unknown)
- `git_commit(...)` → invalidates `git_*` caches

### Statistics

```typescript
const stats = cache.getStats();
// { hits: 42, misses: 18, hitRate: 0.70 }
```

## System Prompt Construction

The `buildSystemPrompt()` function assembles the full system prompt from multiple sources:

```
┌──────────────────────────────────────────────────┐
│              System Prompt Assembly               │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Base Role                                │   │
│  │  "You are an expert software engineer..." │   │
│  ├──────────────────────────────────────────┤   │
│  │  Task Context                             │   │
│  │  Title, description, labels               │   │
│  ├──────────────────────────────────────────┤   │
│  │  Codebase Context (auto-gathered)         │   │
│  │  • File tree (top 50 files)              │   │
│  │  • package.json info                      │   │
│  │  • Recent git commits (last 10)          │   │
│  ├──────────────────────────────────────────┤   │
│  │  Knowledge (from KnowledgeStore)          │   │
│  │  "From past sessions: prefer Vitest..."   │   │
│  ├──────────────────────────────────────────┤   │
│  │  Conventions (from AGENTS.md)             │   │
│  │  "Use 2-space indent, no semicolons..."   │   │
│  ├──────────────────────────────────────────┤   │
│  │  Active Skills                            │   │
│  │  Matched skill templates + extra tools    │   │
│  ├──────────────────────────────────────────┤   │
│  │  Policy Constraints                       │   │
│  │  "Do NOT modify: package.json, .env"      │   │
│  ├──────────────────────────────────────────┤   │
│  │  Tool Usage Guidelines                    │   │
│  │  15 rules for effective tool use          │   │
│  └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

### Prompt Enrichment

The learning system provides task-specific enrichment:

```typescript
interface PromptEnrichment {
  lessons: Array<{ text: string; confidence: number }>;
  conventions: string;       // From AGENTS.md
  activeSkills: Array<{
    name: string;
    promptTemplate: string;
    tools: ToolDefinition[];
  }>;
}
```

See [Learning System](learning.md) for how enrichment data is gathered.

## Sub-Agent Spawning

Agents can delegate subtasks to independent child agents:

```typescript
// Parent agent calls spawn_subagent tool
{
  "tool": "spawn_subagent",
  "input": {
    "title": "Write unit tests for auth module",
    "description": "Create comprehensive tests for src/auth/...",
    "modelRole": "coder"
  }
}
```

The `SubAgentSpawner`:

1. Creates a new `AgentLoop` with the specified model role
2. Runs it to completion
3. Collects the result, files changed, and token usage
4. Returns a summary to the parent agent
5. Invalidates parent's cache for any files the sub-agent modified

```typescript
interface SubAgentResult {
  success: boolean;
  summary: string;
  filesChanged: string[];
  tokenUsage: { input: number; output: number; total: number };
  iterations: number;
  durationMs: number;
}
```

## Claude Code Adapter

The `ClaudeCodeRunner` spawns the `claude` CLI as a subprocess:

```typescript
const runner = new ClaudeCodeRunner({
  workingDir: "/path/to/project",
  maxTurns: 50,
  model: "claude-sonnet-4-5-20250929",
  allowedTools: ["Read", "Write", "Edit", "Bash"],
  systemPrompt: enrichedPrompt,
});

runner.on("text", (text) => { /* streaming output */ });
runner.on("tool_use", (tool) => { /* tool call event */ });
runner.on("done", (result) => { /* completion */ });

await runner.run("Fix the login bug in src/auth.ts");
```

**Subprocess flags**: `claude --print --output-format stream-json --max-turns 50`

**Event translation**: Claude Code's stream-json events are translated to Foreman events and published on the EventBus.
