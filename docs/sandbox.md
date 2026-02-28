# Sandbox Environments

Sandboxes provide isolated execution environments for agent sessions, preventing agents from modifying the host system directly.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                  SandboxManager                         │
│                                                        │
│  ┌──────────────────────────────────────────────┐      │
│  │              Warm Pool                        │      │
│  │  ┌─────┐  ┌─────┐  ┌─────┐                  │      │
│  │  │ sb1 │  │ sb2 │  │ sb3 │  (pre-created)   │      │
│  │  │ready│  │ready│  │ready│                   │      │
│  │  └─────┘  └─────┘  └─────┘                  │      │
│  └──────────────────────────────────────────────┘      │
│                                                        │
│  acquire() ──→ Pop from pool ──→ Set up working dir    │
│                (or create new)    Clone repo if needed  │
│                                   Start timeout timer  │
│                                                        │
│  release() ──→ Collect artifacts ──→ Clean up          │
│                (git diff, logs)      Replenish pool    │
│                                                        │
│  ┌──────────────────────────────────────────────┐      │
│  │            Active Sandboxes                   │      │
│  │  ┌─────┐  ┌─────┐                           │      │
│  │  │ sb4 │  │ sb5 │  (in use by agents)        │      │
│  │  │in_use│ │in_use│                           │      │
│  │  └─────┘  └─────┘                           │      │
│  └──────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────┘
```

## Configuration

```toml
[sandbox]
type = "docker"          # or "local"
warm_pool = 3            # Pre-warmed instances
timeout_minutes = 30     # Auto-kill timeout
cleanup = "on_success"   # When to destroy
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"docker"` \| `"local"` | `"local"` | Isolation level. |
| `warm_pool` | number | `1` | Pre-warmed sandboxes ready for immediate use. |
| `timeout_minutes` | number | `30` | Max lifetime before force-kill. |
| `cleanup` | `"on_success"` \| `"always"` \| `"never"` | `"on_success"` | Cleanup policy. |

### Cloud Sandboxes

```toml
[sandbox.cloud]
provider = "fly"         # or "daytona"
app = "foreman-sandboxes"
region = "iad"
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `"fly"` \| `"daytona"` | Cloud sandbox provider. |
| `app` | string | App/project name on the provider. |
| `region` | string | Deployment region. |

## Sandbox Types

### Local Sandboxes

The simplest option. Creates temporary directories on the host filesystem.

```
/tmp/foreman-abc123-1709000000/
├── .git/
├── src/
├── package.json
└── ...
```

**Pros**:
- No Docker required
- Fastest startup
- Direct filesystem access

**Cons**:
- No true isolation (shares host resources)
- Agents can access host paths if not careful

**Best for**: Development, trusted environments, CI runners.

### Docker Sandboxes

Full container isolation. Each agent gets its own container.

```
Container: foreman-sandbox-abc123
├── Image: node:20-slim
├── Memory: 2GB
├── CPUs: 2
├── Workdir: /workspace
├── Volumes:
│   └── /var/run/docker.sock (for Docker-in-Docker)
└── Tools: git, ripgrep
```

**Pros**:
- Full isolation (filesystem, network, process)
- Reproducible environments
- Resource limits (memory, CPU)
- Can safely run untrusted code

**Cons**:
- Docker required
- Slower startup (~2-5s per container)
- Higher resource overhead

**Best for**: Production, untrusted tasks, multi-tenant setups.

### Cloud Sandboxes

Remote sandboxes on Fly.io or Daytona. Foreman manages the lifecycle.

**Best for**: Teams without local Docker, scaling beyond one machine.

## Lifecycle

### 1. Initialization

On startup, the manager pre-creates the warm pool:

```typescript
const manager = new SandboxManager({
  type: "docker",
  warmPool: 3,
  timeoutMinutes: 30,
  cleanup: "on_success",
});

await manager.initialize();
// Creates 3 Docker containers in the warm pool
```

### 2. Acquire

When a task starts, a sandbox is acquired from the pool:

```typescript
const sandbox = await manager.acquire({
  taskId: "task-1",
  repoUrl: "https://github.com/org/repo.git",
  branch: "main",
});

// sandbox.id = "sandbox-abc123"
// sandbox.workingDir = "/workspace" (Docker) or "/tmp/foreman-..." (local)
// sandbox.status = "in_use"
```

**What happens**:
1. Pop a sandbox from the warm pool (or create a new one)
2. Clone the repository if `repoUrl` is specified
3. Check out the specified branch
4. Set sandbox status to `in_use`
5. Start the timeout timer
6. Replenish the warm pool in the background

### 3. Execute

The agent runs tools inside the sandbox working directory. All file operations and commands are scoped to the sandbox.

### 4. Release

When the task completes or fails:

```typescript
const artifacts = await manager.release(sandbox.id, true);
// artifacts = {
//   diff: "diff --git a/src/app.ts ...",
//   log: "abc123 Fix login bug"
// }
```

**What happens**:
1. Collect artifacts (git diff, latest commit)
2. Apply cleanup policy:
   - `"on_success"`: Destroy only if task succeeded
   - `"always"`: Always destroy
   - `"never"`: Keep for debugging
3. Destroy the sandbox (remove temp dir or kill container)
4. Replenish the warm pool

### 5. Shutdown

On graceful shutdown (SIGINT/SIGTERM):

```typescript
await manager.destroyAll();
// Kills all active sandboxes and warm pool containers
```

## Timeout Enforcement

Each sandbox has a configurable timeout:

```
┌─ Sandbox acquired (t=0)
│
│  Agent working...
│
├─ 25 minutes elapsed
│  (no timeout yet)
│
├─ 30 minutes elapsed
│  TIMEOUT! Auto-release triggered
│  → Artifacts collected
│  → Sandbox destroyed
│  → Agent session marked as failed
└─
```

The timeout timer runs as a non-blocking background `setTimeout`. It automatically releases and destroys the sandbox if the agent exceeds the time limit.

## Repository Cloning

When acquiring a sandbox with a repository URL:

```typescript
await manager.acquire({
  taskId: "task-1",
  repoUrl: "https://github.com/org/repo.git",
  branch: "feature/fix-login",
});
```

**Local sandbox**: Runs `git clone --depth 1 --branch feature/fix-login <url> <tmpdir>`

**Docker sandbox**: Runs the clone inside the container via `docker exec`

Shallow clones (`--depth 1`) are used by default for speed.

## Artifact Collection

When releasing a sandbox, artifacts are collected automatically:

| Artifact | Command | Purpose |
|----------|---------|---------|
| `diff` | `git diff HEAD` | Captures all uncommitted changes |
| `log` | `git log --oneline --no-walk HEAD` | Captures the latest commit info |

Artifacts are stored in the session record and available via the [API](api.md).

## Status Reporting

```typescript
const status = manager.getStatus();
// {
//   active: 2,      // In-use sandboxes
//   warm: 1,        // Ready in pool
//   total: 3        // All managed sandboxes
// }
```

## Programmatic Usage

```typescript
import { SandboxManager } from "foreman";

const manager = new SandboxManager({
  type: "local",
  warmPool: 2,
  timeoutMinutes: 15,
  cleanup: "always",
});

await manager.initialize();

// Acquire a sandbox
const sandbox = await manager.acquire({ taskId: "my-task" });

// Use sandbox.workingDir for tool execution
console.log(sandbox.workingDir);  // /tmp/foreman-xyz-1709000000

// Release when done
const artifacts = await manager.release(sandbox.id, true);

// Clean up
await manager.destroyAll();
```
