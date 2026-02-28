import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskGraph, type SubTask } from "../src/orchestration/graph.js";
import { TaskDecomposer } from "../src/orchestration/decomposer.js";
import type { AgentTask } from "../src/types/index.js";

// ── TaskGraph Tests ─────────────────────────────────────────────

describe("TaskGraph", () => {
  function makeTask(overrides: Partial<SubTask> = {}): SubTask {
    return {
      id: `task_${Math.random().toString(36).slice(2, 6)}`,
      title: "Test task",
      description: "Test description",
      dependsOn: [],
      status: "pending",
      ...overrides,
    };
  }

  describe("addTask", () => {
    it("should add tasks to the graph", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.addTask(makeTask({ id: "b" }));
      expect(graph.size()).toBe(2);
    });

    it("should reject duplicate IDs", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "dup" }));
      expect(() => graph.addTask(makeTask({ id: "dup" }))).toThrow("Duplicate");
    });
  });

  describe("getTask", () => {
    it("should retrieve tasks by ID", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "find_me", title: "Found" }));
      expect(graph.getTask("find_me")?.title).toBe("Found");
    });

    it("should return undefined for missing tasks", () => {
      const graph = new TaskGraph();
      expect(graph.getTask("missing")).toBeUndefined();
    });
  });

  describe("getReadyTasks", () => {
    it("should return tasks with no dependencies", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: [] }));

      const ready = graph.getReadyTasks();
      expect(ready).toHaveLength(2);
    });

    it("should not return tasks with pending dependencies", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));

      const ready = graph.getReadyTasks();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe("a");
    });

    it("should return dependent tasks after dependencies complete", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));

      graph.setStatus("a", "completed");
      const ready = graph.getReadyTasks();
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe("b");
    });

    it("should not return running or completed tasks", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: [] }));

      graph.setStatus("a", "running");
      graph.setStatus("b", "completed");

      expect(graph.getReadyTasks()).toHaveLength(0);
    });
  });

  describe("getSkippableTasks", () => {
    it("should mark tasks as skippable when dependency fails", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));
      graph.addTask(makeTask({ id: "c", dependsOn: ["b"] }));

      graph.setStatus("a", "failed");

      const skippable = graph.getSkippableTasks();
      expect(skippable).toHaveLength(1);
      expect(skippable[0].id).toBe("b");
    });

    it("should cascade skips", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));
      graph.addTask(makeTask({ id: "c", dependsOn: ["b"] }));

      graph.setStatus("a", "failed");
      graph.setStatus("b", "skipped");

      const skippable = graph.getSkippableTasks();
      expect(skippable).toHaveLength(1);
      expect(skippable[0].id).toBe("c");
    });
  });

  describe("isComplete", () => {
    it("should return true when all tasks are done", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.addTask(makeTask({ id: "b" }));

      graph.setStatus("a", "completed");
      graph.setStatus("b", "failed");

      expect(graph.isComplete()).toBe(true);
    });

    it("should return false when tasks are pending", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.addTask(makeTask({ id: "b" }));

      graph.setStatus("a", "completed");
      expect(graph.isComplete()).toBe(false);
    });

    it("should return false when tasks are running", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.setStatus("a", "running");
      expect(graph.isComplete()).toBe(false);
    });
  });

  describe("getStats", () => {
    it("should return accurate statistics", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.addTask(makeTask({ id: "b" }));
      graph.addTask(makeTask({ id: "c" }));
      graph.addTask(makeTask({ id: "d" }));

      graph.setStatus("a", "completed");
      graph.setStatus("b", "failed");
      graph.setStatus("c", "running");

      const stats = graph.getStats();
      expect(stats.total).toBe(4);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });

  describe("setResult", () => {
    it("should set result, filesChanged, and durationMs", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.setResult("a", "Done!", ["src/file.ts"], 1234);

      const task = graph.getTask("a");
      expect(task!.result).toBe("Done!");
      expect(task!.filesChanged).toEqual(["src/file.ts"]);
      expect(task!.durationMs).toBe(1234);
    });

    it("should throw for unknown task", () => {
      const graph = new TaskGraph();
      expect(() => graph.setResult("nope", "x")).toThrow("Unknown subtask");
    });
  });

  describe("setError", () => {
    it("should set error message", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.setError("a", "Something broke");
      expect(graph.getTask("a")!.error).toBe("Something broke");
    });
  });

  describe("validate", () => {
    it("should pass for valid DAG", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));
      graph.addTask(makeTask({ id: "c", dependsOn: ["a", "b"] }));

      const result = graph.validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail for missing dependency reference", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: ["nonexistent"] }));

      const result = graph.validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("nonexistent");
    });
  });

  describe("topologicalSort", () => {
    it("should return tasks in dependency order", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "c", dependsOn: ["a", "b"] }));
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));

      const sorted = graph.topologicalSort();
      expect(sorted).not.toBeNull();
      const ids = sorted!.map((t) => t.id);

      // a must come before b and c
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
      // b must come before c
      expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
    });

    it("should handle independent tasks", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: [] }));
      graph.addTask(makeTask({ id: "c", dependsOn: [] }));

      const sorted = graph.topologicalSort();
      expect(sorted).not.toBeNull();
      expect(sorted!).toHaveLength(3);
    });
  });

  describe("getParallelBatches", () => {
    it("should group independent tasks into batches", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: [] }));
      graph.addTask(makeTask({ id: "c", dependsOn: ["a", "b"] }));
      graph.addTask(makeTask({ id: "d", dependsOn: ["c"] }));

      const batches = graph.getParallelBatches();
      expect(batches).toHaveLength(3);

      // Batch 0: a, b (no deps)
      const batch0Ids = batches[0].map((t) => t.id).sort();
      expect(batch0Ids).toEqual(["a", "b"]);

      // Batch 1: c (depends on a, b)
      expect(batches[1].map((t) => t.id)).toEqual(["c"]);

      // Batch 2: d (depends on c)
      expect(batches[2].map((t) => t.id)).toEqual(["d"]);
    });

    it("should return single batch for independent tasks", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: [] }));
      graph.addTask(makeTask({ id: "c", dependsOn: [] }));

      const batches = graph.getParallelBatches();
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
    });

    it("should handle linear chain as N batches", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));
      graph.addTask(makeTask({ id: "c", dependsOn: ["b"] }));

      const batches = graph.getParallelBatches();
      expect(batches).toHaveLength(3);
      expect(batches[0]).toHaveLength(1);
      expect(batches[1]).toHaveLength(1);
      expect(batches[2]).toHaveLength(1);
    });

    it("should handle diamond dependency", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a", dependsOn: [] }));
      graph.addTask(makeTask({ id: "b", dependsOn: ["a"] }));
      graph.addTask(makeTask({ id: "c", dependsOn: ["a"] }));
      graph.addTask(makeTask({ id: "d", dependsOn: ["b", "c"] }));

      const batches = graph.getParallelBatches();
      expect(batches).toHaveLength(3);

      // a alone
      expect(batches[0]).toHaveLength(1);
      // b, c in parallel
      expect(batches[1]).toHaveLength(2);
      // d alone
      expect(batches[2]).toHaveLength(1);
    });
  });

  describe("getAllTasks", () => {
    it("should return all tasks", () => {
      const graph = new TaskGraph();
      graph.addTask(makeTask({ id: "a" }));
      graph.addTask(makeTask({ id: "b" }));
      expect(graph.getAllTasks()).toHaveLength(2);
    });
  });
});

// ── TaskDecomposer Tests ────────────────────────────────────────

describe("TaskDecomposer", () => {
  const baseTask: AgentTask = {
    id: "task_1",
    title: "Test task",
    description: "A test task",
  };

  describe("heuristic decomposition", () => {
    it("should decompose feature tasks into plan → implement → test → verify", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Implement user authentication",
        description: "Add JWT-based authentication to the API endpoints",
        labels: ["feature"],
      });

      expect(result.strategy).toBe("heuristic");
      expect(result.graph.size()).toBe(4);
      expect(result.reasoning).toContain("Feature");

      const tasks = result.graph.getAllTasks();
      const ids = tasks.map((t) => t.id);
      expect(ids).toContain("plan");
      expect(ids).toContain("implement");
      expect(ids).toContain("test");
      expect(ids).toContain("verify");

      // Check dependency chain
      expect(tasks.find((t) => t.id === "implement")!.dependsOn).toContain("plan");
      expect(tasks.find((t) => t.id === "test")!.dependsOn).toContain("implement");
      expect(tasks.find((t) => t.id === "verify")!.dependsOn).toContain("test");
    });

    it("should decompose refactoring tasks into analyze → refactor → fix_tests", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Refactor database layer",
        description: "Restructure the database module to use connection pooling",
        labels: ["refactor"],
      });

      expect(result.graph.size()).toBe(3);
      expect(result.reasoning).toContain("Refactoring");

      const tasks = result.graph.getAllTasks();
      expect(tasks.map((t) => t.id)).toContain("analyze");
      expect(tasks.map((t) => t.id)).toContain("refactor");
      expect(tasks.map((t) => t.id)).toContain("fix_tests");
    });

    it("should decompose bug fixes into diagnose → fix → verify", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Fix login page crash",
        description: "The login page crashes when email contains special characters",
        labels: ["bug"],
      });

      expect(result.graph.size()).toBe(3);
      expect(result.reasoning).toContain("Bug fix");
    });

    it("should decompose generic long descriptions into plan → execute → verify", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Update all endpoints",
        description: "x".repeat(1200), // long description triggers generic pattern
      });

      expect(result.graph.size()).toBe(3);
      expect(result.reasoning).toContain("Generic");
    });

    it("should decompose simple tasks into implement → verify", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Rename variable",
        description: "Rename foo to bar in utils.ts",
      });

      expect(result.graph.size()).toBe(2);
      expect(result.reasoning).toContain("Simple");
    });

    it("should assign appropriate model roles", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Add new feature",
        description: "Implement a new feature with proper architecture",
        labels: ["feature"],
      });

      const tasks = result.graph.getAllTasks();
      const plan = tasks.find((t) => t.id === "plan");
      const implement = tasks.find((t) => t.id === "implement");
      const verify = tasks.find((t) => t.id === "verify");

      expect(plan!.modelRole).toBe("architect");
      expect(implement!.modelRole).toBe("coder");
      expect(verify!.modelRole).toBe("fast");
    });

    it("should propagate parent task labels to subtasks", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Add feature",
        description: "Implement new feature",
        labels: ["feature", "priority-high"],
      });

      const tasks = result.graph.getAllTasks();
      for (const task of tasks) {
        expect(task.labels).toContain("priority-high");
      }
    });
  });

  describe("graph validation", () => {
    it("should produce valid DAGs", () => {
      const decomposer = new TaskDecomposer();

      const patterns = [
        { title: "Build auth feature", labels: ["feature"] },
        { title: "Refactor database", labels: ["refactor"] },
        { title: "Fix crash bug", labels: ["bug"] },
        { title: "Update something", description: "x".repeat(1200) },
        { title: "Tiny fix", description: "small" },
      ];

      for (const pattern of patterns) {
        const result = decomposer.heuristicDecompose({
          ...baseTask,
          ...pattern,
          description: pattern.description ?? `Doing: ${pattern.title}`,
        });

        const validation = result.graph.validate();
        expect(validation.valid).toBe(true);
      }
    });

    it("should produce topologically sortable graphs", () => {
      const decomposer = new TaskDecomposer();

      const result = decomposer.heuristicDecompose({
        ...baseTask,
        title: "Add feature",
        description: "Implement new feature",
        labels: ["feature"],
      });

      const sorted = result.graph.topologicalSort();
      expect(sorted).not.toBeNull();
      expect(sorted!.length).toBe(result.graph.size());
    });
  });

  describe("decompose (async with fallback)", () => {
    it("should fall back to heuristic when no provider", async () => {
      const decomposer = new TaskDecomposer();

      const result = await decomposer.decompose({
        ...baseTask,
        title: "Build authentication",
        description: "Add auth to the app",
        labels: ["feature"],
      });

      expect(result.strategy).toBe("heuristic");
      expect(result.graph.size()).toBeGreaterThanOrEqual(2);
    });
  });
});

// ── MultiAgentExecutor Tests ────────────────────────────────────

describe("MultiAgentExecutor (graph operations only)", () => {
  it("should identify parallel batches for execution planning", () => {
    const graph = new TaskGraph();

    // Diamond pattern: A → B, A → C, B+C → D
    graph.addTask({
      id: "a", title: "Step A", description: "First step",
      dependsOn: [], status: "pending",
    });
    graph.addTask({
      id: "b", title: "Step B", description: "Parallel B",
      dependsOn: ["a"], status: "pending",
    });
    graph.addTask({
      id: "c", title: "Step C", description: "Parallel C",
      dependsOn: ["a"], status: "pending",
    });
    graph.addTask({
      id: "d", title: "Step D", description: "Final step",
      dependsOn: ["b", "c"], status: "pending",
    });

    const batches = graph.getParallelBatches();

    // 3 batches: [a], [b,c], [d]
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(2);
    expect(batches[2]).toHaveLength(1);
  });

  it("should track skip cascade correctly", () => {
    const graph = new TaskGraph();

    graph.addTask({
      id: "a", title: "A", description: "x",
      dependsOn: [], status: "pending",
    });
    graph.addTask({
      id: "b", title: "B", description: "x",
      dependsOn: ["a"], status: "pending",
    });
    graph.addTask({
      id: "c", title: "C", description: "x",
      dependsOn: ["b"], status: "pending",
    });
    graph.addTask({
      id: "d", title: "D", description: "x",
      dependsOn: [], status: "pending",
    });

    // Simulate a failing and then cascade
    graph.setStatus("a", "failed");

    // b should be skippable
    const skippable1 = graph.getSkippableTasks();
    expect(skippable1.map((t) => t.id)).toEqual(["b"]);

    graph.setStatus("b", "skipped");

    // c should now be skippable
    const skippable2 = graph.getSkippableTasks();
    expect(skippable2.map((t) => t.id)).toEqual(["c"]);

    // d should still be ready (independent)
    const ready = graph.getReadyTasks();
    expect(ready.map((t) => t.id)).toEqual(["d"]);
  });

  it("should report correct stats throughout execution", () => {
    const graph = new TaskGraph();
    graph.addTask({ id: "a", title: "A", description: "x", dependsOn: [], status: "pending" });
    graph.addTask({ id: "b", title: "B", description: "x", dependsOn: [], status: "pending" });
    graph.addTask({ id: "c", title: "C", description: "x", dependsOn: [], status: "pending" });

    expect(graph.getStats()).toEqual({
      total: 3, completed: 0, failed: 0, skipped: 0, pending: 3, running: 0,
    });

    graph.setStatus("a", "running");
    expect(graph.getStats().running).toBe(1);
    expect(graph.getStats().pending).toBe(2);

    graph.setStatus("a", "completed");
    graph.setStatus("b", "failed");
    graph.setStatus("c", "skipped");

    expect(graph.getStats()).toEqual({
      total: 3, completed: 1, failed: 1, skipped: 1, pending: 0, running: 0,
    });

    expect(graph.isComplete()).toBe(true);
  });
});
