/**
 * Sandbox Manager.
 * Manages isolated execution environments for agent tasks.
 * Supports Docker-based sandboxes with warm pool, timeout enforcement,
 * and artifact collection.
 */

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import type { AgentArtifact, SandboxConfig } from "../types/index.js";
import { generateId } from "../utils/id.js";

export interface Sandbox {
  id: string;
  type: "docker" | "local";
  workingDir: string;
  containerId?: string;
  status: "ready" | "in_use" | "cleaning" | "destroyed";
  createdAt: Date;
  taskId?: string;
}

interface SandboxOptions {
  repository?: string;
  branch?: string;
  taskId: string;
}

export class SandboxManager {
  private config: SandboxConfig;
  private sandboxes: Map<string, Sandbox> = new Map();
  private warmPool: Sandbox[] = [];

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  /** Initialize the warm pool with pre-built sandboxes. */
  async initialize(): Promise<void> {
    if (this.config.type === "docker") {
      await this.checkDockerAvailable();
    }

    // Pre-create warm pool
    const warmCount = this.config.warmPool;
    for (let i = 0; i < warmCount; i++) {
      try {
        const sandbox = await this.createSandbox();
        this.warmPool.push(sandbox);
      } catch (error) {
        console.warn(
          `Failed to pre-create sandbox ${i + 1}/${warmCount}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  /** Acquire a sandbox for a task. */
  async acquire(options: SandboxOptions): Promise<Sandbox> {
    // Try to get one from the warm pool
    let sandbox = this.warmPool.pop();

    if (!sandbox) {
      sandbox = await this.createSandbox();
    }

    sandbox.status = "in_use";
    sandbox.taskId = options.taskId;
    this.sandboxes.set(sandbox.id, sandbox);

    // Clone repository if specified
    if (options.repository) {
      await this.cloneRepo(sandbox, options.repository, options.branch);
    }

    // Set up timeout
    this.setupTimeout(sandbox);

    // Replenish warm pool in background
    this.replenishWarmPool().catch(() => {});

    return sandbox;
  }

  /** Release a sandbox after task completion. */
  async release(sandboxId: string, collectArtifacts = true): Promise<AgentArtifact[]> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }

    const artifacts: AgentArtifact[] = [];

    if (collectArtifacts) {
      artifacts.push(...(await this.collectArtifacts(sandbox)));
    }

    // Cleanup based on policy
    const prevStatus = sandbox.status;
    sandbox.status = "cleaning";

    const shouldCleanup =
      this.config.cleanup === "always" ||
      (this.config.cleanup === "on_success" && prevStatus !== "destroyed");

    if (shouldCleanup) {
      await this.destroySandbox(sandbox);
    }

    this.sandboxes.delete(sandboxId);
    return artifacts;
  }

  /** Destroy all sandboxes. */
  async destroyAll(): Promise<void> {
    const allSandboxes = [
      ...this.sandboxes.values(),
      ...this.warmPool,
    ];

    await Promise.allSettled(
      allSandboxes.map((s) => this.destroySandbox(s))
    );

    this.sandboxes.clear();
    this.warmPool = [];
  }

  /** Get status of all sandboxes. */
  getStatus(): { active: number; warm: number; total: number } {
    return {
      active: this.sandboxes.size,
      warm: this.warmPool.length,
      total: this.sandboxes.size + this.warmPool.length,
    };
  }

  private async createSandbox(): Promise<Sandbox> {
    const id = generateId("sandbox");

    if (this.config.type === "docker") {
      return this.createDockerSandbox(id);
    }

    return this.createLocalSandbox(id);
  }

  private async createLocalSandbox(id: string): Promise<Sandbox> {
    const workingDir = await mkdtemp(join(tmpdir(), `foreman-${id}-`));

    return {
      id,
      type: "local",
      workingDir,
      status: "ready",
      createdAt: new Date(),
    };
  }

  private async createDockerSandbox(id: string): Promise<Sandbox> {
    // Create a Docker container with the foreman toolkit pre-installed
    const containerName = `foreman-${id}`;

    const createCmd = [
      "docker", "create",
      "--name", containerName,
      "--workdir", "/workspace",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "--memory", "2g",
      "--cpus", "2",
      "node:20-slim",
      "sleep", "infinity",
    ].join(" ");

    await this.execShell(createCmd);
    await this.execShell(`docker start ${containerName}`);

    // Install essential tools inside the container
    await this.execShell(
      `docker exec ${containerName} apt-get update -qq && docker exec ${containerName} apt-get install -y -qq git ripgrep 2>/dev/null`
    ).catch(() => {
      // Some tools may not be installable — that's OK
    });

    return {
      id,
      type: "docker",
      workingDir: "/workspace",
      containerId: containerName,
      status: "ready",
      createdAt: new Date(),
    };
  }

  private async cloneRepo(
    sandbox: Sandbox,
    repository: string,
    branch?: string
  ): Promise<void> {
    const branchArgs = branch ? `--branch ${branch}` : "";

    if (sandbox.type === "docker" && sandbox.containerId) {
      await this.execShell(
        `docker exec ${sandbox.containerId} git clone ${branchArgs} --depth 1 ${repository} /workspace/repo`
      );
      sandbox.workingDir = "/workspace/repo";
    } else {
      const cloneTarget = join(sandbox.workingDir, "repo");
      await this.execShell(
        `git clone ${branchArgs} --depth 1 ${repository} ${cloneTarget}`
      );
      sandbox.workingDir = cloneTarget;
    }
  }

  private async collectArtifacts(sandbox: Sandbox): Promise<AgentArtifact[]> {
    const artifacts: AgentArtifact[] = [];

    try {
      // Collect git diff
      const execFn = sandbox.type === "docker" && sandbox.containerId
        ? (cmd: string) => this.execShell(`docker exec -w ${sandbox.workingDir} ${sandbox.containerId} ${cmd}`)
        : (cmd: string) => this.execShell(cmd, { cwd: sandbox.workingDir });

      const diff = await execFn("git diff HEAD 2>/dev/null || true");
      if (diff.trim()) {
        artifacts.push({
          type: "diff",
          content: diff,
          createdAt: new Date(),
        });
      }

      // Collect git log of changes
      const log = await execFn("git log --oneline --no-walk HEAD 2>/dev/null || true");
      if (log.trim()) {
        artifacts.push({
          type: "log",
          content: log,
          createdAt: new Date(),
        });
      }
    } catch {
      // Artifact collection is best-effort
    }

    return artifacts;
  }

  private async destroySandbox(sandbox: Sandbox): Promise<void> {
    sandbox.status = "destroyed";

    if (sandbox.type === "docker" && sandbox.containerId) {
      await this.execShell(
        `docker rm -f ${sandbox.containerId} 2>/dev/null || true`
      );
    } else if (sandbox.type === "local") {
      await rm(sandbox.workingDir, { recursive: true, force: true }).catch(
        () => {}
      );
    }
  }

  private setupTimeout(sandbox: Sandbox): void {
    const timeoutMs = this.config.timeoutMinutes * 60 * 1000;

    setTimeout(async () => {
      if (sandbox.status === "in_use") {
        console.warn(`Sandbox ${sandbox.id} timed out after ${this.config.timeoutMinutes} minutes`);
        await this.release(sandbox.id, true).catch(() => {});
      }
    }, timeoutMs);
  }

  private async replenishWarmPool(): Promise<void> {
    while (this.warmPool.length < this.config.warmPool) {
      try {
        const sandbox = await this.createSandbox();
        this.warmPool.push(sandbox);
      } catch {
        break;
      }
    }
  }

  private async checkDockerAvailable(): Promise<void> {
    try {
      await this.execShell("docker info");
    } catch {
      throw new Error(
        "Docker is not available. Install Docker or set sandbox.type to 'local' in foreman.toml"
      );
    }
  }

  private execShell(
    command: string,
    options?: { cwd?: string }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        command,
        { maxBuffer: 1024 * 1024 * 10, cwd: options?.cwd, timeout: 120000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`Command failed: ${command}\n${stderr || error.message}`));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }
}
