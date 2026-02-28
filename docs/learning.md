# Learning System

The learning system enables cross-session knowledge accumulation. Foreman gets smarter over time by recording lessons, tracking failure patterns, and maintaining project conventions.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Learning Layer                            │
│                                                              │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  KnowledgeStore  │  │ AgentsMd     │  │   Skills     │   │
│  │                  │  │ Manager      │  │  Registry    │   │
│  │  Lessons         │  │              │  │              │   │
│  │  Failures        │  │  AGENTS.md   │  │  Built-in    │   │
│  │  Model prefs     │  │  conventions │  │  Custom      │   │
│  │  Dedup index     │  │  auto-gen    │  │  Matching    │   │
│  └────────┬─────────┘  └──────┬───────┘  └──────┬───────┘   │
│           │                   │                  │           │
│           └───────────────────┼──────────────────┘           │
│                               │                              │
│                     ┌─────────▼─────────┐                    │
│                     │ PromptEnrichment   │                    │
│                     │                   │                    │
│                     │ lessons[]         │                    │
│                     │ conventions       │                    │
│                     │ activeSkills[]    │                    │
│                     └─────────┬─────────┘                    │
│                               │                              │
│                     ┌─────────▼─────────┐                    │
│                     │  System Prompt    │                    │
│                     │  (enriched)       │                    │
│                     └───────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

## KnowledgeStore

Persistent cross-session learning. Stores in `~/.foreman/knowledge.json`.

### What It Learns

| Category | Source | Example |
|----------|--------|---------|
| **Patterns** | Successful sessions | "Use `vitest` for testing in this project" |
| **Anti-patterns** | Failed sessions | "Don't use `fs.writeFileSync` in async contexts" |
| **Conventions** | Code analysis | "This project uses 2-space indentation" |
| **Preferences** | User feedback | "Always use TypeScript strict mode" |
| **Tool tips** | Usage patterns | "Run `npm test` before committing" |

### Learning from Sessions

After each agent session completes, the knowledge store extracts lessons:

```typescript
await knowledgeStore.learnFromSession({
  taskId: "task-1",
  taskTitle: "Fix login bug",
  taskLabels: ["bug", "auth"],
  toolCalls: session.toolCalls,
  filesChanged: session.filesChanged,
  result: session.result,
  success: session.status === "completed",
  modelKey: "coder",
  durationMs: session.durationMs,
  tokenUsage: session.tokenUsage,
});
```

**What it extracts**:
- File patterns and naming conventions
- Test frameworks used
- Build and lint commands
- Common error recovery strategies
- Model performance per task type

### Learning from Autopilot

Autopilot findings are also fed into the knowledge store:

```typescript
await knowledgeStore.learnFromFindings(findings);
```

Findings are deduplicated by fingerprint to avoid storing the same lesson twice.

### Learning from Users

Direct user feedback:

```typescript
await knowledgeStore.learnFromUser(
  "Always run prettier before committing",
  "preference"
);
```

### Failure Tracking

Failed sessions are recorded with context to prevent repeat failures:

```typescript
knowledgeStore.recordFailure({
  taskTitle: "Deploy to production",
  error: "Missing DEPLOY_KEY environment variable",
  toolName: "run_command",
  toolInput: { command: "deploy.sh" },
  modelKey: "coder",
});
```

### Querying Knowledge

Knowledge is queried per-task to build prompt enrichment:

```typescript
// Get relevant lessons for a task
const lessons = knowledgeStore.getLessonsForTask({
  title: "Add OAuth support",
  labels: ["feature", "auth"],
});
// → [
//   { text: "This project uses passport.js for auth", confidence: 0.9 },
//   { text: "Auth tests are in tests/auth/", confidence: 0.8 },
// ]

// Get failure patterns to avoid
const failures = knowledgeStore.getFailuresForTask({
  title: "Add OAuth support",
  labels: ["feature", "auth"],
});

// Get preferred model for task type
const model = knowledgeStore.getPreferredModel("bug");
// → "coder" (historically best for bug tasks)

// Build the full prompt section
const promptSection = knowledgeStore.buildPromptSection(task);
// → "From past experience:\n- Use vitest for testing\n- ..."
```

### Storage Format

```json
{
  "lessons": [
    {
      "id": "lesson-abc123",
      "text": "Use vitest for testing in this project",
      "category": "convention",
      "confidence": 0.85,
      "source": "session",
      "taskLabels": ["testing"],
      "createdAt": "2025-01-15T10:00:00Z",
      "usedCount": 5
    }
  ],
  "failures": [
    {
      "id": "fail-def456",
      "taskTitle": "Deploy to production",
      "error": "Missing DEPLOY_KEY",
      "toolName": "run_command",
      "modelKey": "coder",
      "timestamp": "2025-01-15T11:00:00Z"
    }
  ],
  "modelPreferences": {
    "bug": { "coder": 8, "architect": 2 },
    "feature": { "architect": 5, "coder": 5 }
  },
  "seenFingerprints": ["fp-abc", "fp-def"]
}
```

---

## AGENTS.md Manager

Reads and generates `AGENTS.md` files — the project-level instruction set for AI agents.

### Search Paths

The manager looks for `AGENTS.md` in these locations (first found wins):

1. `./AGENTS.md`
2. `./.github/AGENTS.md`
3. `./docs/AGENTS.md`
4. `./.foreman/AGENTS.md`

### File Format

```markdown
# AGENTS.md

## Project Overview
This is a TypeScript web application using Next.js 14.

## Code Style
- Use 2-space indentation
- No semicolons (Prettier handles this)
- Prefer `const` over `let`
- Use named exports, not default exports

## Testing
- Framework: Vitest
- Run tests: `npm test`
- Test files: `*.test.ts` next to source files
- Minimum coverage: 80%

## Common Patterns
- All API routes are in `src/app/api/`
- Use Zod for input validation
- Database queries go through Prisma

## Pitfalls
- Don't modify `package-lock.json` directly
- The CI requires all tests to pass before merge
- Environment variables are in `.env.local` (not `.env`)
```

### Auto-Generation

If no `AGENTS.md` exists, the manager can generate one from codebase analysis:

```typescript
const agentsMd = new AgentsMdManager({ provider: architectModel });

// Try to load existing file
const conventions = await agentsMd.load("/path/to/project");

if (!conventions) {
  // Auto-generate from codebase analysis
  const generated = await agentsMd.generate("/path/to/project");
  // Analyzes: file structure, package.json, tsconfig, lint config, etc.
}
```

The generator uses an architect model to analyze the codebase and produce a comprehensive AGENTS.md.

### Prompt Integration

```typescript
const promptSection = agentsMd.buildPromptSection();
// → "Project Conventions (from AGENTS.md):\n..."
```

This is injected into the system prompt so agents follow project-specific conventions.

### Caching

The manager caches the loaded AGENTS.md content. Call `invalidateCache()` if the file changes during a session.

---

## Skills Registry

An extensible system for composable agent capabilities.

### What's a Skill?

A skill is a named capability bundle containing:
- **Triggers**: Keywords that activate the skill
- **Prompt template**: Instructions injected into the system prompt
- **Tools**: Additional tool definitions (optional)
- **Tags**: Categorization metadata

```typescript
interface Skill {
  name: string;
  description: string;
  triggers: string[];        // Keywords to match
  promptTemplate: string;    // Added to system prompt
  tools: ToolDefinition[];   // Extra tools for this skill
  tags: string[];
  source: "builtin" | "custom";
}
```

### Built-in Skills

| Skill | Triggers | Description |
|-------|----------|-------------|
| `code-review` | `review`, `audit`, `inspect` | Systematic code review with checklist |
| `refactor` | `refactor`, `restructure`, `clean` | Safe refactoring methodology |
| `test-writing` | `test`, `spec`, `coverage` | Test creation best practices |
| `bug-fix` | `bug`, `fix`, `debug`, `issue` | Debugging methodology |
| `feature-implementation` | `feature`, `implement`, `build`, `add` | Feature implementation workflow |
| `migration` | `migrate`, `upgrade`, `convert` | Migration strategy and execution |
| `security-fix` | `security`, `vulnerability`, `cve` | Security-focused remediation |

### Skill Matching

Skills are matched to tasks by keyword overlap with the task title, description, and labels:

```typescript
const registry = new SkillsRegistry();

const matched = registry.matchSkills({
  title: "Fix XSS vulnerability in user input",
  description: "...",
  labels: ["security", "bug"],
});
// → [security-fix, bug-fix]  (matched by triggers)
```

### Custom Skills

Add custom skills by placing JSON files in `.foreman/skills/`:

```json
// .foreman/skills/deploy.json
{
  "name": "deploy",
  "description": "Deploy application to production",
  "triggers": ["deploy", "release", "ship"],
  "promptTemplate": "When deploying:\n1. Run all tests first\n2. Build the production bundle\n3. Deploy to staging, verify\n4. Deploy to production\n5. Monitor for 10 minutes",
  "tools": [
    {
      "name": "deploy_staging",
      "description": "Deploy to staging environment",
      "inputSchema": {
        "type": "object",
        "properties": {
          "version": { "type": "string", "description": "Version tag" }
        },
        "required": ["version"]
      }
    }
  ],
  "tags": ["devops", "deployment"]
}
```

Load custom skills:

```typescript
await registry.loadFromDirectory("/path/to/project/.foreman/skills");
```

### Prompt Integration

Matched skills are injected into the system prompt:

```typescript
const promptSection = registry.buildPromptSection(matchedSkills);
// → "Active Skills:\n\n## code-review\nWhen reviewing code:\n1. ..."

const extraTools = registry.collectTools(matchedSkills);
// → [{ name: "deploy_staging", ... }]
```

### Registry API

```typescript
const registry = new SkillsRegistry();

// Register a custom skill
registry.register({
  name: "my-skill",
  description: "...",
  triggers: ["keyword"],
  promptTemplate: "...",
  tools: [],
  tags: [],
  source: "custom",
});

// Get a skill by name
const skill = registry.get("code-review");

// Get all skills
const all = registry.getAll();

// Unregister
registry.unregister("my-skill");
```

---

## Learning Loop

The complete learning loop ties all three systems together:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Task arrives │────→│ Match Skills │────→│ Load AGENTS.md│
└─────────────┘     └──────┬───────┘     └──────┬───────┘
                           │                     │
                    ┌──────▼─────────────────────▼───────┐
                    │        Query KnowledgeStore         │
                    │  getLessonsForTask()                 │
                    │  getFailuresForTask()                │
                    │  getPreferredModel()                 │
                    └──────────────────┬─────────────────┘
                                       │
                    ┌──────────────────▼─────────────────┐
                    │        Build PromptEnrichment       │
                    │  { lessons, conventions, skills }   │
                    └──────────────────┬─────────────────┘
                                       │
                    ┌──────────────────▼─────────────────┐
                    │        Agent Executes Task          │
                    └──────────────────┬─────────────────┘
                                       │
                    ┌──────────────────▼─────────────────┐
                    │     Learn from Session Results      │
                    │  learnFromSession()                  │
                    │  recordFailure() (if failed)        │
                    └────────────────────────────────────┘
                                       │
                              ┌────────▼────────┐
                              │  Next task gets  │
                              │  better prompts  │
                              └─────────────────┘
```
