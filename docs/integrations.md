# Integrations

Foreman integrates with external services to automatically ingest tasks and report progress. All integrations follow a **watcher + client** pattern: the watcher polls for new items, and the client posts updates.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Integration Layer                         │
│                                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐   │
│  │    GitHub      │  │    Linear     │  │    Slack      │   │
│  │               │  │               │  │               │   │
│  │  ┌─────────┐  │  │  ┌─────────┐  │  │  ┌─────────┐  │   │
│  │  │ Watcher │  │  │  │ Watcher │  │  │  │ Watcher │  │   │
│  │  │ (poll)  │  │  │  │ (poll)  │  │  │  │ (poll)  │  │   │
│  │  └────┬────┘  │  │  └────┬────┘  │  │  └────┬────┘  │   │
│  │       │       │  │       │       │  │       │       │   │
│  │  ┌────▼────┐  │  │  ┌────▼────┐  │  │  ┌────▼────┐  │   │
│  │  │ Client  │  │  │  │ Client  │  │  │  │ Client  │  │   │
│  │  │ (API)   │  │  │  │ (API)   │  │  │  │ (API)   │  │   │
│  │  └─────────┘  │  │  └─────────┘  │  │  └─────────┘  │   │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘   │
│          │                  │                   │           │
│          └──────────────────┼───────────────────┘           │
│                             │                               │
│                       ┌─────▼─────┐                         │
│                       │  Foreman   │                         │
│                       │ Task Queue │                         │
│                       └───────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

## GitHub

Watch GitHub issues for agent-ready tasks. Report progress via comments.

### Configuration

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
| `watch_state` | string | No | Issue state filter: `"open"`, `"closed"`, or `"all"`. Default: `"open"`. |

### How It Works

**Watcher** (`GitHubWatcher`):
1. Polls GitHub Issues API every 30 seconds
2. Filters issues by `watch_labels` and `watch_state`
3. Converts matching issues to `AgentTask` objects:
   - `title` → issue title
   - `description` → issue body
   - `labels` → issue labels
   - `source` → `"github"`
   - `sourceId` → issue number
4. Skips issues already seen in the current session

**Client** (`GitHubClient`):
- `addComment(issueNumber, body)` — Post progress updates or results
- `addLabels(issueNumber, labels)` — Tag issues (e.g., `"in-progress"`, `"completed"`)
- `removeLabel(issueNumber, label)` — Remove labels (e.g., remove `"agent-ready"` after pickup)
- `closeIssue(issueNumber)` — Close issue on completion
- `linkPR(issueNumber, prUrl)` — Add PR link to issue comment
- `createIssue(title, body, labels)` — Create new issues (used by [autopilot](autopilot.md))

### Required Token Scopes

- `repo` — Full control of private repositories
- Or `public_repo` — For public repositories only

### Task Flow

```
GitHub Issue                    Foreman
─────────────                   ───────
User creates issue
  with label "agent-ready"
            │
            ├──── Watcher polls ────→ New task detected
            │                        │
            │  ←── Remove label ─────┤ Remove "agent-ready"
            │  ←── Add label ────────┤ Add "in-progress"
            │  ←── Comment ──────────┤ "Agent picked up task"
            │                        │
            │                        │  Agent executes...
            │                        │
            │  ←── Comment ──────────┤ "Task completed. PR: #42"
            │  ←── Add label ────────┤ Add "completed"
            │  ←── Close issue ──────┤
            ▼                        ▼
```

---

## Linear

Watch Linear issues for agent-ready tasks. Update status and post comments.

### Configuration

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

### How It Works

**Watcher** (`LinearWatcher`):
1. Polls Linear API (GraphQL) every 30 seconds
2. Queries issues with matching team, labels, and status
3. Converts to `AgentTask`:
   - `title` → issue title
   - `description` → issue description
   - `labels` → issue labels
   - `estimate` → story points (used for [complexity scoring](routing.md#complexity-scoring))
   - `source` → `"linear"`
   - `sourceId` → issue identifier

**Client** (`LinearClient`):
- `updateIssue(issueId, fields)` — Update status, assignee, etc.
- `addComment(issueId, body)` — Post progress or results
- `createIssue(teamId, title, body, labels, estimate)` — Create issues (used by autopilot)

### Task Flow

```
Linear Issue                    Foreman
────────────                    ───────
Issue moves to "Todo"
  with label "agent-ready"
            │
            ├──── Watcher polls ────→ New task detected
            │                        │
            │  ←── Status update ────┤ Move to "In Progress"
            │  ←── Comment ──────────┤ "Agent started"
            │                        │
            │                        │  Agent executes...
            │                        │
            │  ←── Comment ──────────┤ "Completed. PR: #42"
            │  ←── Status update ────┤ Move to "Done"
            ▼                        ▼
```

---

## Slack

Listen for task-triggering messages in Slack channels.

### Configuration

```toml
[slack]
bot_token = "${SLACK_BOT_TOKEN}"
watch_channels = ["#eng-agents"]
trigger_prefix = "!agent"
post_progress = true
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bot_token` | string | Yes | Slack Bot User OAuth Token (`xoxb-...`). |
| `watch_channels` | string[] | Yes | Channel names to monitor. |
| `trigger_prefix` | string | No | Message prefix to trigger tasks. Default: `"!agent"`. |
| `post_progress` | boolean | No | Post progress updates in thread. Default: `true`. |

### How It Works

**Watcher** (`SlackWatcher`):
1. Polls Slack `conversations.history` API every 10 seconds
2. Filters messages starting with `trigger_prefix`
3. Extracts task from message text (everything after the prefix)
4. Converts to `AgentTask`:
   - `title` → message text (after prefix)
   - `description` → full message text
   - `source` → `"slack"`
   - `sourceId` → message timestamp

**Client** (`SlackClient`):
- `postMessage(channel, text, threadTs?)` — Post to channel or thread
- `postAgentUpdate(channel, threadTs, status, details)` — Formatted progress update
- `addReaction(channel, timestamp, emoji)` — React to messages (e.g., `:eyes:` on pickup)

### Bot Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add Bot Token Scopes:
   - `channels:history` — Read channel messages
   - `channels:read` — List channels
   - `chat:write` — Post messages
   - `reactions:write` — Add reactions
3. Install the app to your workspace
4. Invite the bot to the watch channels

### Task Flow

```
Slack Channel                   Foreman
─────────────                   ───────
User posts:
  "!agent Fix the login bug"
            │
            ├──── Watcher polls ────→ New task detected
            │                        │
            │  ←── Reaction 👀 ──────┤ Acknowledge pickup
            │  ←── Thread reply ─────┤ "Working on it..."
            │                        │
            │                        │  Agent executes...
            │                        │
            │  ←── Thread reply ─────┤ "Done! PR: #42"
            │  ←── Reaction ✅ ──────┤
            ▼                        ▼
```

---

## Watch Mode

Start all configured watchers simultaneously:

```bash
foreman --watch
```

Or combine with other modes:

```bash
# Watch + API server
foreman --watch --api

# Watch + Autopilot
foreman --watch --autopilot

# Watch + everything
foreman --watch --autopilot --api --decompose
```

The watchers run continuously until interrupted (Ctrl+C). On shutdown, they gracefully stop polling and allow in-progress agents to complete.

## Adding Custom Integrations

Integrations follow a consistent pattern:

1. **Config type** — TOML-serializable configuration
2. **Client class** — API wrapper with typed methods
3. **Watcher class** — Poll loop that produces `AgentTask` objects

```typescript
// Custom integration example
class JiraWatcher {
  async fetchReadyIssues(): Promise<AgentTask[]> {
    const issues = await this.client.search("label = 'agent-ready'");
    return issues.map(issue => ({
      id: `jira-${issue.key}`,
      title: issue.summary,
      description: issue.description,
      labels: issue.labels,
      source: "jira",
      sourceId: issue.key,
    }));
  }
}
```

Register it with the orchestrator to participate in watch mode.
