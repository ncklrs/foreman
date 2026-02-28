import { describe, it, expect, afterEach } from "vitest";
import { SandboxManager } from "../src/sandbox/manager.js";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("SandboxManager (local mode)", () => {
  const sandboxes: string[] = [];
  let manager: SandboxManager;

  afterEach(async () => {
    if (manager) {
      await manager.destroyAll();
    }
  });

  it("should initialize with a warm pool", async () => {
    manager = new SandboxManager({
      type: "local",
      warmPool: 2,
      timeoutMinutes: 10,
      cleanup: "always",
    });

    await manager.initialize();
    const status = manager.getStatus();
    expect(status.warm).toBe(2);
    expect(status.active).toBe(0);
    expect(status.total).toBe(2);
  });

  it("should acquire a sandbox from the warm pool", async () => {
    manager = new SandboxManager({
      type: "local",
      warmPool: 1,
      timeoutMinutes: 10,
      cleanup: "always",
    });

    await manager.initialize();
    const sandbox = await manager.acquire({ taskId: "test-1" });

    expect(sandbox.id).toBeTruthy();
    expect(sandbox.type).toBe("local");
    expect(sandbox.status).toBe("in_use");
    expect(sandbox.taskId).toBe("test-1");
    expect(existsSync(sandbox.workingDir)).toBe(true);

    const status = manager.getStatus();
    expect(status.active).toBe(1);
  });

  it("should create a sandbox on-demand when warm pool is empty", async () => {
    manager = new SandboxManager({
      type: "local",
      warmPool: 0,
      timeoutMinutes: 10,
      cleanup: "always",
    });

    await manager.initialize();
    const sandbox = await manager.acquire({ taskId: "test-2" });

    expect(sandbox.id).toBeTruthy();
    expect(sandbox.status).toBe("in_use");
    expect(existsSync(sandbox.workingDir)).toBe(true);
  });

  it("should release a sandbox and collect artifacts", async () => {
    manager = new SandboxManager({
      type: "local",
      warmPool: 0,
      timeoutMinutes: 10,
      cleanup: "always",
    });

    await manager.initialize();
    const sandbox = await manager.acquire({ taskId: "test-3" });

    // Write a file in the sandbox
    await writeFile(join(sandbox.workingDir, "test.txt"), "hello\n");

    const artifacts = await manager.release(sandbox.id, false);
    // Without git, artifacts should be empty
    expect(Array.isArray(artifacts)).toBe(true);
  });

  it("should destroy all sandboxes", async () => {
    manager = new SandboxManager({
      type: "local",
      warmPool: 2,
      timeoutMinutes: 10,
      cleanup: "always",
    });

    await manager.initialize();
    const s1 = await manager.acquire({ taskId: "t1" });
    const s2 = await manager.acquire({ taskId: "t2" });

    await manager.destroyAll();

    const status = manager.getStatus();
    expect(status.active).toBe(0);
    expect(status.warm).toBe(0);
    expect(status.total).toBe(0);
  });

  it("should throw when releasing unknown sandbox", async () => {
    manager = new SandboxManager({
      type: "local",
      warmPool: 0,
      timeoutMinutes: 10,
      cleanup: "always",
    });

    await manager.initialize();
    await expect(manager.release("nonexistent")).rejects.toThrow("Sandbox not found");
  });
});
