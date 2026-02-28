# Programmatic Usage

Foreman can be used as a TypeScript/JavaScript library for building custom agent workflows.

## Installation

```bash
npm install foreman
```

## Quick Start

```typescript
import {
  Orchestrator,
  ProviderRegistry,
  EventBus,
} from "foreman";

// Load config
const config = await loadConfig("./foreman.toml");

// Create core components
const bus = new EventBus();
const registry = ProviderRegistry.fromConfig(config);

// Create orchestrator
const orchestrator = new Orchestrator({ config, registry, bus });

// Execute a task
const session = await orchestrator.executeTask({
  id: "task-1",
  title: "Fix the login bug",
  description: "Users can't log in with email containing + character",
  labels: ["bug", "auth"],
});

console.log(session.status);       // "completed"
console.log(session.result);       // "Fixed by escaping + in email regex..."
console.log(session.filesChanged); // ["src/auth/validate.ts"]
```

## Core Exports

### Configuration

```typescript
import { loadConfig } from "foreman";

// Load from file
const config = await loadConfig("./foreman.toml");

// Load from default locations
const config = await loadConfig(); // searches ./foreman.toml, ./.foreman.toml, ~/.config/foreman/
```

### Providers

```typescript
import {
  ProviderRegistry,
  AnthropicProvider,
  OpenAIProvider,
  OllamaProvider,
} from "foreman";

// From config
const registry = ProviderRegistry.fromConfig(config);

// Manual setup
const registry = new ProviderRegistry();
registry.register("coder", new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5-20250929",
}));

// Get a provider
const provider = registry.getOrThrow("coder");

// Direct provider usage
const response = await provider.chat({
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 100,
});
```

### Agent Loop

```typescript
import {
  AgentLoop,
  ToolExecutor,
  PolicyEngine,
} from "foreman";

const loop = new AgentLoop({
  provider: registry.getOrThrow("coder"),
  modelConfig: config.models.coder,
  toolExecutor: new ToolExecutor(),
  policyEngine: new PolicyEngine(config.policy),
  workingDir: process.cwd(),
  maxIterations: 200,
  maxTokens: 200_000,
  onApproval: async (tool, input) => {
    // Custom approval logic
    return true;
  },
});

const session = await loop.run({
  task: {
    id: "task-1",
    title: "Add dark mode",
    description: "Add a dark mode toggle to settings",
  },
});
```

### Router

```typescript
import { ModelRouter } from "foreman";

const router = new ModelRouter({
  config: config.routing,
  models: config.models,
  registry,
  budgetCapUsd: 50.0,
});

const decision = router.route({
  id: "task-1",
  title: "Refactor auth module",
  description: "...",
  labels: ["refactor"],
});

console.log(decision.modelKey);  // "architect"
console.log(decision.reason);    // "Capability-matched to "architect" (complexity: 9)"
```

### Sandbox

```typescript
import { SandboxManager } from "foreman";

const manager = new SandboxManager(config.sandbox);
await manager.initialize();

const sandbox = await manager.acquire({
  taskId: "task-1",
  repoUrl: "https://github.com/org/repo.git",
  branch: "main",
});

// Use sandbox.workingDir for the agent
console.log(sandbox.workingDir);

// Release when done
const artifacts = await manager.release(sandbox.id, true);
console.log(artifacts.diff);

await manager.destroyAll();
```

### Event Bus

```typescript
import { EventBus } from "foreman";

const bus = new EventBus({ historySize: 500 });

// Subscribe to specific events
bus.on("agent:completed", (event) => {
  console.log(`Agent done: ${event.session.task.title}`);
});

// Subscribe to all events
bus.onAny((event) => {
  console.log(`[${event.type}]`, JSON.stringify(event));
});

// Wait for a specific event
const completedEvent = await bus.waitFor("agent:completed", 60_000);

// Get event history
const recentTasks = bus.getHistory("agent:completed");
```

### Learning System

```typescript
import {
  KnowledgeStore,
  AgentsMdManager,
  SkillsRegistry,
} from "foreman";

// Knowledge
const knowledge = new KnowledgeStore("~/.foreman/knowledge.json");
await knowledge.load();

const lessons = knowledge.getLessonsForTask({
  title: "Add OAuth",
  labels: ["feature", "auth"],
});

await knowledge.learnFromUser("Always use Vitest", "preference");

// AGENTS.md
const agentsMd = new AgentsMdManager();
const conventions = await agentsMd.load("/path/to/project");

// Skills
const skills = new SkillsRegistry();
const matched = skills.matchSkills(task);
const promptSection = skills.buildPromptSection(matched);
```

### Autopilot

```typescript
import { AutopilotEngine } from "foreman";

const autopilot = new AutopilotEngine({
  config: config.autopilot,
  registry,
  bus,
  githubClient,   // optional
  linearClient,   // optional
  knowledgeStore,  // optional
});

// Run a single scan
const run = await autopilot.triggerRun();
console.log(run.findingsCount);
console.log(run.ticketsCreated);

// Start continuous autopilot
await autopilot.start();
// ... runs on cron schedule ...
await autopilot.stop();
```

### Task Decomposition

```typescript
import {
  TaskDecomposer,
  MultiAgentExecutor,
} from "foreman";

const decomposer = new TaskDecomposer({
  provider: registry.get("architect"),
  maxSubtasks: 8,
  heuristicFallback: true,
});

const { graph, strategy, reasoning } = await decomposer.decompose({
  id: "task-1",
  title: "Implement authentication",
  description: "Full JWT + OAuth2 auth system",
  labels: ["feature"],
});

console.log(strategy);  // "llm" or "heuristic"
console.log(graph.size());  // 5 subtasks
console.log(graph.getParallelBatches());

// Execute the graph
const executor = new MultiAgentExecutor({
  registry,
  router,
  config,
  bus,
});

const result = await executor.execute(graph);
console.log(result.success);
console.log(result.summary);
```

### API Server

```typescript
import { ApiServer } from "foreman";

const server = new ApiServer({
  port: 4820,
  host: "127.0.0.1",
  bus,
  orchestrator,
  apiKey: process.env.FOREMAN_API_KEY,
  corsOrigins: ["http://localhost:3000"],
});

await server.start();
console.log("API server running on http://localhost:4820");

// Later:
await server.stop();
```

### Hooks

```typescript
import {
  HookHandler,
  generateHooksConfig,
  writeHooksConfig,
} from "foreman";

// Generate config
const hooksConfig = generateHooksConfig({
  port: 4820,
  apiKey: "my-secret",
});

// Write to .claude/settings.json
await writeHooksConfig("/path/to/project", { port: 4820 });

// Create handler
const handler = new HookHandler({
  policyEngine: new PolicyEngine(config.policy),
  knowledgeStore,
  bus,
});

// Process a hook event
const response = await handler.handle({
  event: "PreToolUse",
  sessionId: "session-abc",
  tool: "Bash",
  input: { command: "npm test" },
});
// → { decision: "allow" }
```

## Integrations

```typescript
import {
  GitHubClient,
  GitHubWatcher,
  SlackClient,
  SlackWatcher,
  LinearClient,
  LinearWatcher,
} from "foreman";

// GitHub
const github = new GitHubClient({
  token: process.env.GITHUB_TOKEN!,
  owner: "my-org",
  repo: "my-repo",
});

await github.createIssue("Bug report", "Description...", ["bug"]);

const watcher = new GitHubWatcher({
  client: github,
  watchLabels: ["agent-ready"],
  watchState: "open",
});

const tasks = await watcher.fetchReadyIssues();

// Slack
const slack = new SlackClient({
  botToken: process.env.SLACK_BOT_TOKEN!,
});

await slack.postMessage("#eng-agents", "Task completed!");
```

## Type Exports

All types are exported for TypeScript usage:

```typescript
import type {
  // Config
  ForemanConfig,
  ForemanGlobalConfig,
  ModelConfig,
  RoutingConfig,
  SandboxConfig,
  PolicyConfig,
  ApiConfig,

  // Models
  ChatRequest,
  ChatResponse,
  ModelCapabilities,
  CostProfile,
  ProviderHealth,
  StreamEvent,

  // Tasks
  AgentTask,
  AgentSession,
  TaskComplexity,
  RoutingDecision,

  // Policy
  PolicyDecision,

  // Events
  ForemanEvent,
  TokenUsage,

  // Autopilot
  AutopilotConfig,
  ReviewFinding,
} from "foreman";
```
