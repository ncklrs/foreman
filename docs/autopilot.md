# Autopilot

Autopilot is a self-driving codebase health system. It scans your repository on a schedule, identifies issues, creates tickets, and optionally spawns agents to auto-fix them.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     AutopilotEngine                           │
│                                                              │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │ Scheduler │───→│   Reviewer   │───→│ TicketCreator│       │
│  │  (cron)   │    │  (scanners)  │    │              │       │
│  └──────────┘    └──────┬───────┘    └──────┬───────┘       │
│                         │                    │               │
│                   ┌─────▼─────┐        ┌────▼─────┐         │
│                   │ Findings  │        │  Tickets │         │
│                   │ (scored)  │        │ (GitHub/ │         │
│                   └─────┬─────┘        │  Linear) │         │
│                         │              └────┬─────┘         │
│                         │                   │               │
│                   ┌─────▼───────────────────▼─────┐         │
│                   │     Auto-Resolver              │         │
│                   │  (spawns agents to fix)         │         │
│                   └────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────┘
```

## Configuration

```toml
[autopilot]
enabled = true
schedule = "0 9 * * 1-5"          # 9 AM weekdays
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
| `enabled` | boolean | `false` | Activate autopilot. |
| `schedule` | string | Required | 5-field cron expression. |
| `timezone` | string | `"UTC"` | Timezone for schedule. |
| `scanners` | string[] | Required | Scanners to run each cycle. |
| `max_tickets_per_run` | number | `5` | Cap tickets per scan. |
| `auto_resolve` | boolean | `false` | Spawn agents to fix findings. |
| `max_concurrent_resolves` | number | `2` | Parallel fix agents. |
| `min_severity` | number | `1` | Minimum severity (1-5) to act on. |
| `ticket_target` | `"github"` \| `"linear"` | Required | Where to create tickets. |
| `ticket_labels` | string[] | `[]` | Labels added to created tickets. |
| `branch_prefix` | string | `"autopilot/"` | Branch prefix for auto-fix work. |
| `working_dir` | string | `"."` | Directory to scan. |

## Three-Phase Pipeline

### Phase 1: Scan

The `Reviewer` runs configured scanners against the codebase.

```
Codebase Context (gathered automatically):
├── File tree (top-level structure)
├── package.json (dependencies, scripts)
├── tsconfig.json (TypeScript config)
├── Recent git commits (last 20)
└── Sample source files (first 3 .ts/.js files)

Each scanner gets:
├── Tailored system prompt
├── Full codebase context
└── Scanner-specific analysis instructions
```

The reviewer sends the context to an LLM (using the `reviewer` model or `architect` fallback) and parses the response into structured findings.

### Phase 2: Create Tickets

The `TicketCreator` converts findings into issues:

1. Fetches existing open issues to prevent duplicates (title matching)
2. Filters findings by `min_severity`
3. Creates tickets up to `max_tickets_per_run`
4. Formats each ticket with:
   - Title: `"[{Scanner}] {Finding title}"`
   - Description with location, severity, suggested fix
   - Labels: configured labels + priority/effort labels
   - Story points (Linear): `trivial=1, small=2, medium=5, large=8`

### Phase 3: Auto-Resolve (Optional)

If `auto_resolve = true`, agents are spawned to fix findings:

1. Create a branch: `{branch_prefix}{finding-slug}`
2. Spawn an agent with the finding description as the task
3. Agent works in a sandbox to implement the fix
4. If successful, create a PR linking to the ticket

## Scanners

### `security`

Scans for security vulnerabilities:
- Hardcoded secrets and credentials
- SQL injection potential
- XSS vulnerabilities
- Insecure crypto usage
- Missing input validation
- OWASP Top 10 patterns

### `dependencies`

Analyzes dependency health:
- Known vulnerabilities (CVE references)
- Outdated major versions
- Unused dependencies
- Duplicate dependencies
- License compatibility issues

### `code_quality`

Checks code quality metrics:
- Functions exceeding complexity thresholds
- Dead code and unused exports
- Inconsistent patterns
- Missing error handling
- Code duplication

### `test_coverage`

Evaluates test health:
- Files with no test coverage
- Critical paths without tests
- Stale or flaky tests
- Test-to-code ratio
- Missing edge case coverage

### `performance`

Identifies performance issues:
- N+1 query patterns
- Memory leaks
- Unnecessary re-renders (React)
- Missing pagination
- Large bundle sizes
- Unoptimized database queries

### `documentation`

Reviews documentation:
- Undocumented public APIs
- Outdated README sections
- Missing JSDoc/TSDoc
- Broken internal links
- Missing changelog entries

### `dead_code`

Finds unused code:
- Unused exports
- Unreachable code paths
- Commented-out code blocks
- Deprecated functions still present
- Unused type definitions

### `type_safety`

Checks TypeScript type safety:
- `any` type usage
- Missing return types
- Unchecked null/undefined
- Type assertion overuse
- Missing generic constraints

## Findings

Each scanner produces findings with this structure:

```typescript
interface ReviewFinding {
  title: string;           // Short description
  description: string;     // Detailed explanation
  severity: 1 | 2 | 3 | 4 | 5;  // 1=info, 5=critical
  location?: string;       // File path and line
  suggestion?: string;     // Recommended fix
  effort: "trivial" | "small" | "medium" | "large";
  scanner: string;         // Which scanner found it
  fingerprint: string;     // Dedup key
}
```

### Severity Scale

| Level | Name | Action |
|-------|------|--------|
| 1 | Info | Log only, no ticket |
| 2 | Low | Ticket if time allows |
| 3 | Medium | Standard ticket |
| 4 | High | Priority ticket |
| 5 | Critical | Immediate attention |

### Deduplication

Findings are deduplicated using fingerprints:
- Same scanner + same title + same location = same finding
- The [KnowledgeStore](learning.md) tracks seen fingerprints across runs
- Repeat findings within the same run are merged

## Scheduling

### Cron Syntax

Standard 5-field cron format:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

**Supported syntax**:
- `*` — Every value
- `5` — Specific value
- `1-5` — Range
- `*/15` — Step
- `1,3,5` — List

### Examples

| Schedule | Meaning |
|----------|---------|
| `0 9 * * 1-5` | 9 AM weekdays |
| `0 */6 * * *` | Every 6 hours |
| `30 2 * * 0` | 2:30 AM Sundays |
| `0 0 1 * *` | Midnight on the 1st of each month |
| `*/30 * * * *` | Every 30 minutes |

### Safety

- The scheduler prevents double-execution in the same minute
- If a scan is still running when the next trigger fires, it's skipped

## CLI Usage

```bash
# Continuous autopilot with cron schedule
foreman --autopilot

# Single scan, run immediately, then exit
foreman --autopilot-once --no-tui

# Autopilot + watch mode (scan AND handle incoming tasks)
foreman --autopilot --watch

# Autopilot with API for monitoring
foreman --autopilot --api
```

## Cross-Run Learning

The autopilot integrates with the [Learning System](learning.md):

1. **Finding deduplication**: KnowledgeStore tracks fingerprints to avoid re-reporting known issues
2. **Fix patterns**: When auto-resolve succeeds, the fix pattern is stored as a lesson
3. **Scanner tuning**: Failure patterns from past scans inform future analysis

```
Run 1: Finds "Missing input validation in /api/users"
        → Creates ticket, attempts fix, succeeds
        → Lesson stored: "Always validate req.body in Express routes"

Run 2: Finds "Missing input validation in /api/posts"
        → Already has lesson → Agent applies known pattern
        → Fix is faster and more consistent
```

## Events

Autopilot emits events at each phase:

| Event | When |
|-------|------|
| `autopilot:scan_started` | Scan begins |
| `autopilot:scan_completed` | Scan finishes with findings |
| `autopilot:ticket_created` | Ticket created on GitHub/Linear |
| `autopilot:resolve_started` | Auto-fix agent spawned |
| `autopilot:resolve_completed` | Auto-fix finished |
| `autopilot:run_completed` | Entire run finished |

Subscribe to these via the [Event Bus](events.md) or [WebSocket API](api.md#websocket).
