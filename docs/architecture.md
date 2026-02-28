# Architecture Overview

## System Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                 │
│                                                                             │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────────┐  │
│  │   CLI    │  │   TUI    │  │  HTTP API  │  │ WebSocket│  │   Hooks   │  │
│  │ commands │  │ React/Ink│  │  REST JSON │  │ realtime │  │ CC sidecar│  │
│  └────┬─────┘  └────┬─────┘  └─────┬──────┘  └────┬─────┘  └─────┬─────┘  │
└───────┼──────────────┼──────────────┼──────────────┼──────────────┼─────────┘
        │              │              │              │              │
        └──────────────┴──────────────┼──────────────┴──────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                            ORCHESTRATOR                                     │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        Task Queue                                     │  │
│  │  enqueueTask() → processQueue() → executeTask()                      │  │
│  │  Concurrency limit: maxConcurrentAgents                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │ Model Router │  │ Policy Engine│  │ Task Decomposer│  │   Session   │  │
│  │              │  │              │  │               │  │    Store    │  │
│  │ complexity   │  │ protected    │  │ LLM + heurist │  │            │  │
│  │ scoring      │  │ paths        │  │ DAG builder   │  │ persist to │  │
│  │              │  │              │  │               │  │ disk       │  │
│  │ 3 strategies │  │ blocked cmds │  │ 5 patterns    │  │            │  │
│  │              │  │              │  │               │  │ restore on │  │
│  │ budget caps  │  │ diff limits  │  │ parallel      │  │ restart    │  │
│  │              │  │              │  │ batching      │  │            │  │
│  │ perf history │  │ approval     │  │               │  │            │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  └──────────────┘  │
│         │                 │                   │                             │
└─────────┼─────────────────┼───────────────────┼─────────────────────────────┘
          │                 │                   │
┌─────────▼─────────────────▼───────────────────▼─────────────────────────────┐
│                          AGENT RUNTIME                                       │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                     Three Execution Modes                               │ │
│  │                                                                         │ │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │ │
│  │  │   AgentLoop     │  │  ClaudeCodeRunner │  │  MultiAgentExecutor  │  │ │
│  │  │   (built-in)    │  │  (CLI adapter)    │  │  (parallel DAG)      │  │ │
│  │  │                 │  │                   │  │                      │  │ │
│  │  │  LLM ←→ Tools   │  │  claude --print   │  │  graph.getReady()   │  │ │
│  │  │  loop until     │  │  --output-format  │  │  dispatch N agents  │  │ │
│  │  │  task_done      │  │  stream-json      │  │  wait, repeat       │  │ │
│  │  │                 │  │                   │  │                      │  │ │
│  │  │  Context mgmt   │  │  Parse events     │  │  Skip on dep fail  │  │ │
│  │  │  Recovery       │  │  Map to Foreman   │  │  Aggregate results  │  │ │
│  │  │  Caching        │  │  events           │  │                      │  │ │
│  │  └─────────────────┘  └──────────────────┘  └───────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  ┌───────────────────┐   │
│  │  Context    │  │  Recovery   │  │   Cache    │  │  SubAgent        │   │
│  │  Manager    │  │  Manager    │  │            │  │  Spawner         │   │
│  │             │  │             │  │  read_file │  │                  │   │
│  │  token est. │  │  loop det.  │  │  git ops   │  │  delegate to    │   │
│  │  auto-      │  │  stall det. │  │  search    │  │  different      │   │
│  │  summarize  │  │  error cap  │  │  results   │  │  model roles    │   │
│  │  compact    │  │  corrective │  │            │  │                  │   │
│  │  history    │  │  messages   │  │  invalidate│  │  spawn_subagent │   │
│  │             │  │             │  │  on write  │  │  tool            │   │
│  └─────────────┘  └─────────────┘  └────────────┘  └───────────────────┘   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                         Tool Executor                                   │ │
│  │  read_file │ write_file │ edit_file │ run_command │ search_codebase    │ │
│  │  git_status │ git_diff │ git_commit │ git_branch │ create_pull_request │ │
│  │  web_fetch │ spawn_subagent │ task_done │ list_files │ delete_file     │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                          PROVIDER LAYER                                      │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                      Provider Registry                               │    │
│  │  register() │ get() │ getOrThrow() │ healthCheckAll() │ isHealthy() │    │
│  └──────┬──────────────┬──────────────┬──────────────┬──────────────────┘    │
│         │              │              │              │                        │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼───────┐ ┌───▼────────────┐          │
│  │  Anthropic  │ │  OpenAI    │ │  Ollama    │ │  Custom        │          │
│  │  Provider   │ │  Provider  │ │  Provider  │ │  (extend base) │          │
│  │             │ │            │ │            │ │                │          │
│  │  claude-*   │ │  gpt-4o    │ │  qwen3     │ │  Any provider  │          │
│  │  streaming  │ │  streaming │ │  llama     │ │  implementing  │          │
│  │  tool_use   │ │  functions │ │  mistral   │ │  ModelProvider │          │
│  └─────────────┘ └────────────┘ └────────────┘ └────────────────┘          │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                         SUPPORTING SYSTEMS                                   │
│                                                                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐  │
│  │  EventBus  │ │  Learning  │ │   Skills   │ │ Autopilot│ │   Hooks    │  │
│  │            │ │            │ │            │ │          │ │            │  │
│  │  typed     │ │ Knowledge  │ │  7 builtin │ │ 8 scan   │ │ PreToolUse │  │
│  │  pub/sub   │ │ Store      │ │  + custom  │ │ types    │ │ PostToolUse│  │
│  │            │ │            │ │            │ │          │ │ Stop       │  │
│  │  history   │ │ AGENTS.md  │ │  trigger   │ │ cron     │ │ TaskDone   │  │
│  │  pause/    │ │ manager    │ │  matching  │ │ schedule │ │ SessionStart│ │
│  │  resume    │ │            │ │            │ │          │ │            │  │
│  │  waitFor   │ │ cross-     │ │  prompt    │ │ auto-    │ │ policy +   │  │
│  │  promise   │ │ session    │ │  enrich    │ │ resolve  │ │ telemetry  │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────┘ └────────────┘  │
│                                                                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐  │
│  │  Sandbox   │ │  Session   │ │  Secrets   │ │  Logger  │ │Performance │  │
│  │  Manager   │ │  Store     │ │  Manager   │ │          │ │  Tracker   │  │
│  │            │ │            │ │            │ │ hierarch │ │            │  │
│  │  docker    │ │  disk      │ │  .env      │ │ child()  │ │ per-model  │  │
│  │  local     │ │  persist   │ │  env vars  │ │ levels   │ │ per-label  │  │
│  │  cloud     │ │  restore   │ │  encrypted │ │ context  │ │ cost track │  │
│  │  warm pool │ │  prune     │ │  masked    │ │          │ │ success %  │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────┘ └────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────────┐
│                          INTEGRATIONS                                        │
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐           │
│  │     GitHub        │  │     Linear       │  │     Slack        │           │
│  │                   │  │                  │  │                  │           │
│  │  GitHubClient     │  │  LinearClient    │  │  SlackClient     │           │
│  │  - issues CRUD    │  │  - GraphQL API   │  │  - Web API       │           │
│  │  - labels         │  │  - ticket CRUD   │  │  - messages      │           │
│  │  - comments       │  │  - status update │  │  - reactions     │           │
│  │  - pull requests  │  │  - comments      │  │  - channels      │           │
│  │                   │  │                  │  │                  │           │
│  │  GitHubWatcher    │  │  LinearWatcher   │  │  SlackWatcher    │           │
│  │  - poll issues    │  │  - poll tickets  │  │  - poll messages │           │
│  │  - emit tasks     │  │  - emit tasks    │  │  - emit tasks    │           │
│  │  - dedup          │  │  - dedup         │  │  - prefix match  │           │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘           │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Task Execution Flow

```
                    Task Source
                  (CLI / API / Watcher)
                         │
                         ▼
                ┌────────────────┐
                │  enqueueTask() │
                │  source tag    │
                └───────┬────────┘
                        │
                        ▼
                ┌────────────────┐
                │ processQueue() │◄─── respects maxConcurrentAgents
                │ dequeue next   │
                └───────┬────────┘
                        │
                        ▼
                ┌────────────────┐      ┌──────────────┐
                │ scoreComplexity│─────►│ 1-10 score   │
                │                │      │ capabilities │
                └───────┬────────┘      └──────────────┘
                        │
                ┌───────▼────────┐
            ┌───┤ decompose?     ├───┐
            │   │ score >= thresh │   │
            │   └────────────────┘   │
            │ yes                    │ no
            ▼                        ▼
   ┌─────────────────┐     ┌─────────────────┐
   │ TaskDecomposer   │     │   ModelRouter    │
   │ → TaskGraph      │     │   route(task)    │
   │ → batches        │     │   → modelKey     │
   └────────┬────────┘     └────────┬────────┘
            │                       │
            ▼                       ▼
   ┌─────────────────┐     ┌─────────────────┐
   │ MultiAgent      │     │ acquire sandbox  │
   │ Executor        │     │ build enrichment │
   │ parallel DAG    │     │ select runtime   │
   └────────┬────────┘     └────────┬────────┘
            │                       │
            │               ┌───────┴──────────┐
            │           ┌───┤ runtime?          ├───┐
            │           │   └──────────────────┘   │
            │       foreman                    claude-code
            │           │                          │
            │           ▼                          ▼
            │   ┌───────────────┐        ┌───────────────┐
            │   │   AgentLoop   │        │ ClaudeCode    │
            │   │   tool loop   │        │ Runner        │
            │   └───────┬───────┘        └───────┬───────┘
            │           │                        │
            └───────────┼────────────────────────┘
                        │
                        ▼
               ┌─────────────────┐
               │ Record metrics  │
               │ Save session    │
               │ Learn from run  │
               │ Notify sources  │
               │ Release sandbox │
               └─────────────────┘
```

### Prompt Construction Pipeline

```
┌──────────────┐
│  AgentTask   │──► Title, description, repo, branch, labels
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ buildSystem  │
│ Prompt()     │
└──────┬───────┘
       │
       ├──► Core identity: "You are Foreman Agent..."
       │
       ├──► Task context: title, description, repo, branch
       │
       ├──► buildCodebaseContext()
       │    ├──► File tree (list_files)
       │    ├──► Package.json metadata
       │    └──► Recent git commits
       │
       ├──► PromptEnrichment
       │    ├──► lessonsSection ◄── KnowledgeStore.buildPromptSection()
       │    ├──► agentsMdSection ◄── AgentsMdManager.load() + format
       │    └──► skillsSection ◄── SkillsRegistry.matchSkills() + format
       │
       ├──► Code standards (style, testing, commit guidelines)
       │
       ├──► Policy constraints (protected paths, blocked commands)
       │
       ├──► Tool usage guidelines (15 rules)
       │
       └──► Custom instructions (if any)
```

### Learning Loop

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Session     │────►│ learnFrom    │────►│ Knowledge    │
│  completes   │     │ Session()    │     │ Base         │
└──────────────┘     └──────────────┘     │              │
                                          │  lessons[]   │
                                          │  failures[]  │
┌──────────────┐     ┌──────────────┐     │  modelPrefs{}│
│  User        │────►│ learnFrom    │────►│  seenFindings│
│  correction  │     │ User()       │     │              │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
┌──────────────┐     ┌──────────────┐            │
│  Autopilot   │────►│ learnFrom    │────────────┘
│  findings    │     │ Findings()   │
└──────────────┘     └──────────────┘
                                                 │
                                                 ▼
                                          ┌──────────────┐
                                          │ buildPrompt  │
                                          │ Section()    │
                                          │              │
                                          │  Inject into │
                                          │  next agent  │
                                          │  session     │
                                          └──────────────┘
```

## Key Design Decisions

### Zero External Dependencies for Core

The HTTP server, WebSocket implementation, TOML parser, cron scheduler, and minimatch utility are all built from scratch using Node.js built-in modules. This means:
- No supply chain risk from transitive dependencies
- Complete control over behavior
- Smaller install footprint

Only 7 runtime dependencies exist, all for the presentation layer (React/Ink for TUI) and provider SDKs.

### Event-Driven Architecture

Every significant action emits a typed `ForemanEvent` through the `EventBus`. This enables:
- Loose coupling between components
- Real-time WebSocket streaming
- TUI updates
- Hook integration
- Telemetry collection
- All without components knowing about each other

### Three Execution Modes

Rather than a monolithic agent, Foreman offers three runtime modes:

1. **AgentLoop** — Full built-in runtime with context management, recovery, caching. Best for automated pipelines.
2. **ClaudeCodeRunner** — Delegates to Claude Code CLI. Best when you want Claude Code's capabilities with Foreman's orchestration.
3. **MultiAgentExecutor** — Decomposes into a DAG and runs subtasks in parallel. Best for complex, multi-step tasks.

### Pluggable Everything

Every major system can be swapped or extended:
- Providers: implement `ModelProvider` interface
- Skills: drop JSON files in `.foreman/skills/`
- Integrations: each watcher is independent
- Policies: configurable rules, no hardcoded behavior
- Learning: KnowledgeStore is a plain JSON file

## Module Dependency Graph

```
orchestrator.ts
├── providers/registry.ts
│   ├── providers/anthropic.ts
│   ├── providers/openai.ts
│   └── providers/ollama.ts
├── router/router.ts
│   └── router/performance.ts
├── runtime/loop.ts
│   ├── runtime/context.ts
│   ├── runtime/recovery.ts
│   ├── runtime/cache.ts
│   ├── runtime/prompt.ts
│   ├── runtime/subagent.ts
│   ├── tools/executor.ts
│   │   └── tools/definitions.ts
│   └── policy/engine.ts
├── runtime/adapters/claude-code.ts
├── orchestration/decomposer.ts
│   └── orchestration/graph.ts
├── orchestration/executor.ts
├── sandbox/manager.ts
├── events/bus.ts
├── learning/knowledge.ts
├── learning/agents-md.ts
├── skills/registry.ts
├── storage/sessions.ts
├── linear/watcher.ts
│   └── linear/client.ts
├── integrations/github.ts
├── integrations/slack.ts
├── autopilot/engine.ts
│   ├── autopilot/reviewer.ts
│   ├── autopilot/scheduler.ts
│   └── autopilot/tickets.ts
└── logging/logger.ts
```
