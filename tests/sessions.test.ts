import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../src/storage/sessions.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSession } from "../src/types/index.js";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    task: {
      id: "task_1",
      title: "Test task",
      description: "A test task",
    },
    status: "completed",
    modelName: "test-model",
    messages: [],
    iterations: 5,
    maxIterations: 50,
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:05:00Z"),
    artifacts: [],
    ...overrides,
  };
}

describe("SessionStore", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "foreman-session-test-"));
    store = new SessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("should save and load a session", async () => {
    const session = makeSession({ id: "save_load_test" });
    await store.save(session);

    const loaded = await store.load("save_load_test");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("save_load_test");
    expect(loaded!.status).toBe("completed");
    expect(loaded!.task.title).toBe("Test task");
    expect(loaded!.iterations).toBe(5);
    expect(loaded!.tokenUsage.inputTokens).toBe(100);
  });

  it("should return null for missing session", async () => {
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  it("should load all sessions", async () => {
    const s1 = makeSession({ id: "s1" });
    const s2 = makeSession({ id: "s2" });
    const s3 = makeSession({ id: "s3" });

    await store.save(s1);
    await store.save(s2);
    await store.save(s3);

    const all = await store.loadAll();
    expect(all.length).toBe(3);
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual(["s1", "s2", "s3"]);
  });

  it("should delete a session", async () => {
    const session = makeSession({ id: "to_delete" });
    await store.save(session);

    await store.delete("to_delete");
    const loaded = await store.load("to_delete");
    expect(loaded).toBeNull();
  });

  it("should prune old sessions keeping the newest", async () => {
    // Create 5 completed sessions with different timestamps
    for (let i = 0; i < 5; i++) {
      const session = makeSession({
        id: `prune_${i}`,
        completedAt: new Date(Date.now() - (5 - i) * 60000), // oldest first
      });
      await store.save(session);
    }

    const pruned = await store.prune(2); // keep 2 newest
    expect(pruned).toBe(3);

    const remaining = await store.loadAll();
    expect(remaining.length).toBe(2);
  });

  it("should restore Date objects on deserialization", async () => {
    const session = makeSession({
      id: "date_test",
      startedAt: new Date("2026-02-15T10:00:00Z"),
      completedAt: new Date("2026-02-15T10:30:00Z"),
      artifacts: [{ type: "log", content: "done", createdAt: new Date("2026-02-15T10:25:00Z") }],
    });

    await store.save(session);
    const loaded = await store.load("date_test");

    expect(loaded!.startedAt).toBeInstanceOf(Date);
    expect(loaded!.completedAt).toBeInstanceOf(Date);
    expect(loaded!.artifacts[0].createdAt).toBeInstanceOf(Date);
  });

  it("should handle running sessions in prune (only prune terminal)", async () => {
    const running = makeSession({ id: "running_1", status: "running" });
    const completed = makeSession({ id: "completed_1", status: "completed" });
    const failed = makeSession({ id: "failed_1", status: "failed" });

    await store.save(running);
    await store.save(completed);
    await store.save(failed);

    const pruned = await store.prune(0); // prune ALL terminal sessions
    expect(pruned).toBe(2);

    // Running session should remain
    const remaining = await store.loadAll();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe("running_1");
  });
});
